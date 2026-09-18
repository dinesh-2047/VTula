import { NextRequest } from 'next/server';
import Razorpay from 'razorpay';
import { Types } from 'mongoose';
import Application from '@/models/Application';
import { handle, ok, requireAuth, BadRequest, NotFound, HttpError } from '@/lib/rbac';
import { verifyRazorpaySignature } from '@/lib/utils';
import { auditAction } from '@/lib/audit';
import { notify } from '@/lib/notify';

/**
 * Confirms a Razorpay payment and records it against the application.
 *
 * **This route is the only writer of `feeStatus` / `feePaid` / `paymentId`.**
 * Nothing else in the codebase may set them, because everything downstream trusts
 * them: `issueCertificate()` refuses to sign a certificate unless the fee is
 * `Paid` or `Waived` (`src/lib/certificates.ts:91`).
 *
 * What was wrong before: the old handler verified the HMAC correctly and then
 * returned `{ success: true }` **without touching the database**. The signature
 * was checked and then thrown away — no application was ever marked paid, so
 * either issuance was blocked forever or (in the old code) the client set
 * `feeStatus` itself on the applications route.
 *
 * The application is found *by the order id we issued*, never by a
 * client-supplied application id. That is what binds a payment to the thing it
 * paid for.
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

  const body = (await req.json()) as {
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  };

  const orderId = body.razorpay_order_id?.trim();
  const paymentId = body.razorpay_payment_id?.trim();
  const signature = body.razorpay_signature?.trim();

  if (!orderId || !paymentId || !signature) {
    throw BadRequest(
      'The order id, payment id and signature from the checkout are all required',
      'MISSING_PAYMENT_DETAILS'
    );
  }

  // Scoped to the caller's own applications: a leaked order id from someone
  // else's checkout resolves to nothing.
  const application = await Application.findOne({ orderId, ownerId: user.id });
  if (!application) {
    throw NotFound('No application in your account is waiting on that payment');
  }

  const valid = verifyRazorpaySignature(orderId, paymentId, signature);

  if (!valid) {
    // A bad signature is worth keeping: it is either a broken integration or
    // somebody trying to mark a fee paid without paying it.
    application.feeStatus = 'Failed';
    await application.save();

    await auditAction(
      { id: user.id, role: user.role, email: user.email },
      'payment.verify',
      { type: 'Application', id: application._id, label: application.applicationNo },
      {
        outcome: 'DENIED',
        details: `Signature mismatch for order ${orderId}, payment ${paymentId}`,
        headers: req.headers,
      }
    );

    throw BadRequest(
      'That payment could not be verified. Nothing has been charged to your application — if your bank shows a debit, contact the Legal Metrology office with the payment id.',
      'INVALID_SIGNATURE'
    );
  }

  // Idempotency: the checkout callback can fire twice (a retry, a double click, a
  // reopened tab). The second call must not double-credit the fee.
  if (application.feeStatus === 'Paid' && application.paymentId === paymentId) {
    return ok({
      verified: true,
      alreadyRecorded: true,
      application: {
        id: String(application._id),
        applicationNo: application.applicationNo,
        feeStatus: application.feeStatus,
        feePaid: application.feePaid,
      },
    });
  }

  /*
   * The signature already proves Razorpay authorised this order/payment pair, and
   * the amount was fixed by us at order creation. Fetching the payment is a
   * second, independent check that the amount actually captured matches — it
   * catches a partial capture, and a currency or order mismatch. A gateway that
   * cannot be reached does not block the credit, because the signature is
   * cryptographic proof on its own.
   */
  let capturedRupees: number | null = null;
  const razorpay = getRazorpay();
  if (razorpay) {
    try {
      const payment = await razorpay.payments.fetch(paymentId);
      if (payment.order_id && payment.order_id !== orderId) {
        throw BadRequest(
          'That payment belongs to a different order',
          'ORDER_MISMATCH'
        );
      }
      if (payment.status === 'failed') {
        application.feeStatus = 'Failed';
        await application.save();
        throw BadRequest(
          'The gateway reports this payment as failed. Try again.',
          'PAYMENT_FAILED'
        );
      }
      capturedRupees = Number(payment.amount) / 100;
    } catch (error: unknown) {
      // A refusal raised inside the try block is a real decision — let it through.
      if (error instanceof HttpError) throw error;
      console.error('[payments] could not fetch payment for cross-check:', error);
    }
  }

  const expected = (application.feeAmount ?? 0) - (application.feePaid ?? 0);
  const credited = capturedRupees ?? expected;

  if (capturedRupees !== null && capturedRupees + 0.01 < expected) {
    // Short payment: record what arrived and leave the balance outstanding rather
    // than certifying a partly-paid application.
    application.feePaid = (application.feePaid ?? 0) + capturedRupees;
    application.feeStatus = 'Pending';
    application.paymentId = paymentId;
    application.paymentSignature = signature;
    await application.save();

    await auditAction(
      { id: user.id, role: user.role, email: user.email },
      'payment.verify',
      { type: 'Application', id: application._id, label: application.applicationNo },
      {
        outcome: 'SUCCESS',
        details: `Part payment of ₹${capturedRupees} against ₹${expected} due`,
        headers: req.headers,
      }
    );

    return ok({
      verified: true,
      application: {
        id: String(application._id),
        applicationNo: application.applicationNo,
        feeStatus: application.feeStatus,
        feePaid: application.feePaid,
        outstanding: (application.feeAmount ?? 0) - application.feePaid,
      },
      message: `₹${capturedRupees} received. ₹${
        (application.feeAmount ?? 0) - application.feePaid
      } is still outstanding.`,
    });
  }

  application.feePaid = (application.feePaid ?? 0) + credited;
  application.feeStatus = 'Paid';
  application.paymentId = paymentId;
  application.paymentSignature = signature;
  application.paymentVerifiedAt = new Date();
  await application.save();

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    'payment.verify',
    { type: 'Application', id: application._id, label: application.applicationNo },
    {
      outcome: 'SUCCESS',
      details: `₹${credited} received for order ${orderId} (payment ${paymentId})`,
      changes: { feeStatus: { from: 'Pending', to: 'Paid' }, feePaid: application.feePaid },
      headers: req.headers,
    }
  );

  // The receipt is the owner's proof of payment, so it goes to their inbox and is
  // deduped on the payment id.
  await notify({
    userId: application.ownerId,
    title: `Fee received for ${application.applicationNo}`,
    message: `₹${credited} has been received. Your application is now with the Legal Metrology department for verification — you will be notified when an inspection is scheduled.`,
    type: 'success',
    relatedModel: 'Application',
    relatedId: application._id,
    actionUrl: `/dashboard/applications/${application._id}`,
    actionLabel: 'View application',
    dedupeKey: `payment:${paymentId}`,
  }).catch((err) => console.error('[payments] receipt notification failed', err));

  // A paid fee is what buys the verification that ends up on the instrument's
  // passport, so the receipt is reachable from the application either way.
  return ok({
    verified: true,
    receipt: {
      paymentId,
      orderId,
      amount: credited,
      paidAt: application.paymentVerifiedAt,
      applicationNo: application.applicationNo,
    },
    application: {
      id: String(application._id),
      applicationNo: application.applicationNo,
      feeStatus: application.feeStatus,
      feePaid: application.feePaid,
      status: application.status,
    },
  });
});

/** Payment status for an application, so a reopened checkout can resume. */
export const GET = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const applicationId = new URL(req.url).searchParams.get('applicationId');

  if (!applicationId || !Types.ObjectId.isValid(applicationId)) {
    throw BadRequest('An application must be identified', 'APPLICATION_REQUIRED');
  }

  const application = await Application.findOne({ _id: applicationId, ownerId: user.id }).select(
    'applicationNo feeAmount feePaid feeStatus orderId paymentId paymentVerifiedAt'
  );

  if (!application) throw NotFound('No such application in your account');

  return ok({
    applicationNo: application.applicationNo,
    feeAmount: application.feeAmount,
    feePaid: application.feePaid,
    feeStatus: application.feeStatus,
    outstanding: Math.max(0, (application.feeAmount ?? 0) - (application.feePaid ?? 0)),
    openOrderId: application.feeStatus === 'Paid' ? undefined : application.orderId,
    paymentId: application.paymentId,
    paidAt: application.paymentVerifiedAt,
  });
});
