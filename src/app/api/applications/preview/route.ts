import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Instrument from '@/models/Instrument';
import Application from '@/models/Application';
import Certificate from '@/models/Certificate';
import { handle, ok, requireAuth, BadRequest, NotFound } from '@/lib/rbac';
import { resolveRule, computeFee, computeDueDate } from '@/lib/rules';
import {
  VERIFICATION_TYPES,
  VERIFICATION_TYPE_LABELS,
  OPEN_APPLICATION_STATUSES,
  type VerificationType,
} from '@/lib/constants';

/**
 * What an application *would* cost and require, before one is created.
 *
 * This exists because the fee must be quoted by the same code that charges it.
 * The application form used to import a `calculateFee()` helper and compute the
 * amount in the browser, then send it to the payment route — so the price on the
 * screen was whatever the client believed, and the amount charged was whatever the
 * client asked for. Now the form asks the server what the fee is, and the server
 * is also the only thing that sets it.
 *
 * It also reports the *effective* verification type. An owner selecting "initial"
 * for an instrument that already holds certificates is really filing a
 * re-verification, and the fee differs — better to say so on the form than to
 * surprise them at the receipt.
 */

export const GET = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const params = new URL(req.url).searchParams;

  const instrumentId = params.get('instrumentId');
  const requestedType = params.get('type') ?? 'initial';

  if (!instrumentId || !Types.ObjectId.isValid(instrumentId)) {
    throw BadRequest('An instrument must be selected', 'INSTRUMENT_REQUIRED');
  }
  if (!(VERIFICATION_TYPES as readonly string[]).includes(requestedType)) {
    throw BadRequest(
      `Verification type must be one of: ${VERIFICATION_TYPES.join(', ')}`,
      'INVALID_TYPE'
    );
  }

  // Owner-scoped: a quote is only meaningful for your own instrument, and this
  // must not become a way to enumerate other businesses' equipment.
  const instrument = await Instrument.findOne({ _id: instrumentId, ownerId: user.id }).select(
    'type brand model serialNo installationState installationDistrict address isDecommissioned status nextVerificationDue'
  );

  if (!instrument) throw NotFound('No such instrument in your account');

  const [priorCertificates, openApplication] = await Promise.all([
    Certificate.countDocuments({ instrumentId: instrument._id }),
    Application.findOne({
      instrumentId: instrument._id,
      status: {
        $in: [...OPEN_APPLICATION_STATUSES],
      },
    })
      .select('applicationNo status')
      .lean(),
  ]);

  // Mirrors the rule applied by POST /api/applications, so the quote and the
  // charge cannot drift apart.
  const effectiveType: VerificationType =
    requestedType === 'initial' && priorCertificates > 0
      ? 'reverification'
      : (requestedType as VerificationType);

  const rule = await resolveRule(instrument.installationState, instrument.type);
  const fee = computeFee(rule, effectiveType);

  return ok({
    instrument: {
      id: String(instrument._id),
      label: `${instrument.brand} ${instrument.model} (${instrument.serialNo})`,
      type: instrument.type,
      isDecommissioned: instrument.isDecommissioned,
      defaultInspectionLocation: `${instrument.address}, ${instrument.installationDistrict}, ${instrument.installationState}`,
    },
    verificationType: {
      requested: requestedType,
      effective: effectiveType,
      label: VERIFICATION_TYPE_LABELS[effectiveType],
      // Set when the server will file something other than what was asked for.
      reclassified:
        effectiveType !== requestedType
          ? `This instrument already holds ${priorCertificates} certificate${priorCertificates === 1 ? '' : 's'}, so this will be filed as a re-verification.`
          : undefined,
    },
    fee: {
      amount: fee,
      base: rule.fee.base,
      currency: 'INR',
      payable: fee > 0,
      note: fee === 0 ? 'No fee is payable for this category.' : undefined,
    },
    rule: {
      name: rule.name,
      matchedScope: rule.matchedScope,
      validityMonths: rule.validityMonths,
      requiredDocuments: rule.requiredDocuments,
      minEvidencePhotos: rule.minEvidencePhotos,
      legalReference: rule.legalReference,
    },
    expectedDueDate: computeDueDate(rule),
    // The form disables submission rather than letting the owner discover the
    // conflict after paying.
    blockers: [
      instrument.isDecommissioned
        ? { code: 'INSTRUMENT_DECOMMISSIONED', message: 'This instrument is decommissioned and cannot be submitted for verification.' }
        : null,
      openApplication
        ? {
            code: 'APPLICATION_ALREADY_OPEN',
            message: `Application ${openApplication.applicationNo} is already open for this instrument (${openApplication.status}).`,
          }
        : null,
    ].filter(Boolean),
  });
});
