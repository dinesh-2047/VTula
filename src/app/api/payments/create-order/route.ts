import { NextRequest } from 'next/server';
import Razorpay from 'razorpay';
import { Types } from 'mongoose';
import Application from '@/models/Application';
import { handle, ok, requireAuth, BadRequest, NotFound, HttpError } from '@/lib/rbac';
import { auditAction } from '@/lib/audit';

/**
 * Creates a Razorpay order for an application's verification fee.
 *
 * Two things were wrong before:
 *
 *  1. **The amount came from the request body.** A caller could POST
 *     `{ amount: 1 }` and receive a valid order for ₹1, then pay it and have
 *     `/api/payments/verify` accept the signature — the fee was whatever the
 *     client said it was. The amount now comes from `application.feeAmount`,
 *     which is itself computed server-side from the applicable rule.
 *  2. **The Razorpay client was constructed at module load** with
 *     `key_secret: process.env.RAZORPAY_KEY_SECRET || ''`. On a deployment
 *     without payment configuration that produced a client with an empty secret,
 *     so the first request failed deep inside the SDK with an opaque error. It is
 *     now created lazily, and a missing configuration is reported plainly.
 */

let cached: Razorpay | null | undefined;

function getRazorpay(): Razorpay | null {
  if (cached !== undefined) return cached;
  const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  cached = keyId && keySecret ? new Razorpay({ key_id: keyId, key_secret: keySecret }) : null;
  return cached;
}

export const POST = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const body = (await req.json()) as { applicationId?: string };

  const { applicationId } = body;
  if (!applicationId || !Types.ObjectId.isValid(applicationId)) {
    throw BadRequest('An application must be identified to pay for', 'APPLICATION_REQUIRED');
  }

  // Scoped by owner in the query itself: nobody can open an order against
  // somebody else's application.
  const application = await Application.findOne({ _id: applicationId, ownerId: user.id })
    .populate('instrumentId', 'type brand model serialNo')
    .select('applicationNo type feeAmount feePaid feeStatus status orderId instrumentId');

  if (!application) throw NotFound('No such application in your account');

  if (application.feeStatus === 'Paid') {
    throw BadRequest('The fee for this application has already been paid', 'ALREADY_PAID');
  }
  if (application.feeStatus === 'Waived') {
    throw BadRequest('No fee is payable on this application', 'FEE_WAIVED');
  }

  const outstanding = (application.feeAmount ?? 0) - (application.feePaid ?? 0);
  if (outstanding <= 0) {
    throw BadRequest('There is nothing outstanding on this application', 'NOTHING_DUE');
  }

  const razorpay = getRazorpay();
  if (!razorpay) {
    throw new HttpError(
      503,
      'Online payment is not configured on this server. Pay at the Legal Metrology office and ask the officer to record the receipt.',
      'PAYMENTS_NOT_CONFIGURED'
    );
  }

  let order;
  try {
    order = await razorpay.orders.create({
      // Razorpay works in paise.
      amount: Math.round(outstanding * 100),
      currency: 'INR',
      // The receipt ties the gateway's record to ours. Razorpay caps it at 40
      // characters.
      receipt: `${application.applicationNo}`.slice(0, 40),
      notes: {
        applicationId: String(application._id),
        applicationNo: application.applicationNo,
        verificationType: application.type,
        // No personal data in gateway metadata.
        ownerId: user.id,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown gateway error';
    console.error('[payments] Razorpay order creation failed:', msg);
    throw new HttpError(
      502,
      'The payment gateway did not accept the request. Try again in a moment.',
      'GATEWAY_ERROR'
    );
  }

  // Recorded so /api/payments/verify can confirm the order it is asked to verify
  // is the one we opened for this application, and so the amount it credits is the
  // amount we asked the gateway for.
  application.orderId = order.id;
  application.feeStatus = 'Pending';
  await application.save();

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    'payment.order.create',
    { type: 'Application', id: application._id, label: application.applicationNo },
    { details: `Order ${order.id} for ₹${outstanding}`, headers: req.headers }
  );

  return ok({
    order: {
      id: order.id,
      amount: order.amount,
      currency: order.currency,
    },
    // The checkout widget needs the public key; the secret never leaves the server.
    keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    application: {
      id: String(application._id),
      applicationNo: application.applicationNo,
      feeAmount: application.feeAmount,
      outstanding,
    },
  });
});
