import { Types } from 'mongoose';
import ComplianceScore, { type IComplianceScoreComponent } from '@/models/ComplianceScore';
import Instrument from '@/models/Instrument';
import Certificate from '@/models/Certificate';
import Application from '@/models/Application';
import RiskFlag from '@/models/RiskFlag';
import EnforcementCase from '@/models/EnforcementCase';
import { EXPIRING_SOON_WINDOW_DAYS, type ApplicationStatus } from '@/lib/constants';

/** Statuses that mean no re-verification is actively progressing. */
const NOT_IN_FLIGHT_STATUSES: ApplicationStatus[] = [
  'DRAFT',
  'REJECTED',
  'CANCELLED',
  'CERTIFICATE_GENERATED',
  'ACTIVE',
  'EXPIRED',
  'SUSPENDED',
  'REVOKED',
];

/**
 * Compliance Health Score.
 *
 * Spec: a business should get one number it can act on, and that number must be
 * explainable. So the score is a weighted sum of five components, each of which
 * reports the points it earned, the points available and a sentence saying why —
 * `breakdown` is rendered directly in the UI rather than kept internal.
 *
 * Deliberately not a "risk rating" of the business: it measures the state of
 * their records, and it never feeds an enforcement decision on its own.
 */

const WEIGHTS = {
  coverage: 40,
  timeliness: 20,
  renewalHistory: 15,
  riskFlags: 15,
  enforcement: 10,
} as const;

function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' | 'E' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

export interface ComplianceResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E';
  breakdown: IComplianceScoreComponent[];
  stats: {
    totalInstruments: number;
    verifiedInstruments: number;
    expiringSoon: number;
    expired: number;
    openRiskFlags: number;
    openEnforcementCases: number;
    lateRenewals: number;
    onTimeRenewals: number;
  };
  recommendations: string[];
}

/**
 * Computes the score for one owner (and their organisation, when set).
 * Pure computation plus reads — call `persistComplianceScore` to snapshot it.
 */
export async function computeComplianceScore(
  ownerId: string | Types.ObjectId,
  organizationId?: string | Types.ObjectId
): Promise<ComplianceResult> {
  const owner = new Types.ObjectId(String(ownerId));
  const scopeInstrument: Record<string, unknown> = organizationId
    ? { $or: [{ ownerId: owner }, { organizationId: new Types.ObjectId(String(organizationId)) }] }
    : { ownerId: owner };

  const soonCutoff = new Date(Date.now() + EXPIRING_SOON_WINDOW_DAYS * 86_400_000);

  const [instruments, certificates, openRiskFlags, openEnforcementCases, apps] = await Promise.all([
    Instrument.find({ ...scopeInstrument, isDecommissioned: { $ne: true } })
      .select('_id type serialNo status currentCertificateId nextVerificationDue failedInspectionCount')
      .lean<
        {
          _id: Types.ObjectId;
          type: string;
          serialNo: string;
          status: string;
          currentCertificateId?: Types.ObjectId;
          nextVerificationDue?: Date;
          failedInspectionCount?: number;
        }[]
      >(),
    Certificate.find({ ownerId: owner })
      .select('_id certNo status issuedDate expiryDate instrumentId supersedesId')
      .lean<
        {
          _id: Types.ObjectId;
          certNo: string;
          status: string;
          issuedDate: Date;
          expiryDate: Date;
          instrumentId: Types.ObjectId;
          supersedesId?: Types.ObjectId;
        }[]
      >(),
    RiskFlag.countDocuments({ ownerId: owner, status: { $in: ['OPEN', 'CONFIRMED'] } }),
    EnforcementCase.countDocuments({
      ownerId: owner,
      status: { $nin: ['CLOSED', 'DISMISSED'] },
    }),
    Application.find({ ownerId: owner })
      .select('_id status instrumentId')
      .lean<{ _id: Types.ObjectId; status: string; instrumentId: Types.ObjectId }[]>(),
  ]);

  const totalInstruments = instruments.length;
  const now = Date.now();

  const liveCertByInstrument = new Map<string, { expiryDate: Date; status: string }>();
  for (const c of certificates) {
    if (c.status === 'SUPERSEDED' || c.status === 'REVOKED') continue;
    const key = String(c.instrumentId);
    const existing = liveCertByInstrument.get(key);
    if (!existing || new Date(c.expiryDate) > new Date(existing.expiryDate)) {
      liveCertByInstrument.set(key, { expiryDate: c.expiryDate, status: c.status });
    }
  }

  let verifiedInstruments = 0;
  let expiringSoon = 0;
  let expired = 0;
  const unverified: string[] = [];

  for (const inst of instruments) {
    const cert = liveCertByInstrument.get(String(inst._id));
    if (!cert) {
      unverified.push(`${inst.type} ${inst.serialNo}`);
      continue;
    }
    const exp = new Date(cert.expiryDate).getTime();
    if (cert.status === 'SUSPENDED') {
      unverified.push(`${inst.type} ${inst.serialNo} (suspended)`);
    } else if (exp < now) {
      expired += 1;
    } else {
      verifiedInstruments += 1;
      if (exp <= soonCutoff.getTime()) expiringSoon += 1;
    }
  }

  // Renewal punctuality: a renewal issued after the previous certificate had
  // already lapsed counts as late.
  const certById = new Map(certificates.map((c) => [String(c._id), c]));
  let lateRenewals = 0;
  let onTimeRenewals = 0;
  for (const c of certificates) {
    if (!c.supersedesId) continue;
    const prev = certById.get(String(c.supersedesId));
    if (!prev) continue;
    if (new Date(c.issuedDate).getTime() > new Date(prev.expiryDate).getTime()) lateRenewals += 1;
    else onTimeRenewals += 1;
  }

  const breakdown: IComplianceScoreComponent[] = [];
  const recommendations: string[] = [];

  // --- 1. Coverage -------------------------------------------------------
  if (totalInstruments === 0) {
    breakdown.push({
      key: 'coverage',
      label: 'Verification coverage',
      earned: 0,
      possible: WEIGHTS.coverage,
      detail: 'No instruments are registered yet, so coverage cannot be measured.',
    });
    recommendations.push('Register your weighing and measuring instruments to begin tracking compliance.');
  } else {
    const ratio = verifiedInstruments / totalInstruments;
    const earned = Math.round(ratio * WEIGHTS.coverage);
    breakdown.push({
      key: 'coverage',
      label: 'Verification coverage',
      earned,
      possible: WEIGHTS.coverage,
      detail: `${verifiedInstruments} of ${totalInstruments} instruments hold a valid certificate.${
        expired > 0 ? ` ${expired} have expired.` : ''
      }${unverified.length > 0 ? ` ${unverified.length} have never been verified.` : ''}`,
    });

    if (expired > 0) {
      recommendations.push(
        `Apply for re-verification of ${expired} expired instrument${expired === 1 ? '' : 's'} — these must not be used for trade until verified.`
      );
    }
    if (unverified.length > 0) {
      recommendations.push(
        `Submit a first verification for: ${unverified.slice(0, 3).join(', ')}${unverified.length > 3 ? ` and ${unverified.length - 3} more` : ''}.`
      );
    }
  }

  // --- 2. Timeliness (things about to lapse) ----------------------------
  if (totalInstruments === 0) {
    breakdown.push({
      key: 'timeliness',
      label: 'Renewal timeliness',
      earned: WEIGHTS.timeliness,
      possible: WEIGHTS.timeliness,
      detail: 'Nothing is due for renewal.',
    });
  } else {
    // An instrument in the expiring window with a re-verification already in
    // flight does not count against you.
    const inFlight = new Set(
      apps
        .filter((a) => !NOT_IN_FLIGHT_STATUSES.includes(a.status as (typeof NOT_IN_FLIGHT_STATUSES)[number]))
        .map((a) => String(a.instrumentId))
    );

    const unattended = instruments.filter((inst) => {
      const cert = liveCertByInstrument.get(String(inst._id));
      if (!cert) return false;
      const exp = new Date(cert.expiryDate).getTime();
      return exp > now && exp <= soonCutoff.getTime() && !inFlight.has(String(inst._id));
    }).length;

    const penalty = Math.min(WEIGHTS.timeliness, unattended * 7);
    breakdown.push({
      key: 'timeliness',
      label: 'Renewal timeliness',
      earned: WEIGHTS.timeliness - penalty,
      possible: WEIGHTS.timeliness,
      detail:
        unattended === 0
          ? expiringSoon > 0
            ? `${expiringSoon} certificate(s) expire within ${EXPIRING_SOON_WINDOW_DAYS} days and re-verification is already under way.`
            : 'No certificates are close to expiry.'
          : `${unattended} certificate(s) expire within ${EXPIRING_SOON_WINDOW_DAYS} days with no application submitted.`,
    });

    if (unattended > 0) {
      recommendations.push(
        `Start re-verification for ${unattended} instrument${unattended === 1 ? '' : 's'} expiring in the next ${EXPIRING_SOON_WINDOW_DAYS} days.`
      );
    }
  }

  // --- 3. Renewal history ------------------------------------------------
  const renewalTotal = lateRenewals + onTimeRenewals;
  if (renewalTotal === 0) {
    breakdown.push({
      key: 'renewalHistory',
      label: 'Renewal history',
      earned: WEIGHTS.renewalHistory,
      possible: WEIGHTS.renewalHistory,
      detail: 'No renewal history yet — nothing counted for or against.',
    });
  } else {
    const earned = Math.round((onTimeRenewals / renewalTotal) * WEIGHTS.renewalHistory);
    breakdown.push({
      key: 'renewalHistory',
      label: 'Renewal history',
      earned,
      possible: WEIGHTS.renewalHistory,
      detail: `${onTimeRenewals} of ${renewalTotal} renewals were completed before the previous certificate expired.`,
    });
    if (lateRenewals > 0) {
      recommendations.push(
        'Set your reminder preference to 60 days so future renewals complete before the certificate lapses.'
      );
    }
  }

  // --- 4. Open risk flags ------------------------------------------------
  const flagPenalty = Math.min(WEIGHTS.riskFlags, openRiskFlags * 5);
  breakdown.push({
    key: 'riskFlags',
    label: 'Open compliance queries',
    earned: WEIGHTS.riskFlags - flagPenalty,
    possible: WEIGHTS.riskFlags,
    detail:
      openRiskFlags === 0
        ? 'No open compliance queries against your records.'
        : `${openRiskFlags} item(s) flagged for departmental review. A flag is advisory and is resolved by an officer.`,
  });

  // --- 5. Enforcement ----------------------------------------------------
  const enforcementPenalty = Math.min(WEIGHTS.enforcement, openEnforcementCases * WEIGHTS.enforcement);
  breakdown.push({
    key: 'enforcement',
    label: 'Enforcement record',
    earned: WEIGHTS.enforcement - enforcementPenalty,
    possible: WEIGHTS.enforcement,
    detail:
      openEnforcementCases === 0
        ? 'No open enforcement cases.'
        : `${openEnforcementCases} open enforcement case(s). Resolving these restores the full weighting.`,
  });

  if (openEnforcementCases > 0) {
    recommendations.push('Respond to the open enforcement case(s) — an unanswered notice escalates.');
  }

  const score = Math.max(
    0,
    Math.min(100, breakdown.reduce((sum, b) => sum + b.earned, 0))
  );

  if (recommendations.length === 0) {
    recommendations.push('All instruments are verified and nothing needs attention. Keep renewing 60 days ahead.');
  }

  return {
    score,
    grade: gradeFor(score),
    breakdown,
    stats: {
      totalInstruments,
      verifiedInstruments,
      expiringSoon,
      expired,
      openRiskFlags,
      openEnforcementCases,
      lateRenewals,
      onTimeRenewals,
    },
    recommendations,
  };
}

/** Computes and snapshots the score, keeping the trend history. */
export async function persistComplianceScore(
  ownerId: string | Types.ObjectId,
  organizationId?: string | Types.ObjectId
): Promise<ComplianceResult> {
  const result = await computeComplianceScore(ownerId, organizationId);

  await ComplianceScore.create({
    ownerId: new Types.ObjectId(String(ownerId)),
    organizationId: organizationId ? new Types.ObjectId(String(organizationId)) : undefined,
    ...result,
    computedAt: new Date(),
  });

  return result;
}
