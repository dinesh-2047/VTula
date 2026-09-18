import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import ComplianceScore from '@/models/ComplianceScore';
import User, { type IUser } from '@/models/User';
import {
  handle,
  ok,
  requireAuth,
  NotFound,
  BadRequest,
  Forbidden,
  isOfficial,
  hasGlobalScope,
  type AuthedUser,
} from '@/lib/rbac';
import { DECISION_ROLES, type Role } from '@/lib/constants';
import { computeComplianceScore, persistComplianceScore } from '@/lib/compliance';
import { writeAudit } from '@/lib/audit';

/**
 * Compliance Health Score.
 *
 * The spec asks for "a single, explainable number" a business can act on instead
 * of a wall of statuses. The engine in `src/lib/compliance.ts` produced exactly
 * that — a score, a grade, a per-component breakdown and ordered recommendations —
 * and the only thing that ever called it was the nightly alerts sweep. No page
 * could read it, so in practice a business never saw its own score.
 *
 * Two audiences, deliberately different answers:
 *
 *  - **An owner** gets their own score, computed live, with the trend behind it.
 *    Live rather than from the last snapshot, because a business that has just
 *    renewed a certificate should see the score move.
 *  - **A supervising officer** — an LMO, a State Administrator or a system
 *    Administrator — gets a jurisdiction-scoped list, worst first, because their
 *    question is "who needs attention", not "how am I doing". A testing centre is
 *    not one of these; see `supervises` below.
 *
 * The score is advisory. It ranks attention; it never decides an application.
 */

export const dynamic = 'force-dynamic';

/**
 * Who may read whose score.
 *
 * `isOfficial` was the gate here, and it is too wide: it includes `GATC` and
 * `GATCTechnician`. A testing centre has no supervisory function over a business —
 * its work is the instrument in front of it, which reaches it as an assigned task.
 * Treating it as an official handed every laboratory in a state a roster of every
 * business in that state, worst first, with the department's own recommendations
 * attached. That is a jurisdiction-wide fishing licence for a role that only ever
 * needed the instrument.
 *
 * `DECISION_ROLES` is the correct set. The roles that take decisions on
 * applications are the roles that supervise compliance.
 */
function supervises(role: Role): boolean {
  return DECISION_ROLES.includes(role);
}

/** One wording for the refusal, so the two handlers cannot drift apart. */
function notSupervisory() {
  return Forbidden(
    'A compliance score is read by the Legal Metrology office that supervises the business. A testing centre sees the instruments assigned to it, not a business’s compliance record.'
  );
}

/** Resolves the owner whose score is being asked for, enforcing jurisdiction. */
async function resolveSubject(
  user: AuthedUser,
  requestedId: string | null
): Promise<IUser & { _id: Types.ObjectId }> {
  // An owner may only ever ask about themselves, regardless of what they send.
  if (!isOfficial(user.role)) {
    if (requestedId && requestedId !== user.id) {
      throw NotFound('No such business');
    }
    const self = await User.findById(user.id).lean<IUser & { _id: Types.ObjectId }>();
    if (!self) throw NotFound('No such business');
    return self;
  }

  /*
   * Re-checked here as well as in the handlers. A future caller that reaches this
   * function by another path should not be able to read a score by supplying an
   * `ownerId`, and a single guard at the top of GET would not have stopped it.
   */
  if (!supervises(user.role)) throw notSupervisory();

  if (!requestedId) {
    throw BadRequest(
      'Name the business whose compliance score you want with ?ownerId=',
      'OWNER_REQUIRED'
    );
  }
  if (!Types.ObjectId.isValid(requestedId)) throw NotFound('No such business');

  const target = await User.findById(requestedId).lean<IUser & { _id: Types.ObjectId }>();
  if (!target) throw NotFound('No such business');

  /*
   * 404 rather than 403 for a business outside the officer's jurisdiction. A 403
   * would confirm the record exists, which is itself information an officer in
   * another state is not entitled to.
   */
  if (!hasGlobalScope(user.role)) {
    if (user.state && target.state !== user.state) throw NotFound('No such business');
    if (user.role === 'LMO' && user.district && target.district !== user.district) {
      throw NotFound('No such business');
    }
  }

  return target;
}

export const GET = handle(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireAuth();
  const sp = req.nextUrl.searchParams;

  // Refused before any query runs, so a laboratory gets the reason rather than an
  // empty list it would read as "no businesses here".
  if (isOfficial(user.role) && !supervises(user.role)) throw notSupervisory();

  /* --- Officer view: who needs attention -------------------------------- */
  if (supervises(user.role) && !sp.get('ownerId')) {
    /*
     * Read from the snapshots rather than recomputing, because computing a score
     * involves several queries per business and an officer's list could be
     * hundreds of them. The snapshot's age is reported so a stale figure is
     * visibly stale rather than silently wrong.
     */
    const ownerQuery: Record<string, unknown> = { role: 'Owner' };
    if (!hasGlobalScope(user.role)) {
      if (user.state) ownerQuery.state = user.state;
      if (user.role === 'LMO' && user.district) ownerQuery.district = user.district;
    }

    const owners = await User.find(ownerQuery)
      .select('_id name organizationName state district')
      .limit(500)
      .lean<{ _id: Types.ObjectId; name: string; organizationName?: string; state?: string; district?: string }[]>();

    if (owners.length === 0) {
      return ok({
        view: 'jurisdiction',
        businesses: [],
        summary: { assessed: 0, unassessed: 0, averageScore: null, byGrade: {} },
        note: 'No businesses are registered in your jurisdiction yet.',
      });
    }

    // Latest snapshot per owner.
    const latest = await ComplianceScore.aggregate<{
      _id: Types.ObjectId;
      score: number;
      grade: string;
      stats: Record<string, number>;
      computedAt: Date;
      recommendations: string[];
    }>([
      { $match: { ownerId: { $in: owners.map((o) => o._id) } } },
      { $sort: { computedAt: -1 } },
      {
        $group: {
          _id: '$ownerId',
          score: { $first: '$score' },
          grade: { $first: '$grade' },
          stats: { $first: '$stats' },
          computedAt: { $first: '$computedAt' },
          recommendations: { $first: '$recommendations' },
        },
      },
    ]);

    const byOwner = new Map(latest.map((r) => [String(r._id), r]));

    const businesses = owners
      .map((o) => {
        const snap = byOwner.get(String(o._id));
        return {
          ownerId: String(o._id),
          name: o.name,
          organizationName: o.organizationName,
          state: o.state,
          district: o.district,
          // Null, not zero — "never assessed" and "scored zero" are different
          // things, and a nightly sweep that has not reached a business yet must
          // not make it look non-compliant.
          score: snap?.score ?? null,
          grade: snap?.grade ?? null,
          stats: snap?.stats ?? null,
          topRecommendation: snap?.recommendations?.[0],
          computedAt: snap?.computedAt ?? null,
          stale: snap
            ? Date.now() - new Date(snap.computedAt).getTime() > 7 * 86_400_000
            : true,
        };
      })
      // Worst first; never-assessed last, since there is nothing to act on yet.
      .sort((a, b) => (a.score ?? 101) - (b.score ?? 101));

    const assessed = businesses.filter((b) => b.score !== null);
    const byGrade: Record<string, number> = {};
    for (const b of assessed) byGrade[b.grade as string] = (byGrade[b.grade as string] ?? 0) + 1;

    return ok({
      view: 'jurisdiction',
      businesses,
      summary: {
        assessed: assessed.length,
        unassessed: businesses.length - assessed.length,
        averageScore:
          assessed.length > 0
            ? Math.round(
                (assessed.reduce((sum, b) => sum + (b.score ?? 0), 0) / assessed.length) * 10
              ) / 10
            : null,
        byGrade,
      },
      truncated: owners.length >= 500,
    });
  }

  /* --- Single business ------------------------------------------------- */
  const subject = await resolveSubject(user, sp.get('ownerId'));

  // Live, so a business that has just fixed something sees it reflected.
  const result = await computeComplianceScore(subject._id, subject.organizationId);

  // The trend behind the number, so a score is a direction and not just a value.
  const history = await ComplianceScore.find({ ownerId: subject._id })
    .sort({ computedAt: -1 })
    .limit(24)
    .select('score grade computedAt')
    .lean<{ score: number; grade: string; computedAt: Date }[]>();

  const previous = history[0];
  const delta = previous ? Math.round((result.score - previous.score) * 10) / 10 : null;

  return ok({
    view: 'business',
    business: {
      ownerId: String(subject._id),
      name: subject.name,
      organizationName: subject.organizationName,
      state: subject.state,
      district: subject.district,
    },
    score: result.score,
    grade: result.grade,
    breakdown: result.breakdown,
    stats: result.stats,
    recommendations: result.recommendations,
    trend: {
      // Oldest first, which is the order a chart wants.
      points: [...history].reverse().map((h) => ({
        score: h.score,
        grade: h.grade,
        at: h.computedAt,
      })),
      changeSinceLastSnapshot: delta,
      direction: delta === null ? 'new' : delta > 0 ? 'improving' : delta < 0 ? 'declining' : 'flat',
      lastSnapshotAt: previous?.computedAt ?? null,
    },
    computedAt: new Date(),
    isLive: true,
  });
});

/**
 * Snapshots the score, adding a point to the trend.
 *
 * Separate from GET because GET computes without writing: a business refreshing a
 * page should not manufacture trend points, or the chart becomes a record of how
 * often somebody looked at it.
 */
export const POST = handle(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireAuth();

  if (isOfficial(user.role) && !supervises(user.role)) throw notSupervisory();

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // A snapshot of one's own score needs no body.
  }

  const subject = await resolveSubject(
    user,
    typeof body.ownerId === 'string' ? body.ownerId : null
  );

  /*
   * One snapshot an hour is plenty for a trend measured in weeks, and it stops a
   * client loop from filling the collection.
   */
  const recent = await ComplianceScore.findOne({
    ownerId: subject._id,
    computedAt: { $gte: new Date(Date.now() - 3_600_000) },
  })
    .select('score grade computedAt')
    .lean<{ score: number; grade: string; computedAt: Date } | null>();

  if (recent) {
    return ok({
      score: recent.score,
      grade: recent.grade,
      computedAt: recent.computedAt,
      created: false,
      message: 'This score was assessed within the last hour, so the existing snapshot stands.',
    });
  }

  const result = await persistComplianceScore(subject._id, subject.organizationId);

  await writeAudit({
    action: 'compliance.snapshot',
    userId: user.id,
    userRole: user.role,
    resourceType: 'User',
    resourceId: String(subject._id),
    resourceLabel: subject.organizationName ?? subject.name,
    outcome: 'SUCCESS',
    details: `Compliance score ${result.score} (grade ${result.grade}) recorded for ${subject.organizationName ?? subject.name}`,
    headers: req.headers,
  });

  return ok(
    {
      score: result.score,
      grade: result.grade,
      breakdown: result.breakdown,
      stats: result.stats,
      recommendations: result.recommendations,
      computedAt: new Date(),
      created: true,
    },
    201
  );
});
