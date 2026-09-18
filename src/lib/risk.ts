import { Types } from 'mongoose';
import RiskFlag from '@/models/RiskFlag';
import Instrument, { type IInstrument } from '@/models/Instrument';
import Certificate from '@/models/Certificate';
import Application from '@/models/Application';
import Inspection from '@/models/Inspection';
import { distanceMetres, isPlausibleIndianCoordinate, isValidLatLng } from '@/lib/geo';
import { resolveRule } from '@/lib/rules';
import type { ApplicationStatus, RiskLevel } from '@/lib/constants';

/**
 * Statuses that mean "this application is not actively progressing", so the
 * absence of one of these is what counts as a re-verification being in flight.
 */
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
 * Explainable risk detection.
 *
 * The spec allows the platform to *prioritise* and *flag* — it explicitly
 * forbids it acting as a legal decision-maker. So every detector here:
 *
 *  - produces plain-language `reasons` an officer can read and disagree with,
 *  - produces a `recommendedAction` that a human must carry out,
 *  - writes an OPEN flag that has to be confirmed or dismissed,
 *  - never mutates an application's status or a certificate's validity.
 *
 * There is no machine learning and nothing opaque: these are deterministic rules
 * over data the system already holds, which is what makes them defensible in a
 * regulatory setting.
 */

export interface DetectedFlag {
  flagType: string;
  level: RiskLevel;
  score: number;
  title: string;
  reasons: string[];
  recommendedAction: string;
  evidence?: Record<string, unknown>;
  dedupeKey: string;
  instrumentId?: Types.ObjectId;
  applicationId?: Types.ObjectId;
  certificateId?: Types.ObjectId;
  ownerId?: Types.ObjectId;
  organizationId?: Types.ObjectId;
}

/** Upserts a detected flag, leaving an existing officer resolution untouched. */
export async function persistFlag(flag: DetectedFlag): Promise<void> {
  await RiskFlag.findOneAndUpdate(
    { dedupeKey: flag.dedupeKey },
    {
      $setOnInsert: {
        ...flag,
        status: 'OPEN',
        detectedAt: new Date(),
      },
    },
    { upsert: true, new: false, setDefaultsOnInsert: true }
  ).catch((err: unknown) => {
    // A concurrent sweep may have inserted the same key first.
    if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) return;
    console.error('[risk] failed to persist flag:', err);
  });
}

/* ------------------------------------------------------------------ *
 * Detectors
 * ------------------------------------------------------------------ */

/** Duplicate serial numbers across different owners — a cloning indicator. */
export async function detectDuplicateSerials(state?: string): Promise<DetectedFlag[]> {
  const match: Record<string, unknown> = { isDecommissioned: { $ne: true } };
  if (state) match.installationState = state;

  const groups = await Instrument.aggregate<{
    _id: { brand: string; model: string; serial: string };
    ids: Types.ObjectId[];
    owners: Types.ObjectId[];
    count: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: { brand: '$brand', model: '$model', serial: '$serialNoNormalized' },
        ids: { $push: '$_id' },
        owners: { $addToSet: '$ownerId' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 200 },
  ]);

  return groups.map((g) => {
    const multiOwner = g.owners.length > 1;
    return {
      flagType: 'DUPLICATE_SERIAL',
      level: multiOwner ? ('HIGH' as RiskLevel) : ('MEDIUM' as RiskLevel),
      score: multiOwner ? 80 : 45,
      title: `Serial ${g._id.serial} registered ${g.count} times`,
      reasons: [
        `${g.count} instrument records share brand "${g._id.brand}", model "${g._id.model}" and serial "${g._id.serial}".`,
        multiOwner
          ? `They are registered to ${g.owners.length} different owners, which a genuine transfer would not produce.`
          : 'They are registered to the same owner, so this may be a duplicate data-entry rather than a cloned instrument.',
      ],
      recommendedAction: multiOwner
        ? 'Inspect the physical serial plates on each instrument and confirm which registration is genuine before issuing any further certificate.'
        : 'Contact the owner to confirm whether these are separate instruments; merge the duplicate record if not.',
      evidence: { instrumentIds: g.ids.map(String), ownerIds: g.owners.map(String) },
      dedupeKey: `dup-serial:${g._id.brand}|${g._id.model}|${g._id.serial}`,
      instrumentId: g.ids[0],
    };
  });
}

/** Certificates that have lapsed and were never renewed. */
export async function detectLapsedRenewals(state?: string): Promise<DetectedFlag[]> {
  const query: Record<string, unknown> = {
    status: { $in: ['ACTIVE', 'EXPIRING_SOON', 'EXPIRED'] },
    expiryDate: { $lt: new Date() },
    supersededById: { $exists: false },
  };
  if (state) query['instrumentSnapshot.installationState'] = state;

  const lapsed = await Certificate.find(query)
    .select('certNo expiryDate instrumentId ownerId organizationId instrumentSnapshot')
    .limit(300)
    .lean<
      {
        _id: Types.ObjectId;
        certNo: string;
        expiryDate: Date;
        instrumentId: Types.ObjectId;
        ownerId: Types.ObjectId;
        organizationId?: Types.ObjectId;
        instrumentSnapshot?: { serialNo?: string; type?: string };
      }[]
    >();

  const flags: DetectedFlag[] = [];

  for (const c of lapsed) {
    const daysLapsed = Math.floor((Date.now() - new Date(c.expiryDate).getTime()) / 86_400_000);

    // Is there a re-verification application already in flight? If so the owner
    // is acting and this is not a compliance risk.
    const inFlight = await Application.countDocuments({
      instrumentId: c.instrumentId,
      status: { $nin: NOT_IN_FLIGHT_STATUSES },
    });
    if (inFlight > 0) continue;

    const level: RiskLevel = daysLapsed > 90 ? 'CRITICAL' : daysLapsed > 30 ? 'HIGH' : 'MEDIUM';

    flags.push({
      flagType: 'LAPSED_RENEWAL',
      level,
      score: Math.min(95, 40 + daysLapsed),
      title: `${c.instrumentSnapshot?.type ?? 'Instrument'} ${c.instrumentSnapshot?.serialNo ?? ''} unverified for ${daysLapsed} days`,
      reasons: [
        `Certificate ${c.certNo} expired on ${new Date(c.expiryDate).toLocaleDateString('en-IN')} (${daysLapsed} days ago).`,
        'No re-verification application has been submitted for this instrument since.',
        'Using an unverified instrument for trade is an offence under the Legal Metrology Act 2009.',
      ],
      recommendedAction:
        daysLapsed > 90
          ? 'Schedule a field visit and consider enforcement action under the Act.'
          : 'Issue a reminder notice to the owner and set a compliance deadline.',
      evidence: { certNo: c.certNo, expiryDate: c.expiryDate, daysLapsed },
      dedupeKey: `lapsed:${c._id}:${Math.floor(daysLapsed / 30)}`,
      certificateId: c._id,
      instrumentId: c.instrumentId,
      ownerId: c.ownerId,
      organizationId: c.organizationId,
    });
  }

  return flags;
}

/** Readings that sit suspiciously close to the tolerance limit, repeatedly. */
export async function detectBorderlineReadings(state?: string): Promise<DetectedFlag[]> {
  const since = new Date(Date.now() - 180 * 86_400_000);

  const query: Record<string, unknown> = {
    isSubmitted: true,
    isSuperseded: false,
    result: 'PASS',
    inspectedAt: { $gte: since },
  };
  if (state) query['location.state'] = state;

  const inspections = await Inspection.find(query)
    .select('inspectionNo instrumentId applicationId readings inspectedAt inspectedBy')
    .limit(500)
    .lean<
      {
        _id: Types.ObjectId;
        inspectionNo: string;
        instrumentId: Types.ObjectId;
        applicationId: Types.ObjectId;
        readings: { label: string; errorPercent: number; maxErrorPercent: number }[];
        inspectedAt: Date;
      }[]
    >();

  const flags: DetectedFlag[] = [];

  for (const insp of inspections) {
    const borderline = (insp.readings ?? []).filter(
      (r) => r.maxErrorPercent > 0 && Math.abs(r.errorPercent) >= r.maxErrorPercent * 0.9
    );
    if (borderline.length === 0) continue;

    const ratio = borderline.length / (insp.readings?.length || 1);
    if (ratio < 0.5) continue;

    flags.push({
      flagType: 'BORDERLINE_READINGS',
      level: 'MEDIUM',
      score: 50 + Math.round(ratio * 30),
      title: `${insp.inspectionNo}: ${borderline.length} of ${insp.readings.length} readings within 10% of the tolerance limit`,
      reasons: [
        `Readings at ${borderline.map((b) => b.label).join(', ')} all sit at ≥90% of the maximum permissible error.`,
        'A passing instrument clustered at the limit will typically drift out of tolerance well before its certificate expires.',
      ],
      recommendedAction:
        'Advise the owner to have the instrument adjusted, and consider a shorter re-verification interval for this unit.',
      evidence: {
        inspectionNo: insp.inspectionNo,
        borderline: borderline.map((b) => ({
          label: b.label,
          errorPercent: b.errorPercent,
          maxErrorPercent: b.maxErrorPercent,
        })),
      },
      dedupeKey: `borderline:${insp._id}`,
      instrumentId: insp.instrumentId,
      applicationId: insp.applicationId,
    });
  }

  return flags;
}

/** Inspection GPS a long way from the instrument's registered location. */
export async function detectGpsMismatch(state?: string): Promise<DetectedFlag[]> {
  const since = new Date(Date.now() - 90 * 86_400_000);

  const query: Record<string, unknown> = {
    isSubmitted: true,
    isSuperseded: false,
    inspectedAt: { $gte: since },
    gpsDriftMetres: { $exists: true },
  };
  if (state) query['location.state'] = state;

  const inspections = await Inspection.find(query)
    .select('inspectionNo instrumentId applicationId gpsDriftMetres location inspectedBy')
    .limit(300)
    .lean<
      {
        _id: Types.ObjectId;
        inspectionNo: string;
        instrumentId: Types.ObjectId;
        applicationId: Types.ObjectId;
        gpsDriftMetres: number;
        location?: { gps?: { lat: number; lng: number } };
      }[]
    >();

  const flags: DetectedFlag[] = [];

  for (const insp of inspections) {
    const instrument = await Instrument.findById(insp.instrumentId)
      .select('type serialNo installationState gps')
      .lean<Pick<IInstrument, 'type' | 'serialNo' | 'installationState'> & { gps?: { lat: number; lng: number } }>();
    if (!instrument) continue;

    const rule = await resolveRule(instrument.installationState, instrument.type);
    if (insp.gpsDriftMetres <= rule.gpsToleranceMetres) continue;

    const km = (insp.gpsDriftMetres / 1000).toFixed(1);

    flags.push({
      flagType: 'GPS_MISMATCH',
      level: insp.gpsDriftMetres > 50_000 ? 'HIGH' : 'MEDIUM',
      score: Math.min(85, 40 + Math.round(insp.gpsDriftMetres / 2000)),
      title: `Inspection ${insp.inspectionNo} recorded ${km} km from the registered site`,
      reasons: [
        `The captured coordinates are ${insp.gpsDriftMetres.toLocaleString('en-IN')} m from the instrument's registered location.`,
        `The configured tolerance for ${instrument.type} in ${instrument.installationState} is ${rule.gpsToleranceMetres.toLocaleString('en-IN')} m.`,
        'This can be legitimate — a portable instrument, or a stale registered address — so it needs a human check.',
      ],
      recommendedAction:
        'Ask the inspector to confirm the visit location and update the instrument address if it has genuinely moved.',
      evidence: { driftMetres: insp.gpsDriftMetres, toleranceMetres: rule.gpsToleranceMetres },
      dedupeKey: `gps:${insp._id}`,
      instrumentId: insp.instrumentId,
      applicationId: insp.applicationId,
    });
  }

  return flags;
}

/** Applications that have blown their SLA. */
export async function detectSlaBreaches(state?: string): Promise<DetectedFlag[]> {
  const query: Record<string, unknown> = {
    dueDate: { $lt: new Date() },
    status: { $nin: NOT_IN_FLIGHT_STATUSES },
  };
  if (state) query['jurisdiction.state'] = state;

  const overdue = await Application.find(query)
    .select('applicationNo status dueDate jurisdiction ownerId organizationId instrumentId assignedTo')
    .limit(300)
    .lean<
      {
        _id: Types.ObjectId;
        applicationNo: string;
        status: string;
        dueDate: Date;
        ownerId: Types.ObjectId;
        organizationId?: Types.ObjectId;
        instrumentId: Types.ObjectId;
      }[]
    >();

  return overdue.map((a) => {
    const daysLate = Math.floor((Date.now() - new Date(a.dueDate).getTime()) / 86_400_000);
    return {
      flagType: 'SLA_BREACH',
      level: daysLate > 14 ? 'HIGH' : 'MEDIUM',
      score: Math.min(80, 35 + daysLate * 2),
      title: `${a.applicationNo} is ${daysLate} day${daysLate === 1 ? '' : 's'} past its service deadline`,
      reasons: [
        `The application has been at status ${a.status} past its due date of ${new Date(a.dueDate).toLocaleDateString('en-IN')}.`,
        'A delay here is a departmental service failure, not an applicant failure.',
      ],
      recommendedAction: 'Escalate to the supervising officer and reassign or schedule the inspection.',
      evidence: { status: a.status, dueDate: a.dueDate, daysLate },
      dedupeKey: `sla:${a._id}:${Math.floor(daysLate / 7)}`,
      applicationId: a._id,
      instrumentId: a.instrumentId,
      ownerId: a.ownerId,
      organizationId: a.organizationId,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Sweep + priority
 * ------------------------------------------------------------------ */

export interface SweepResult {
  detected: number;
  byType: Record<string, number>;
}

/** Runs every detector and persists what it finds. */
export async function runRiskSweep(state?: string): Promise<SweepResult> {
  const results = await Promise.allSettled([
    detectDuplicateSerials(state),
    detectLapsedRenewals(state),
    detectBorderlineReadings(state),
    detectGpsMismatch(state),
    detectSlaBreaches(state),
  ]);

  const flags = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  for (const r of results) {
    if (r.status === 'rejected') console.error('[risk] detector failed:', r.reason);
  }

  await Promise.allSettled(flags.map(persistFlag));

  const byType: Record<string, number> = {};
  for (const f of flags) byType[f.flagType] = (byType[f.flagType] ?? 0) + 1;

  return { detected: flags.length, byType };
}

/**
 * Advisory priority for an officer's queue.
 *
 * Returns the score *and* the reasons, because a queue that reorders itself for
 * unexplained reasons is not auditable.
 */
export async function computePriority(applicationId: Types.ObjectId | string): Promise<{
  score: number;
  reasons: string[];
}> {
  const app = await Application.findById(applicationId)
    .select('applicationNo type status dueDate submittedDate instrumentId jurisdiction')
    .lean<{
      _id: Types.ObjectId;
      type: string;
      dueDate?: Date;
      submittedDate?: Date;
      instrumentId: Types.ObjectId;
    }>();

  if (!app) return { score: 0, reasons: [] };

  const reasons: string[] = [];
  let score = 20;

  if (app.dueDate) {
    const daysLeft = Math.ceil((new Date(app.dueDate).getTime() - Date.now()) / 86_400_000);
    if (daysLeft < 0) {
      score += 40;
      reasons.push(`Past its service deadline by ${Math.abs(daysLeft)} day(s).`);
    } else if (daysLeft <= 3) {
      score += 25;
      reasons.push(`Service deadline in ${daysLeft} day(s).`);
    }
  }

  if (app.submittedDate) {
    const age = Math.floor((Date.now() - new Date(app.submittedDate).getTime()) / 86_400_000);
    if (age > 14) {
      score += 15;
      reasons.push(`Waiting ${age} days since submission.`);
    }
  }

  const instrument = await Instrument.findById(app.instrumentId)
    .select('failedInspectionCount duplicateReviewPending type')
    .lean<{ failedInspectionCount?: number; duplicateReviewPending?: boolean; type: string }>();

  if (instrument?.failedInspectionCount && instrument.failedInspectionCount > 0) {
    score += 15;
    reasons.push(`This instrument has failed verification ${instrument.failedInspectionCount} time(s) before.`);
  }

  if (instrument?.duplicateReviewPending) {
    score += 20;
    reasons.push('The instrument is flagged for duplicate-serial review.');
  }

  const openFlags = await RiskFlag.countDocuments({
    applicationId: app._id,
    status: { $in: ['OPEN', 'CONFIRMED'] },
  });
  if (openFlags > 0) {
    score += Math.min(20, openFlags * 10);
    reasons.push(`${openFlags} open risk flag(s) attached.`);
  }

  if (app.type === 'repair') {
    score += 10;
    reasons.push('Post-repair verification — the instrument is currently out of service.');
  }

  if (reasons.length === 0) reasons.push('Routine priority; no escalating factors found.');

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/** Sanity-checks GPS supplied with an inspection and returns the drift. */
export function evaluateGps(
  captured: { lat: number; lng: number } | undefined,
  registered: { lat: number; lng: number } | undefined
): { driftMetres?: number; warnings: string[] } {
  const warnings: string[] = [];

  if (!isValidLatLng(captured)) {
    warnings.push('No usable GPS coordinates were captured for this inspection.');
    return { warnings };
  }

  if (!isPlausibleIndianCoordinate(captured)) {
    warnings.push(
      `Captured coordinates (${captured.lat}, ${captured.lng}) fall outside India — check the device's location settings.`
    );
  }

  if (!isValidLatLng(registered)) {
    warnings.push('The instrument has no registered coordinates, so drift could not be measured.');
    return { warnings };
  }

  return { driftMetres: distanceMetres(captured, registered), warnings };
}
