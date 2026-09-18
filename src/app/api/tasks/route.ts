import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Application from '@/models/Application';
import Inspection from '@/models/Inspection';
import Schedule from '@/models/Schedule';
import RiskFlag from '@/models/RiskFlag';
import { handle, ok, requireOfficial, scopeFilter } from '@/lib/rbac';
import { availableTransitions } from '@/lib/workflow';
import { OFFICER_QUEUE_STATUSES, type ApplicationStatus, APPLICATION_STATUSES } from '@/lib/constants';

/**
 * The officer / GATC work queue.
 *
 * This endpoint used to be the single worst hole in the system:
 *
 *  - **GET** read `session.user.role` into a variable it then never used, and
 *    ran `Application.find({})` — so any signed-in account, including a business
 *    owner, received every application in the country, populated with other
 *    businesses' owner names, emails and phone numbers.
 *  - **POST** had no role check whatsoever. Any authenticated caller could send
 *    `{ applicationId, verdict: 'Approve' }` and the route would write an
 *    approval and mint a real HMAC-signed certificate with a hardcoded one-year
 *    validity, no audit entry and no notification.
 *
 * It is now read-only and officials-only. Acting on a task happens through the
 * endpoints that own those concerns and audit them:
 *   - `POST /api/applications/[id]/transition` — stage changes and decisions
 *   - `POST /api/inspections`                  — recording an inspection
 *   - `POST /api/schedules`                    — assigning and scheduling
 */

export const GET = handle(async (req: NextRequest) => {
  const user = await requireOfficial('tasks.list');
  const sp = req.nextUrl.searchParams;

  const scope = scopeFilter(user, {
    stateField: 'jurisdiction.state',
    districtField: 'jurisdiction.district',
    assigneeField: 'assignedTo',
  });

  const query: Record<string, unknown> = { ...scope };

  const statusParam = sp.get('status');
  if (statusParam && statusParam !== 'all') {
    const wanted = statusParam
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is ApplicationStatus =>
        (APPLICATION_STATUSES as readonly string[]).includes(s)
      );
    query.status = { $in: wanted.length > 0 ? wanted : OFFICER_QUEUE_STATUSES };
  } else {
    query.status = { $in: OFFICER_QUEUE_STATUSES };
  }

  if (sp.get('assignedToMe') === 'true') query.assignedTo = new Types.ObjectId(user.id);

  const type = sp.get('type');
  if (type && type !== 'all') query.type = type;

  const search = sp.get('search')?.trim();
  if (search) {
    query.applicationNo = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }

  const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 50));

  const applications = await Application.find(query)
    .populate('instrumentId', 'type brand model serialNo capacity accuracyClass address installationDistrict installationState gpsCoordinates capacityValue capacityUnit')
    .populate('ownerId', 'name organizationName phone email')
    .populate('assignedTo', 'name role designation')
    // Highest advisory priority first. The score is explainable via
    // `priorityReasons`, which the UI shows — the order is never unexplained.
    .sort({ priorityScore: -1, dueDate: 1, createdAt: 1 })
    .limit(limit)
    .lean();

  const appIds = applications.map((a) => a._id);

  const [inspections, schedules, flags] = await Promise.all([
    Inspection.find({ applicationId: { $in: appIds }, isSuperseded: false })
      .select('_id applicationId inspectionNo version result isSubmitted inspectedAt readings gpsDriftMetres')
      .lean(),
    Schedule.find({ applicationId: { $in: appIds }, status: { $nin: ['CANCELLED'] } })
      .select('_id applicationId scheduledDate slotStart slotEnd status assignedTo assignedToRole assignmentRationale')
      .populate('assignedTo', 'name role designation')
      .lean(),
    RiskFlag.find({ applicationId: { $in: appIds }, status: { $in: ['OPEN', 'REVIEWING', 'CONFIRMED'] } })
      .select('applicationId flagType level score title reasons recommendedAction status')
      .lean(),
  ]);

  const byApp = <T extends { applicationId: Types.ObjectId }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const r of rows) {
      const key = String(r.applicationId);
      const list = map.get(key);
      if (list) list.push(r);
      else map.set(key, [r]);
    }
    return map;
  };

  const inspectionMap = byApp(inspections as { applicationId: Types.ObjectId }[]);
  const scheduleMap = byApp(schedules as unknown as { applicationId: Types.ObjectId }[]);
  const flagMap = byApp(flags as { applicationId: Types.ObjectId }[]);

  const tasks = applications.map((a) => ({
    ...a,
    inspection: inspectionMap.get(String(a._id))?.[0] ?? null,
    schedule: scheduleMap.get(String(a._id))?.[0] ?? null,
    riskFlags: flagMap.get(String(a._id)) ?? [],
    // Drives which buttons the UI renders, so the client never offers an action
    // the server would refuse.
    availableTransitions: availableTransitions(
      a as unknown as Parameters<typeof availableTransitions>[0],
      user
    ),
  }));

  const counts = await Application.aggregate<{ _id: string; count: number }>([
    { $match: { ...scope, status: { $in: OFFICER_QUEUE_STATUSES } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  return ok({
    tasks,
    countsByStatus: Object.fromEntries(counts.map((c) => [c._id, c.count])),
    scope: {
      role: user.role,
      state: user.state ?? null,
      district: user.district ?? null,
    },
  });
});
