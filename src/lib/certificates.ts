import { Types, type HydratedDocument } from 'mongoose';
import QRCode from 'qrcode';
import Certificate, { type ICertificate } from '@/models/Certificate';
import CertificateEvent from '@/models/CertificateEvent';
import InstrumentEvent from '@/models/InstrumentEvent';
import Instrument from '@/models/Instrument';
import Application, { type IApplication } from '@/models/Application';
import Inspection, { type IInspection } from '@/models/Inspection';
import User, { type IUser } from '@/models/User';
import { generateCertNo } from '@/lib/ids';
import { resolveRule, computeExpiryDate } from '@/lib/rules';
import {
  buildCertificatePayload,
  sha256Hex,
  signCertificateData,
  verifyCertificateSignature,
  SIGNING_KEY_ID,
} from '@/lib/utils';
import { BadRequest, Conflict, type AuthedUser } from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { notifications } from '@/lib/notify';
import {
  CERTIFICATE_VALID_STATUSES,
  type CertificateStatus,
} from '@/lib/constants';

/**
 * Certificate issuance, verification and lifecycle.
 *
 * Previously all of this lived inline in `POST /api/tasks`, which:
 *  - performed **no role check at all**, so any authenticated user (an Owner
 *    included) could mint a real signed certificate for any application;
 *  - hardcoded a one-year validity instead of consulting the applicable rule;
 *  - stored the signing *plaintext* in a field named `dataHash`, so the
 *    "tamper-proof hash" shown in the UI was not a hash;
 *  - wrote no audit entry, emitted no notification, and created no history.
 */

export function verifyUrl(certNo: string): string {
  const base = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/verify/${encodeURIComponent(certNo)}`;
}

/** Renders the verification QR as a data URL, locally. */
export async function certificateQrDataUrl(certNo: string): Promise<string> {
  return QRCode.toDataURL(verifyUrl(certNo), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    color: { dark: '#3D405B', light: '#FFFFFF' },
  });
}

export interface IssueCertificateInput {
  /** A live mongoose document — the application is updated as part of issuance. */
  application: HydratedDocument<IApplication>;
  inspection: IInspection & { _id: Types.ObjectId };
  issuer: AuthedUser;
  headers?: Headers;
}

/**
 * Issues a certificate for an approved application.
 *
 * Preconditions enforced here rather than trusted from the caller:
 *  - the application must be APPROVED,
 *  - the inspection must be submitted and must have PASSED,
 *  - the fee must actually be paid,
 *  - no live certificate may already exist for this application.
 */
export async function issueCertificate(
  input: IssueCertificateInput
): Promise<ICertificate & { _id: Types.ObjectId }> {
  const { application: app, inspection, issuer } = input;

  if (app.status !== 'APPROVED') {
    throw BadRequest(
      `A certificate can only be issued for an approved application (current status: ${app.status})`,
      'APPLICATION_NOT_APPROVED'
    );
  }
  if (!inspection.isSubmitted) {
    throw BadRequest('The inspection has not been submitted yet', 'INSPECTION_NOT_SUBMITTED');
  }
  if (inspection.result !== 'PASS') {
    throw BadRequest(
      'A certificate cannot be issued for an inspection that did not pass',
      'INSPECTION_NOT_PASSED'
    );
  }
  if (app.feeStatus !== 'Paid' && app.feeStatus !== 'Waived') {
    throw BadRequest(
      'The statutory fee for this application has not been paid',
      'FEE_UNPAID'
    );
  }
  if (app.certificateId) {
    throw Conflict('A certificate has already been issued for this application', 'ALREADY_ISSUED');
  }

  const [instrument, owner, issuerUser] = await Promise.all([
    Instrument.findById(app.instrumentId),
    User.findById(app.ownerId).lean<IUser>(),
    User.findById(issuer.id).lean<IUser>(),
  ]);

  if (!instrument) throw BadRequest('The instrument for this application no longer exists');
  if (!owner) throw BadRequest('The owner for this application no longer exists');

  const rule = await resolveRule(instrument.installationState, instrument.type);

  const issuedDate = new Date();
  const expiryDate = computeExpiryDate(rule, issuedDate);

  // Renewal chain: the instrument's current live certificate is superseded.
  const previous = instrument.currentCertificateId
    ? await Certificate.findById(instrument.currentCertificateId)
    : null;
  const version = previous ? previous.version + 1 : 1;

  const certNo = await generateCertNo(issuedDate);

  const payload = buildCertificatePayload({
    certNo,
    instrumentId: String(instrument._id),
    ownerId: String(owner._id),
    serialNo: instrument.serialNo,
    issuedDate,
    expiryDate,
    issuedBy: issuer.id,
    version,
  });

  const worstError = inspection.readings?.length
    ? Math.max(...inspection.readings.map((r) => Math.abs(r.errorPercent)))
    : undefined;

  const certificate = await Certificate.create({
    certNo,
    applicationId: app._id,
    instrumentId: instrument._id,
    inspectionId: inspection._id,
    ownerId: owner._id,
    organizationId: app.organizationId ?? owner.organizationId,

    issuedDate,
    expiryDate,

    issuedBy: new Types.ObjectId(issuer.id),
    issuedByRole: issuer.role,
    issuerSnapshot: {
      name: issuerUser?.name ?? issuer.name,
      designation: issuerUser?.designation,
      officerCode: issuerUser?.officerCode,
      state: issuerUser?.state,
      district: issuerUser?.district,
      organizationName: issuerUser?.organizationName,
    },

    instrumentSnapshot: {
      type: instrument.type,
      brand: instrument.brand,
      model: instrument.model,
      serialNo: instrument.serialNo,
      capacity: instrument.capacity,
      accuracyClass: instrument.accuracyClass,
      installationState: instrument.installationState,
      installationDistrict: instrument.installationDistrict,
      address: instrument.address,
    },

    ownerSnapshot: {
      name: owner.name,
      email: owner.email,
      phone: owner.phone,
      organizationName: owner.organizationName,
    },

    inspectionSummary: {
      inspectedAt: inspection.inspectedAt,
      result: inspection.result,
      readingCount: inspection.readings?.length ?? 0,
      maxErrorPercent: worstError,
      sealNo: inspection.sealDetails?.sealNo,
    },

    appliedRuleSnapshot: {
      // Which rule version issued this. Rules are amended by
      // supersede-and-replace, so the id alone would not identify the terms.
      ruleId: rule.ruleId ? new Types.ObjectId(rule.ruleId) : undefined,
      ruleVersion: rule.ruleVersion,
      validityMonths: rule.validityMonths,
      legalReference: rule.legalReference,
    },

    dataHash: sha256Hex(payload),
    digitalSignature: signCertificateData(payload),
    signatureKeyId: SIGNING_KEY_ID,

    qrCodeData: verifyUrl(certNo),

    status: 'ACTIVE',
    version,
    supersedesId: previous?._id,
  });

  // Supersede the previous certificate, if any.
  if (previous && CERTIFICATE_VALID_STATUSES.includes(previous.status)) {
    previous.status = 'SUPERSEDED';
    previous.supersededById = certificate._id;
    await previous.save();

    await CertificateEvent.create({
      certificateId: previous._id,
      certNo: previous.certNo,
      instrumentId: previous.instrumentId,
      eventType: 'SUPERSEDED',
      summary: `Superseded by certificate ${certNo} following re-verification.`,
      fromStatus: 'ACTIVE',
      toStatus: 'SUPERSEDED',
      actorId: new Types.ObjectId(issuer.id),
      actorRole: issuer.role,
      isPublic: true,
    });
  }

  // Update the instrument's live state.
  instrument.currentCertificateId = certificate._id;
  instrument.status = 'VERIFIED';
  instrument.lastVerifiedDate = issuedDate;
  instrument.nextVerificationDue = expiryDate;
  instrument.verificationCount = (instrument.verificationCount ?? 0) + 1;
  await instrument.save();

  // Link the certificate back onto the application and close it out.
  app.certificateId = certificate._id;
  app.nextVerificationDue = expiryDate;
  await app.save();

  await Promise.all([
    CertificateEvent.create({
      certificateId: certificate._id,
      certNo,
      instrumentId: instrument._id,
      eventType: version > 1 ? 'RENEWED' : 'ISSUED',
      summary:
        version > 1
          ? `Certificate renewed following re-verification. Valid until ${expiryDate.toLocaleDateString('en-IN')}.`
          : `Certificate issued following successful verification. Valid until ${expiryDate.toLocaleDateString('en-IN')}.`,
      toStatus: 'ACTIVE',
      actorId: new Types.ObjectId(issuer.id),
      actorRole: issuer.role,
      isPublic: true,
    }),

    InstrumentEvent.create({
      instrumentId: instrument._id,
      eventType: 'CERTIFICATE_ISSUED',
      title: `Certificate ${certNo} issued`,
      description: `Valid until ${expiryDate.toLocaleDateString('en-IN')} (${rule.validityMonths} months, per ${rule.matchedScope}).`,
      applicationId: app._id,
      certificateId: certificate._id,
      inspectionId: inspection._id,
      actorId: new Types.ObjectId(issuer.id),
      actorRole: issuer.role,
    }),

    auditAction(
      { id: issuer.id, role: issuer.role, email: issuer.email },
      'certificate.issue',
      { type: 'Certificate', id: certificate._id, label: certNo },
      {
        details: `Issued for application ${app.applicationNo}, valid ${rule.validityMonths} months (rule: ${rule.matchedScope})`,
        changes: {
          applicationNo: app.applicationNo,
          instrumentSerial: instrument.serialNo,
          validityMonths: rule.validityMonths,
          expiryDate: expiryDate.toISOString(),
        },
        headers: input.headers,
      }
    ),

    notifications.certificateIssued(String(owner._id), certNo, String(certificate._id), expiryDate),
  ]);

  return certificate as ICertificate & { _id: Types.ObjectId };
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

export interface IntegrityResult {
  signatureValid: boolean;
  hashValid: boolean;
  /** Human-readable explanation for the trust page. */
  detail: string;
}

/** Recomputes the hash and signature over a stored certificate. */
export function checkIntegrity(cert: ICertificate): IntegrityResult {
  const payload = buildCertificatePayload({
    certNo: cert.certNo,
    instrumentId: String(cert.instrumentId),
    ownerId: String(cert.ownerId),
    serialNo: cert.instrumentSnapshot?.serialNo ?? '',
    issuedDate: cert.issuedDate,
    expiryDate: cert.expiryDate,
    issuedBy: String(cert.issuedBy),
    version: cert.version ?? 1,
  });

  const hashValid = cert.dataHash === sha256Hex(payload);
  const signatureValid = verifyCertificateSignature(payload, cert.digitalSignature);

  let detail: string;
  if (hashValid && signatureValid) {
    detail = 'The certificate contents match their cryptographic hash and issuer signature.';
  } else if (!signatureValid && hashValid) {
    detail =
      'The signature could not be verified. This can happen if the signing key was rotated; contact the issuing office.';
  } else {
    detail =
      'The stored certificate data does not match its recorded hash. Treat this certificate as unverified and report it.';
  }

  return { signatureValid, hashValid, detail };
}

/** The effective status right now, taking the expiry date into account. */
export function effectiveStatus(cert: ICertificate, expiringSoonWindowDays = 60): CertificateStatus {
  if (cert.status === 'REVOKED' || cert.status === 'SUSPENDED' || cert.status === 'SUPERSEDED') {
    return cert.status;
  }

  const msLeft = new Date(cert.expiryDate).getTime() - Date.now();
  if (msLeft <= 0) return 'EXPIRED';
  if (msLeft <= expiringSoonWindowDays * 86_400_000) return 'EXPIRING_SOON';
  return 'ACTIVE';
}

/* ------------------------------------------------------------------ *
 * Lifecycle transitions
 * ------------------------------------------------------------------ */

export async function suspendCertificate(
  cert: ICertificate & { _id: Types.ObjectId; save: () => Promise<unknown> },
  actor: AuthedUser,
  reason: string,
  until?: Date,
  headers?: Headers
): Promise<void> {
  if (!CERTIFICATE_VALID_STATUSES.includes(cert.status)) {
    throw BadRequest(`Only a live certificate can be suspended (current status: ${cert.status})`);
  }

  const from = cert.status;
  cert.status = 'SUSPENDED';
  cert.suspension = { reason, by: new Types.ObjectId(actor.id), at: new Date(), until };
  await cert.save();

  await Promise.all([
    CertificateEvent.create({
      certificateId: cert._id,
      certNo: cert.certNo,
      instrumentId: cert.instrumentId,
      eventType: 'SUSPENDED',
      summary: `Certificate suspended by the issuing authority. Reason: ${reason}`,
      fromStatus: from,
      toStatus: 'SUSPENDED',
      actorId: new Types.ObjectId(actor.id),
      actorRole: actor.role,
      isPublic: true,
    }),
    Instrument.findByIdAndUpdate(cert.instrumentId, { status: 'SUSPENDED' }),
    InstrumentEvent.create({
      instrumentId: cert.instrumentId,
      eventType: 'FLAGGED',
      title: `Certificate ${cert.certNo} suspended`,
      description: reason,
      certificateId: cert._id,
      actorId: new Types.ObjectId(actor.id),
      actorRole: actor.role,
    }),
    auditAction(
      { id: actor.id, role: actor.role, email: actor.email },
      'certificate.suspend',
      { type: 'Certificate', id: cert._id, label: cert.certNo },
      { details: reason, headers }
    ),
    notifications.certificateStatusChanged(
      String(cert.ownerId),
      cert.certNo,
      String(cert._id),
      'SUSPENDED',
      reason
    ),
  ]);
}

export async function reinstateCertificate(
  cert: ICertificate & { _id: Types.ObjectId; save: () => Promise<unknown> },
  actor: AuthedUser,
  reason: string,
  headers?: Headers
): Promise<void> {
  if (cert.status !== 'SUSPENDED') {
    throw BadRequest('Only a suspended certificate can be reinstated');
  }

  // Re-derive from the expiry date rather than trusting the stored value, which
  // may have gone stale while the certificate sat suspended.
  const daysLeft = Math.ceil((new Date(cert.expiryDate).getTime() - Date.now()) / 86_400_000);
  cert.status = daysLeft <= 0 ? 'EXPIRED' : daysLeft <= 60 ? 'EXPIRING_SOON' : 'ACTIVE';
  cert.suspension = undefined;
  await cert.save();

  await Promise.all([
    CertificateEvent.create({
      certificateId: cert._id,
      certNo: cert.certNo,
      instrumentId: cert.instrumentId,
      eventType: 'REINSTATED',
      summary: `Suspension lifted. Reason: ${reason}`,
      fromStatus: 'SUSPENDED',
      toStatus: cert.status,
      actorId: new Types.ObjectId(actor.id),
      actorRole: actor.role,
      isPublic: true,
    }),
    Instrument.findByIdAndUpdate(cert.instrumentId, {
      status: cert.status === 'EXPIRED' ? 'EXPIRED' : 'VERIFIED',
    }),
    auditAction(
      { id: actor.id, role: actor.role, email: actor.email },
      'certificate.reinstate',
      { type: 'Certificate', id: cert._id, label: cert.certNo },
      { details: reason, headers }
    ),
  ]);
}

export async function revokeCertificate(
  cert: ICertificate & { _id: Types.ObjectId; save: () => Promise<unknown> },
  actor: AuthedUser,
  reason: string,
  legalReference?: string,
  headers?: Headers
): Promise<void> {
  if (cert.status === 'REVOKED') throw BadRequest('This certificate is already revoked');

  const from = cert.status;
  cert.status = 'REVOKED';
  cert.revocation = {
    reason,
    by: new Types.ObjectId(actor.id),
    at: new Date(),
    legalReference,
  };
  await cert.save();

  await Promise.all([
    CertificateEvent.create({
      certificateId: cert._id,
      certNo: cert.certNo,
      instrumentId: cert.instrumentId,
      eventType: 'REVOKED',
      summary: `Certificate revoked by the issuing authority. Reason: ${reason}`,
      fromStatus: from,
      toStatus: 'REVOKED',
      actorId: new Types.ObjectId(actor.id),
      actorRole: actor.role,
      isPublic: true,
    }),
    Instrument.findByIdAndUpdate(cert.instrumentId, {
      status: 'SUSPENDED',
      $unset: { currentCertificateId: '' },
    }),
    InstrumentEvent.create({
      instrumentId: cert.instrumentId,
      eventType: 'CERTIFICATE_REVOKED',
      title: `Certificate ${cert.certNo} revoked`,
      description: reason,
      certificateId: cert._id,
      actorId: new Types.ObjectId(actor.id),
      actorRole: actor.role,
    }),
    auditAction(
      { id: actor.id, role: actor.role, email: actor.email },
      'certificate.revoke',
      { type: 'Certificate', id: cert._id, label: cert.certNo },
      { details: `${reason}${legalReference ? ` (${legalReference})` : ''}`, headers }
    ),
    notifications.certificateStatusChanged(
      String(cert.ownerId),
      cert.certNo,
      String(cert._id),
      'REVOKED',
      reason
    ),
  ]);
}

/** Latest submitted, non-superseded inspection for an application. */
export async function currentInspection(applicationId: Types.ObjectId | string) {
  return Inspection.findOne({
    applicationId,
    isSuperseded: false,
    isSubmitted: true,
  }).sort({ version: -1 });
}

/** Convenience used by the officer decision endpoint. */
export async function findApplicationWithInspection(applicationId: string) {
  const app = await Application.findById(applicationId);
  if (!app) return null;
  const inspection = await currentInspection(app._id);
  return { app, inspection };
}
