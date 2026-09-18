import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Certificate from '@/models/Certificate';
import CertificateEvent from '@/models/CertificateEvent';
import Application from '@/models/Application';
import Inspection from '@/models/Inspection';
import Instrument from '@/models/Instrument';
import {
  handle,
  ok,
  requireAuth,
  scopeFilter,
  NotFound,
  isOfficial,
} from '@/lib/rbac';
import {
  checkIntegrity,
  effectiveStatus,
  certificateQrDataUrl,
  verifyUrl,
} from '@/lib/certificates';
import { auditAction } from '@/lib/audit';
import { EXPIRING_SOON_WINDOW_DAYS } from '@/lib/constants';

/**
 * One certificate, for the holder or for an official in whose jurisdiction it
 * was issued. This is what the download / print view reads.
 *
 * There was no detail endpoint before: the certificates page rendered whatever
 * the list returned, which is why the UI fell back to inventing an issuer
 * (`LMO-SEAL-VERIFIED`) and a QR from a third-party image host.
 */

export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const user = await requireAuth();

  const scope = scopeFilter(user, {
    ownerField: 'ownerId',
    stateField: 'instrumentSnapshot.installationState',
    districtField: 'instrumentSnapshot.installationDistrict',
    assigneeField: 'issuedBy',
  });

  // Accept either the ObjectId or the certificate number, since the number is
  // what a person has in front of them.
  const byId = Types.ObjectId.isValid(id) ? { _id: new Types.ObjectId(id) } : { certNo: id.toUpperCase() };

  const cert = await Certificate.findOne({ ...scope, ...byId });
  // 404 rather than 403 for an out-of-scope certificate, so ids stay
  // non-enumerable.
  if (!cert) throw NotFound('No such certificate');

  const [events, application, inspection, instrument, qrDataUrl] = await Promise.all([
    CertificateEvent.find({ certificateId: cert._id })
      .select(isOfficial(user.role) ? '' : '-internalNote')
      .sort({ occurredAt: 1 })
      .populate('actorId', 'name role designation')
      .lean(),
    Application.findById(cert.applicationId).select('applicationNo type submittedDate completedDate feeAmount feeStatus').lean(),
    cert.inspectionId
      ? Inspection.findById(cert.inspectionId)
          // Field names here have to match the Inspection schema exactly. They
          // did not: `sealNo` and `sealPhotoIds` are `sealDetails.sealNo` and
          // `evidenceIds`, so the seal never reached the client, and
          // `inspectorId` does not exist at all — the path is `inspectedBy`.
          // Because Mongoose defaults to `strictPopulate: true`, populating a
          // path that is not in the schema throws, so this whole endpoint
          // returned a 500 for every certificate issued from an inspection.
          .select(
            'inspectionNo inspectedAt result readings conformityChecks referenceStandards ' +
              'sealDetails evidenceIds gpsDriftMetres remarks version inspectedBy inspectedByRole'
          )
          .populate('inspectedBy', 'name designation officerCode')
          .lean()
      : null,
    Instrument.findById(cert.instrumentId).select('type brand model serialNo status currentCertificateId').lean(),
    certificateQrDataUrl(cert.certNo),
  ]);

  const integrity = checkIntegrity(cert);
  const derived = effectiveStatus(cert, EXPIRING_SOON_WINDOW_DAYS);

  // The stored status is refreshed lazily on read when the expiry date has moved
  // past it, so a certificate does not sit at ACTIVE until the next nightly
  // sweep. Suspended/revoked are decisions and are never overwritten here.
  if (derived !== cert.status && cert.status !== 'SUSPENDED' && cert.status !== 'REVOKED' && cert.status !== 'SUPERSEDED') {
    await Certificate.updateOne({ _id: cert._id }, { status: derived });
    cert.status = derived;
  }

  if (req.nextUrl.searchParams.get('download') === 'true') {
    await Promise.all([
      Certificate.updateOne({ _id: cert._id }, { $inc: { downloadCount: 1 } }),
      auditAction(
        { id: user.id, role: user.role, email: user.email },
        'certificate.download',
        { type: 'Certificate', id: cert._id, label: cert.certNo },
        { headers: req.headers }
      ),
    ]);
  }

  return ok({
    certificate: {
      ...cert.toObject(),
      // The signature and hash are returned so the holder can independently
      // check them, but only to someone already entitled to see the record.
      effectiveStatus: derived,
      daysToExpiry: Math.ceil((new Date(cert.expiryDate).getTime() - Date.now()) / 86_400_000),
      verifyUrl: verifyUrl(cert.certNo),
    },
    integrity,
    qrDataUrl,
    events,
    application,
    inspection,
    instrument,
    isCurrentForInstrument: String(instrument?.currentCertificateId ?? '') === String(cert._id),
  });
});
