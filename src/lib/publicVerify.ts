import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import Certificate, { type ICertificate } from '@/models/Certificate';
import CertificateEvent from '@/models/CertificateEvent';
import PublicVerification from '@/models/PublicVerification';
import { checkIntegrity, effectiveStatus, verifyUrl } from '@/lib/certificates';
import { clientIpFromHeaders, hashRequesterIp } from '@/lib/utils';
import {
  CERTIFICATE_STATUS_LABELS,
  EXPIRING_SOON_WINDOW_DAYS,
  extractCertNo,
} from '@/lib/constants';

/** Re-exported: the trust page's scanner parses scanned codes with this too. */
export { extractCertNo };

/**
 * Public certificate verification — the one thing on this platform a citizen
 * uses without an account.
 *
 * Deliberate constraints:
 *  - **No authentication, and no personal data.** The response carries the
 *    business's trading name and the instrument's identity, because that is what
 *    a customer standing at the shop needs to match against the sticker in front
 *    of them. It never carries the owner's email, phone or address, which the
 *    old endpoint returned wholesale via `ownerSnapshot`.
 *  - **Every lookup is recorded**, with a daily-salted hash of the requester IP
 *    rather than the IP, so repeated probing is visible to enforcement without
 *    building a log of who scanned what.
 *  - **The verdict is derived, not read.** The old endpoint compared
 *    `certificate.status === 'Active'` — a value that no longer exists in the
 *    enum, so the check silently never fired and an expired certificate was
 *    reported with whatever status was last written to it.
 *  - **The signature is actually checked.** A row whose contents no longer match
 *    its hash is reported as tampered, not as valid.
 */

export type VerifyOutcome =
  | 'VALID'
  | 'EXPIRING_SOON'
  | 'EXPIRED'
  | 'SUSPENDED'
  | 'REVOKED'
  | 'SUPERSEDED'
  | 'NOT_FOUND'
  | 'INTEGRITY_FAILED';

export interface PublicVerifyResult {
  found: boolean;
  outcome: VerifyOutcome;
  /** Plain-language verdict for the trust page headline. */
  headline: string;
  detail: string;
  /** True only when the instrument may legally be used for trade right now. */
  isValidForTrade: boolean;
  certificate: null | {
    certNo: string;
    issuedDate: Date;
    expiryDate: Date;
    daysToExpiry: number;
    status: string;
    statusLabel: string;
    version: number;
    instrument: {
      type: string;
      brand: string;
      model: string;
      serialNo: string;
      capacity: string;
      accuracyClass?: string;
      district?: string;
      state?: string;
    };
    /** Trading name only — never the proprietor's contact details. */
    verifiedBusiness: string;
    issuedBy: {
      designation?: string;
      officerCode?: string;
      office?: string;
    };
    inspection?: {
      inspectedAt: Date;
      result: string;
      readingCount: number;
      maxErrorPercent?: number;
      sealNo?: string;
    };
    legalReference?: string;
    verificationCount: number;
    verifyUrl: string;
  };
  integrity: { signatureValid: boolean; hashValid: boolean; detail: string } | null;
  /** Public, append-only history: issued / renewed / suspended / revoked. */
  history: { eventType: string; summary: string; occurredAt: Date }[];
  /** Set when this certificate was replaced by a newer one. */
  supersededBy?: { certNo: string; expiryDate: Date } | null;
}

const HEADLINES: Record<VerifyOutcome, string> = {
  VALID: 'This instrument is verified and legal for trade',
  EXPIRING_SOON: 'Verified — but this certificate expires soon',
  EXPIRED: 'This certificate has expired',
  SUSPENDED: 'This certificate is suspended',
  REVOKED: 'This certificate has been revoked',
  SUPERSEDED: 'This certificate has been replaced by a newer one',
  NOT_FOUND: 'No certificate found with this number',
  INTEGRITY_FAILED: 'This certificate could not be authenticated',
};

/**
 * Resolves whatever the citizen supplied — a typed certificate number or the URL
 * a scanner read out of a QR code — into a recorded, derived verdict.
 */
export async function publicVerify(
  input: string,
  opts: { source?: 'QR' | 'MANUAL' | 'API'; headers?: Headers } = {}
): Promise<PublicVerifyResult> {
  await dbConnect();

  const source = opts.source ?? 'MANUAL';
  const requesterHash = opts.headers
    ? hashRequesterIp(clientIpFromHeaders(opts.headers))
    : undefined;
  const userAgent = opts.headers?.get('user-agent')?.slice(0, 300);

  const certNo = extractCertNo(input);

  if (!certNo) {
    await log({ queriedCertNo: input.slice(0, 80), outcome: 'NOT_FOUND', requesterHash, userAgent, source });
    return notFound(input);
  }

  const cert = await Certificate.findOne({ certNo }).lean<ICertificate>();

  if (!cert) {
    await log({ queriedCertNo: certNo, outcome: 'NOT_FOUND', requesterHash, userAgent, source });
    return notFound(certNo);
  }

  const integrity = checkIntegrity(cert);
  const derived = effectiveStatus(cert, EXPIRING_SOON_WINDOW_DAYS);

  // A hash mismatch means the stored row was edited outside the issuance path.
  // That outranks every other verdict — we cannot vouch for the contents.
  const outcome: VerifyOutcome = !integrity.hashValid
    ? 'INTEGRITY_FAILED'
    : (derived as VerifyOutcome);

  const [history, supersededBy] = await Promise.all([
    CertificateEvent.find({ certificateId: cert._id, isPublic: true })
      .select('eventType summary occurredAt')
      .sort({ occurredAt: 1 })
      .limit(25)
      .lean(),
    cert.supersededById
      ? Certificate.findById(cert.supersededById).select('certNo expiryDate').lean()
      : null,
  ]);

  await Promise.all([
    log({
      queriedCertNo: certNo,
      certificateId: cert._id,
      instrumentId: cert.instrumentId,
      outcome,
      requesterHash,
      userAgent,
      source,
    }),
    // Counter for the trust page. Fire-and-forget: a failed counter must never
    // turn a successful verification into an error.
    Certificate.updateOne(
      { _id: cert._id },
      { $inc: { verificationCount: 1 }, $set: { lastVerifiedAt: new Date() } }
    ).catch(() => undefined),
  ]);

  const daysToExpiry = Math.ceil((new Date(cert.expiryDate).getTime() - Date.now()) / 86_400_000);

  return {
    found: true,
    outcome,
    headline: HEADLINES[outcome],
    detail: detailFor(outcome, cert, daysToExpiry, integrity.detail),
    isValidForTrade: outcome === 'VALID' || outcome === 'EXPIRING_SOON',
    certificate: {
      certNo: cert.certNo,
      issuedDate: cert.issuedDate,
      expiryDate: cert.expiryDate,
      daysToExpiry,
      status: outcome,
      statusLabel:
        CERTIFICATE_STATUS_LABELS[derived as keyof typeof CERTIFICATE_STATUS_LABELS] ?? derived,
      version: cert.version ?? 1,
      instrument: {
        type: cert.instrumentSnapshot?.type ?? '',
        brand: cert.instrumentSnapshot?.brand ?? '',
        model: cert.instrumentSnapshot?.model ?? '',
        serialNo: cert.instrumentSnapshot?.serialNo ?? '',
        capacity: cert.instrumentSnapshot?.capacity ?? '',
        accuracyClass: cert.instrumentSnapshot?.accuracyClass,
        district: cert.instrumentSnapshot?.installationDistrict,
        state: cert.instrumentSnapshot?.installationState,
      },
      // Trading name if the business has one, otherwise the proprietor's name —
      // which is the name on the licence, and is already public on the premises.
      verifiedBusiness:
        cert.ownerSnapshot?.organizationName || cert.ownerSnapshot?.name || 'Not recorded',
      issuedBy: {
        designation: cert.issuerSnapshot?.designation,
        officerCode: cert.issuerSnapshot?.officerCode,
        office: [cert.issuerSnapshot?.district, cert.issuerSnapshot?.state]
          .filter(Boolean)
          .join(', ') || undefined,
      },
      inspection: cert.inspectionSummary,
      legalReference: cert.appliedRuleSnapshot?.legalReference,
      verificationCount: (cert.verificationCount ?? 0) + 1,
      verifyUrl: verifyUrl(cert.certNo),
    },
    integrity,
    history: history.map((h) => ({
      eventType: h.eventType,
      summary: h.summary,
      occurredAt: h.occurredAt,
    })),
    supersededBy: supersededBy
      ? { certNo: supersededBy.certNo, expiryDate: supersededBy.expiryDate }
      : null,
  };
}

function detailFor(
  outcome: VerifyOutcome,
  cert: ICertificate,
  daysToExpiry: number,
  integrityDetail: string
): string {
  switch (outcome) {
    case 'VALID':
      return `Verified by the Legal Metrology Department. Valid for another ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}, until ${fmt(cert.expiryDate)}.`;
    case 'EXPIRING_SOON':
      return `This certificate is still valid but expires on ${fmt(cert.expiryDate)} (${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'} away). The business should apply for re-verification.`;
    case 'EXPIRED':
      return `Verification lapsed on ${fmt(cert.expiryDate)}. Using an unverified instrument for trade is an offence under the Legal Metrology Act, 2009. You can report this to the department.`;
    case 'SUSPENDED':
      return `The department suspended this certificate on ${fmt(cert.suspension?.at)}. The instrument must not be used for trade while the suspension is in force.`;
    case 'REVOKED':
      return `The department revoked this certificate on ${fmt(cert.revocation?.at)}${cert.revocation?.legalReference ? ` under ${cert.revocation.legalReference}` : ''}. It carries no validity.`;
    case 'SUPERSEDED':
      return 'A newer certificate has replaced this one. Check the replacement shown below.';
    case 'INTEGRITY_FAILED':
      return integrityDetail;
    default:
      return '';
  }
}

function notFound(queried: string): PublicVerifyResult {
  return {
    found: false,
    outcome: 'NOT_FOUND',
    headline: HEADLINES.NOT_FOUND,
    // The number searched for is echoed back, because the commonest cause is a
    // misread character on a sticker and the citizen can only spot that if they
    // can see what was actually looked up.
    detail: `No certificate numbered ${queried} exists in the VTULA register. Check the number for typing errors — 0 and O, or 1 and I, are easily confused. If it is printed on a sticker on the instrument, the sticker may be counterfeit; please report it to the Legal Metrology Department.`,
    isValidForTrade: false,
    certificate: null,
    integrity: null,
    history: [],
    supersededBy: null,
  };
}

function fmt(d: Date | undefined): string {
  if (!d) return 'an unrecorded date';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function log(entry: {
  queriedCertNo: string;
  certificateId?: Types.ObjectId;
  instrumentId?: Types.ObjectId;
  outcome: VerifyOutcome;
  requesterHash?: string;
  userAgent?: string;
  source: 'QR' | 'MANUAL' | 'API';
}): Promise<void> {
  try {
    await PublicVerification.create({ ...entry, verifiedAt: new Date() });
  } catch (err) {
    // Never let audit logging break a public lookup.
    console.error('[publicVerify] failed to log verification', err);
  }
}
