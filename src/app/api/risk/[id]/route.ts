import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import RiskFlag from '@/models/RiskFlag';
import Instrument from '@/models/Instrument';
import Application from '@/models/Application';
import Certificate from '@/models/Certificate';
import User, { type IUser } from '@/models/User';
import {
  handle,
  ok,
  requireOfficial,
  BadRequest,
  NotFound,
  Conflict,
} from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { assertFlagInScope } from '@/lib/riskScope';
import { RISK_FLAG_STATUSES } from '@/lib/constants';

/**
 * One risk flag: read the full case for it, or record an officer's decision.
 *
 * The decision is the point of the whole risk subsystem. A detector can say "these
 * two instruments share a serial number"; only an officer can say whether that is
 * a clerical duplicate or a cloned seal. So `CONFIRMED` and `DISMISSED` both
 * require a written note — a flag resolved without a reason leaves the next officer
 * exactly where the first one started.
 *
 * Confirming a flag does **not** suspend a certificate or reject an application.
 * That would let a heuristic take an enforcement action. It records the finding and
 * points at the enforcement route, which a human drives.
 */

const RESOLUTIONS = ['REVIEWING', 'DISMISSED', 'CONFIRMED'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

async function loadFlag(id: string) {
  if (!Types.ObjectId.isValid(id)) throw NotFound('No such risk flag');
  const flag = await RiskFlag.findById(id);
  if (!flag) throw NotFound('No such risk flag');
  return flag;
}

export const GET = handle(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();
  const user = await requireOfficial('risk.read');

  const flag = await loadFlag(id);
  await assertFlagInScope(user, flag);

  /*
   * Everything the flag points at, so the officer can judge it without opening
   * four other pages. Each is optional because a flag targets whichever records
   * are relevant to its detector.
   */
  const [instrument, application, certificate, owner, reviewer, related] = await Promise.all([
    flag.instrumentId
      ? Instrument.findById(flag.instrumentId)
          .select(
            'serialNo type brand model capacity accuracyClass status installationState installationDistrict address lastVerifiedDate nextVerificationDue verificationCount'
          )
          .lean()
      : null,
    flag.applicationId
      ? Application.findById(flag.applicationId)
          .select('applicationNo type status submittedDate dueDate assignedTo jurisdiction feeStatus')
          .lean()
      : null,
    flag.certificateId
      ? Certificate.findById(flag.certificateId)
          .select('certNo status issuedDate expiryDate version')
          .lean()
      : null,
    flag.ownerId
      ? User.findById(flag.ownerId)
          .select('name email phone organizationName state district')
          .lean<IUser | null>()
      : null,
    flag.reviewedBy
      ? User.findById(flag.reviewedBy).select('name designation officerCode role').lean<IUser | null>()
      : null,
    // Other live flags on the same instrument. A single borderline reading is
    // noise; three findings on one instrument is a pattern.
    flag.instrumentId
      ? RiskFlag.find({
          instrumentId: flag.instrumentId,
          _id: { $ne: flag._id },
        })
          .select('flagType level score title status detectedAt')
          .sort({ score: -1 })
          .limit(10)
          .lean()
      : [],
  ]);

  return ok({
    flag: {
      id: String(flag._id),
      flagType: flag.flagType,
      level: flag.level,
      score: flag.score,
      title: flag.title,
      reasons: flag.reasons ?? [],
      recommendedAction: flag.recommendedAction,
      evidence: flag.evidence,
      status: flag.status,
      dedupeKey: flag.dedupeKey,
      detectedAt: flag.detectedAt,
      ageDays: Math.floor((Date.now() - new Date(flag.detectedAt).getTime()) / 86_400_000),
      review: flag.reviewedAt
        ? {
            at: flag.reviewedAt,
            note: flag.reviewNote,
            by: reviewer
              ? {
                  name: reviewer.name,
                  designation: reviewer.designation,
                  officerCode: reviewer.officerCode,
                  role: reviewer.role,
                }
              : undefined,
          }
        : null,
    },
    subject: { instrument, application, certificate, owner },
    relatedFlags: (related as { _id: Types.ObjectId; [k: string]: unknown }[]).map((r) => ({
      ...r,
      id: String(r._id),
    })),
    resolutions: RESOLUTIONS,
    note: 'Confirming a flag records the finding. Suspension, revocation and prosecution are separate, deliberate actions.',
  });
});

export const PATCH = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();
  const user = await requireOfficial('risk.triage');

  const flag = await loadFlag(id);
  await assertFlagInScope(user, flag);

  const body = (await req.json()) as Record<string, unknown>;
  const status = String(body.status ?? '').toUpperCase() as Resolution;

  if (!(RESOLUTIONS as readonly string[]).includes(status)) {
    throw BadRequest(
      `Set status to one of ${RESOLUTIONS.join(', ')}. A flag cannot be moved back to OPEN once it has been looked at.`,
      'INVALID_RESOLUTION'
    );
  }
  if (!(RISK_FLAG_STATUSES as readonly string[]).includes(status)) {
    throw BadRequest(`"${status}" is not a recognised flag status`, 'INVALID_STATUS');
  }

  if (flag.status === status) {
    throw Conflict(`This flag is already marked ${status}`, 'NO_OP');
  }
  if (flag.status === 'DISMISSED' || flag.status === 'CONFIRMED') {
    throw Conflict(
      `This flag was already resolved as ${flag.status}. Raise an enforcement case if new information has come to light.`,
      'ALREADY_RESOLVED'
    );
  }

  const note = typeof body.note === 'string' ? body.note.trim() : '';

  /*
   * A written reason is required to close a flag either way. Dismissing without
   * one hides a judgement call that a later audit would need to see, and
   * confirming without one gives an enforcement case nothing to rest on.
   * `REVIEWING` is only "I have picked this up", so it does not need one.
   */
  if (status !== 'REVIEWING' && note.length < 10) {
    throw BadRequest(
      status === 'DISMISSED'
        ? 'Say why this flag is not a concern, in at least a few words. A dismissal without a reason cannot be reviewed later.'
        : 'Record what you found, in at least a few words. A confirmed finding needs to stand on its own in an enforcement case.',
      'NOTE_REQUIRED'
    );
  }

  const from = flag.status;
  flag.status = status;
  flag.reviewedBy = new Types.ObjectId(user.id);
  flag.reviewedAt = new Date();
  if (note) flag.reviewNote = note;
  await flag.save();

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    status === 'CONFIRMED'
      ? 'risk.confirm'
      : status === 'DISMISSED'
        ? 'risk.dismiss'
        : 'risk.review',
    { type: 'RiskFlag', id: flag._id, label: flag.title },
    {
      details: `${from} → ${status}${note ? `: ${note}` : ''}`,
      changes: { flagType: flag.flagType, level: flag.level, score: flag.score, from, to: status },
      headers: req.headers,
    }
  );

  return ok({
    flag: {
      id: String(flag._id),
      status: flag.status,
      reviewedAt: flag.reviewedAt,
      reviewNote: flag.reviewNote,
    },
    message:
      status === 'CONFIRMED'
        ? 'Finding recorded. Open an enforcement case if action against the business is warranted.'
        : status === 'DISMISSED'
          ? 'Flag dismissed. The detector will not raise it again for this period.'
          : 'Flag marked as under review.',
    // Named so the UI can offer the next step without implying it has happened.
    nextStep: status === 'CONFIRMED' ? 'enforcement' : null,
  });
});
