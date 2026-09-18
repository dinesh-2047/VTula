import { NextRequest } from 'next/server';
import dbConnect from '@/lib/db';
import User from '@/models/User';
import { handle, ok, optionalAuth, requireAdmin, hasGlobalScope, HttpError } from '@/lib/rbac';
import { runLifecycleSweep } from '@/lib/lifecycle';
import { runRiskSweep } from '@/lib/risk';
import { persistComplianceScore } from '@/lib/compliance';
import { writeAudit } from '@/lib/audit';
import { safeEqual } from '@/lib/utils';
import { type Role } from '@/lib/constants';

/**
 * The scheduled sweep: expiry reminders, status refresh, risk detection and
 * compliance scores.
 *
 * This endpoint is what makes the spec's proactive alert cadence real. The
 * 60/30/7-day reminders and the expired-state alert are computed by
 * `runLifecycleSweep()`, which nothing called — so a business only ever learned
 * about an impending expiry if they happened to open the notifications page, and a
 * certificate that had expired kept describing itself as active.
 *
 * It is designed to be hit by a scheduler (Vercel Cron, GitHub Actions, cron +
 * curl). Two ways in:
 *
 *  - `Authorization: Bearer <CRON_SECRET>` for an unattended run. The comparison is
 *    constant-time, and with no `CRON_SECRET` configured the unattended path is
 *    refused outright rather than left open.
 *  - a signed-in StateAdmin or Admin, for a manual run. A StateAdmin's run is
 *    confined to their own state.
 *
 * Everything it calls is idempotent — reminders are deduplicated per offset and
 * status writes are conditional — so running it twice an hour is harmless.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Trigger = { kind: 'cron' } | { kind: 'manual'; actorId: string; role: Role; state?: string };

/** Establishes who is asking, and what jurisdiction they may sweep. */
async function authorize(req: NextRequest): Promise<Trigger> {
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const secret = process.env.CRON_SECRET;

  if (presented) {
    if (!secret) {
      throw new HttpError(
        503,
        'Scheduled runs are not enabled on this server because CRON_SECRET is not configured.',
        'CRON_NOT_CONFIGURED'
      );
    }
    if (!safeEqual(presented, secret)) {
      throw new HttpError(401, 'Invalid scheduler credential', 'BAD_CRON_SECRET');
    }
    return { kind: 'cron' };
  }

  // No bearer token: fall back to an interactive administrator.
  const user = await optionalAuth();
  if (!user) {
    throw new HttpError(
      401,
      'This endpoint needs either a scheduler credential or an administrator session',
      'UNAUTHENTICATED'
    );
  }

  const admin = await requireAdmin('alerts.run');
  return { kind: 'manual', actorId: admin.id, role: admin.role, state: admin.state };
}

async function runSweeps(state?: string) {
  const startedAt = Date.now();

  // Lifecycle first: risk detection reads certificate status, so it should see the
  // freshly-recomputed values rather than yesterday's.
  const lifecycle = await runLifecycleSweep(state);
  const risk = await runRiskSweep(state);

  /*
   * Compliance scores are recomputed for owners whose picture just changed. Doing
   * every owner in the country on every run would be wasteful; doing none would
   * leave the score stale, which matters because it is shown to the business as a
   * reason to act.
   */
  const ownerQuery: Record<string, unknown> = { role: 'Owner', isActive: true };
  if (state) ownerQuery.state = state;

  const owners = await User.find(ownerQuery).select('_id organizationId').limit(500).lean();

  let scored = 0;
  const scoreErrors: string[] = [];
  for (const owner of owners) {
    try {
      // `persistComplianceScore` recomputes and writes the snapshot in one step.
      await persistComplianceScore(owner._id, owner.organizationId);
      scored += 1;
    } catch (err) {
      scoreErrors.push(`${owner._id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    scope: state ?? 'national',
    durationMs: Date.now() - startedAt,
    lifecycle,
    risk,
    compliance: { ownersScored: scored, errors: scoreErrors.slice(0, 10) },
  };
}

export const POST = handle(async (req: NextRequest) => {
  await dbConnect();
  const trigger = await authorize(req);

  // A StateAdmin sweeps their own state; a system Admin or the scheduler sweeps
  // everything unless a state is named.
  const requested = new URL(req.url).searchParams.get('state') ?? undefined;
  const state =
    trigger.kind === 'manual' && !hasGlobalScope(trigger.role) ? trigger.state : requested;

  const report = await runSweeps(state);

  await writeAudit({
    action: 'alerts.sweep',
    userId: trigger.kind === 'manual' ? trigger.actorId : undefined,
    userRole: trigger.kind === 'manual' ? trigger.role : undefined,
    outcome: 'SUCCESS',
    details: `${trigger.kind} sweep of ${report.scope}: ${report.lifecycle.remindersSent} reminders, ${report.lifecycle.markedExpired} expired, ${report.risk.detected} risk flags, ${report.compliance.ownersScored} scores in ${report.durationMs}ms`,
    headers: req.headers,
  });

  return ok({ report, triggeredBy: trigger.kind });
});

/**
 * Vercel Cron and several other schedulers issue a GET, so the same work is
 * reachable that way. Deliberately not cached — `force-dynamic` above.
 */
export const GET = POST;
