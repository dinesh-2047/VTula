import { NextRequest } from 'next/server';
import { type PipelineStage } from 'mongoose';
import dbConnect from '@/lib/db';
import RiskFlag from '@/models/RiskFlag';
import {
  handle,
  ok,
  requireOfficial,
  BadRequest,
} from '@/lib/rbac';
import { riskScopeStages } from '@/lib/riskScope';
import {
  RISK_FLAG_STATUSES,
  RISK_FLAG_TYPES,
  RISK_LEVELS,
} from '@/lib/constants';

/**
 * Risk flag triage.
 *
 * The detectors in `src/lib/risk.ts` have been running on the nightly sweep and
 * writing flags nobody could read: there was no endpoint, so an officer had no way
 * to see a duplicated serial number or a GPS mismatch, let alone resolve one. A
 * detector whose output is never read is worse than no detector, because the
 * system appears to be watching for fraud and is not.
 *
 * Two properties this endpoint keeps, because the spec is explicit that risk
 * scoring is decision **support**:
 *
 *  - **Officers only.** A flag is an unproven suspicion. Telling a business it has
 *    been flagged for possible serial-number cloning, before an officer has looked
 *    at it, would be an accusation the department has not yet made.
 *  - **Every flag carries its reasons.** `reasons` and `evidence` are returned in
 *    full, so an officer acts on the finding rather than on the score.
 */

export const dynamic = 'force-dynamic';

export const GET = handle(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireOfficial('risk.list');
  const sp = req.nextUrl.searchParams;

  const match: Record<string, unknown> = {};

  // Default to what still needs a decision. A triage queue that opens on
  // already-resolved flags is a queue nobody works.
  const status = sp.get('status') ?? 'open';
  if (status === 'open') {
    match.status = { $in: ['OPEN', 'REVIEWING'] };
  } else if (status === 'resolved') {
    match.status = { $in: ['DISMISSED', 'CONFIRMED'] };
  } else if (status !== 'all') {
    if (!(RISK_FLAG_STATUSES as readonly string[]).includes(status)) {
      throw BadRequest(
        `Unknown status "${status}". Use one of ${RISK_FLAG_STATUSES.join(', ')}, or open/resolved/all.`,
        'INVALID_STATUS'
      );
    }
    match.status = status;
  }

  const level = sp.get('level');
  if (level && level !== 'all') {
    if (!(RISK_LEVELS as readonly string[]).includes(level)) {
      throw BadRequest(`Unknown risk level "${level}"`, 'INVALID_LEVEL');
    }
    match.level = level;
  }

  const flagType = sp.get('flagType');
  if (flagType && flagType !== 'all') {
    if (!(RISK_FLAG_TYPES as readonly string[]).includes(flagType)) {
      throw BadRequest(`Unknown flag type "${flagType}"`, 'INVALID_FLAG_TYPE');
    }
    match.flagType = flagType;
  }

  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(sp.get('limit') ?? 25) || 25));

  const scope = riskScopeStages(user);

  const pipeline: PipelineStage[] = [
    { $match: match },
    ...scope,
    // Highest score first: the detectors set the score from severity, so this is
    // the order an officer should work the queue in.
    { $sort: { score: -1, detectedAt: -1 } },
    { $skip: (page - 1) * limit },
    { $limit: limit },
  ];

  const [flags, countResult, summaryByLevel, summaryByType, openTotal] = await Promise.all([
    RiskFlag.aggregate(pipeline),

    RiskFlag.aggregate([{ $match: match }, ...scope, { $count: 'total' }]),

    RiskFlag.aggregate([
      { $match: { status: { $in: ['OPEN', 'REVIEWING'] } } },
      ...scope,
      { $group: { _id: '$level', count: { $sum: 1 } } },
    ]),

    RiskFlag.aggregate([
      { $match: { status: { $in: ['OPEN', 'REVIEWING'] } } },
      ...scope,
      { $group: { _id: '$flagType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    RiskFlag.aggregate([
      { $match: { status: { $in: ['OPEN', 'REVIEWING'] } } },
      ...scope,
      { $count: 'total' },
    ]),
  ]);

  const total = countResult[0]?.total ?? 0;

  return ok({
    flags: flags.map((f) => ({
      id: String(f._id),
      flagType: f.flagType,
      level: f.level,
      score: f.score,
      title: f.title,
      // The whole point: the officer sees why, not just how much.
      reasons: f.reasons ?? [],
      recommendedAction: f.recommendedAction,
      evidence: f.evidence,
      status: f.status,
      instrument: f.instrument
        ? {
            id: String(f.instrument._id),
            serialNo: f.instrument.serialNo,
            type: f.instrument.type,
            brand: f.instrument.brand,
            model: f.instrument.model,
            state: f.instrument.installationState,
            district: f.instrument.installationDistrict,
          }
        : null,
      applicationId: f.applicationId ? String(f.applicationId) : undefined,
      certificateId: f.certificateId ? String(f.certificateId) : undefined,
      ownerId: f.ownerId ? String(f.ownerId) : undefined,
      reviewedAt: f.reviewedAt,
      reviewNote: f.reviewNote,
      detectedAt: f.detectedAt,
      ageDays: Math.floor((Date.now() - new Date(f.detectedAt).getTime()) / 86_400_000),
    })),
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
    summary: {
      openTotal: openTotal[0]?.total ?? 0,
      byLevel: Object.fromEntries(summaryByLevel.map((r) => [r._id, r.count])),
      byType: summaryByType.map((r) => ({ flagType: r._id, count: r.count })),
    },
    filters: {
      statuses: RISK_FLAG_STATUSES,
      levels: RISK_LEVELS,
      flagTypes: RISK_FLAG_TYPES,
    },
    note: 'Risk flags are advisory. They order attention and never decide an application.',
  });
});
