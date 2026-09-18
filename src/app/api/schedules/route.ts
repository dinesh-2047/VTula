import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Schedule from '@/models/Schedule';
import Application from '@/models/Application';
import Instrument from '@/models/Instrument';
import User from '@/models/User';
import {
  handle,
  ok,
  requireAuth,
  requireOfficial,
  BadRequest,
  Conflict,
  NotFound,
  Forbidden,
  isOfficial,
  scopeFilter,
  canAccessRecord,
} from '@/lib/rbac';
import { transitionApplication } from '@/lib/workflow';
import { recommendAssignees } from '@/lib/assignment';
import { notifications } from '@/lib/notify';
import { auditAction } from '@/lib/audit';
import { INSPECTOR_ROLES, type Role } from '@/lib/constants';
import type { IApplication } from '@/models/Application';

/**
 * Inspection scheduling — step 6 of the workflow in the spec, which had no
 * implementation at all. `scheduledDate` sat on the application and nothing ever
 * wrote it; `assignedTo` was only filled in retroactively at approval time, so
 * "who is going out, and when" existed nowhere.
 *
 * Creating a schedule is what moves an application from APPROVED_FOR_SCHEDULING
 * to SCHEDULED — the two happen in one request, so an application can never be
 * marked scheduled with no slot, or hold a slot without being marked.
 *
 * Assignment goes through `recommendAssignees`, and the reasons it gave are
 * stored on the schedule. The spec is explicit that the system may not make
 * unexplained decisions: an officer picks the assignee, and the record says why
 * that person was suggested.
 */

const MAX_LIMIT = 100;

/** The four things `PATCH` can do to a slot. */
type ScheduleAction = 'reschedule' | 'cancel' | 'start' | 'no_show';

/**
 * An id out of a field that may or may not have been populated.
 *
 * `applicationId.ownerId` and `schedule.assignedTo` are both populated for the
 * page and both compared against the caller's id below, so neither can be
 * stringified naively — `String({...})` is `'[object Object]'`, which would match
 * nobody and silently strip every action from the response.
 */
function idOf(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object' && '_id' in (value as object)) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
}

/**
 * Which of them *this* user may do to *this* slot.
 *
 * Computed here rather than in the page, because the page would otherwise have to
 * restate the guards in `PATCH` — who is the assignee, who is the owner, which
 * statuses are closed — and the two copies would drift the first time one of them
 * changed. Every other surface in this system renders the server's answer to
 * "what can I do next" (`availableTransitions` on an application, `allowedNextStatuses`
 * on an enforcement case); a slot is no different.
 *
 * `reason` is reported alongside so the page knows which actions need a note
 * before it opens the form, rather than discovering it from a 400.
 */
function actionsFor(
  user: { id: string; role: Role },
  schedule: { assignedTo?: unknown; status: string },
  application: { ownerId?: unknown; status?: string }
): { action: ScheduleAction; reasonRequired: boolean }[] {
  // A completed or cancelled slot takes no further action — `PATCH` refuses both
  // with SLOT_CLOSED. `NO_SHOW` is deliberately not in that list, here or there:
  // rescheduling the missed slot is the only way back, because `POST` will not open
  // a second slot while the application still sits at SCHEDULED.
  if (['COMPLETED', 'CANCELLED'].includes(schedule.status)) return [];

  const isAssignee = idOf(schedule.assignedTo) === user.id;
  const isOwner = idOf(application.ownerId) === user.id;
  const official = isOfficial(user.role);

  const actions: { action: ScheduleAction; reasonRequired: boolean }[] = [];

  // Moving a date always needs a reason: a reschedule shifts the SLA clock, and
  // "why" is what the owner is later shown in the timeline.
  if (isOwner || official) actions.push({ action: 'reschedule', reasonRequired: true });

  // After a missed visit, re-booking is the whole of what is left to do.
  if (schedule.status === 'NO_SHOW') return actions;

  // An owner cancelling is asking to re-book, so they must say why. An officer
  // cancelling may be withdrawing a slot for reasons already on the file.
  if (isOwner) actions.push({ action: 'cancel', reasonRequired: true });
  else if (official) actions.push({ action: 'cancel', reasonRequired: false });

  /*
   * Starting is only meaningful while the visit has not already begun, and only
   * while the application is at or has reached the inspection stage.
   *
   * `PATCH` moves a SCHEDULED application to INSPECTION_IN_PROGRESS and, from any
   * other status, leaves it alone — so INSPECTION_IN_PROGRESS is included here too.
   * Excluding it would leave a slot stuck reading "Confirmed" for the rest of its
   * life whenever the application had already been advanced by some other route,
   * with no way for the inspector on site to correct the record.
   */
  if (
    (isAssignee || official) &&
    schedule.status !== 'IN_PROGRESS' &&
    ['SCHEDULED', 'INSPECTION_IN_PROGRESS'].includes(application.status ?? '')
  ) {
    actions.push({ action: 'start', reasonRequired: false });
  }

  if (isAssignee || official) actions.push({ action: 'no_show', reasonRequired: true });

  return actions;
}

export const GET = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const sp = new URL(req.url).searchParams;

  const scope = scopeFilter(user, {
    stateField: 'location.state',
    districtField: 'location.district',
    assigneeField: 'assignedTo',
  });

  const filter: Record<string, unknown> = { ...scope };

  // An owner has no jurisdiction and is not an assignee, so `scopeFilter` denies
  // them everything. They see the slots for their own applications instead.
  if (!isOfficial(user.role)) {
    const own = await Application.find({ ownerId: user.id }).select('_id').lean();
    delete filter._id;
    filter.applicationId = { $in: own.map((a) => a._id) };
  }

  const status = sp.get('status');
  if (status) filter.status = { $in: status.split(',').map((s) => s.trim()) };
  else filter.status = { $nin: ['CANCELLED'] };

  if (sp.get('mine') === 'true') filter.assignedTo = new Types.ObjectId(user.id);

  const from = sp.get('from');
  const to = sp.get('to');
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from && !Number.isNaN(Date.parse(from))) range.$gte = new Date(from);
    if (to && !Number.isNaN(Date.parse(to))) range.$lte = new Date(to);
    if (Object.keys(range).length) filter.scheduledDate = range;
  }

  const limit = Math.min(Number(sp.get('limit')) || 50, MAX_LIMIT);

  const [schedules, total] = await Promise.all([
    Schedule.find(filter)
      // `ownerId` and the application's own status are selected because the
      // per-slot action list below needs both. The owner is nested-populated so an
      // inspector on the way to a site knows whose site it is and how to reach
      // them — the address alone does not tell you who to ask for at the counter.
      .populate({
        path: 'applicationId',
        select: 'applicationNo type status dueDate ownerId',
        populate: { path: 'ownerId', select: 'name organizationName phone' },
      })
      .populate('instrumentId', 'type brand model serialNo address')
      .populate('assignedTo', 'name role designation officerCode phone')
      .sort({ scheduledDate: 1 })
      .limit(limit)
      .lean(),
    Schedule.countDocuments(filter),
  ]);

  return ok({
    schedules: schedules.map((s) => {
      const app = (s.applicationId ?? {}) as { ownerId?: unknown; status?: string };
      return {
        ...s,
        /*
         * The assignment rationale is withheld from the business.
         *
         * It is a workload note about a named officer — "carrying 3 open
         * inspections", "nearest available in the district" — written for the
         * supervisor who signs off the assignment. It is not the owner's business
         * how thinly the district is staffed, and it says nothing about their
         * instrument.
         */
        assignmentRationale: isOfficial(user.role) ? s.assignmentRationale : undefined,
        actions: actionsFor(user, s as unknown as { assignedTo?: unknown; status: string }, app),
      };
    }),
    total,
    limit,
  });
});

/**
 * Books a slot and moves the application to SCHEDULED.
 *
 * `assignedTo` is optional: without it the best-ranked candidate is taken, which
 * is what the "auto-assign" action in the officer queue does.
 */
export const POST = handle(async (req: NextRequest) => {
  const user = await requireOfficial('schedule.create');

  const body = (await req.json()) as {
    applicationId?: string;
    assignedTo?: string;
    scheduledDate?: string;
    slotStart?: string;
    slotEnd?: string;
    note?: string;
  };

  const { applicationId } = body;
  if (!applicationId || !Types.ObjectId.isValid(applicationId)) {
    throw BadRequest('An application must be identified', 'APPLICATION_REQUIRED');
  }

  if (!body.scheduledDate || Number.isNaN(Date.parse(body.scheduledDate))) {
    throw BadRequest('A valid inspection date is required', 'DATE_REQUIRED');
  }

  const scheduledDate = new Date(body.scheduledDate);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (scheduledDate < startOfToday) {
    throw BadRequest('An inspection cannot be scheduled in the past', 'DATE_IN_PAST');
  }

  const application = await Application.findById(applicationId);
  if (!application) throw NotFound('No such application');

  if (
    !canAccessRecord(user, {
      ownerId: application.ownerId,
      assignedTo: application.assignedTo,
      state: application.jurisdiction?.state,
      district: application.jurisdiction?.district,
    })
  ) {
    throw NotFound('No such application');
  }

  if (application.status !== 'APPROVED_FOR_SCHEDULING') {
    throw Conflict(
      `Application ${application.applicationNo} is ${application.status} — only an application approved for scheduling can be booked.`,
      'NOT_SCHEDULABLE'
    );
  }

  const existing = await Schedule.findOne({
    applicationId: application._id,
    status: { $nin: ['CANCELLED', 'COMPLETED', 'NO_SHOW'] },
  }).select('_id scheduledDate');
  if (existing) {
    throw Conflict(
      'This application already has a live inspection slot. Reschedule that one instead of creating a second.',
      'ALREADY_SCHEDULED'
    );
  }

  const instrument = await Instrument.findById(application.instrumentId).select(
    'type brand model serialNo address installationState installationDistrict gpsCoordinates'
  );
  if (!instrument) throw BadRequest('The instrument for this application no longer exists', 'NO_INSTRUMENT');

  const candidates = await recommendAssignees({
    application: application as unknown as Pick<IApplication, 'jurisdiction' | 'instrumentId' | 'type'>,
    instrumentType: instrument.type,
    targetDate: scheduledDate,
  });

  let chosen = candidates[0];

  if (body.assignedTo) {
    if (!Types.ObjectId.isValid(body.assignedTo)) {
      throw BadRequest('That is not a valid officer id', 'INVALID_ASSIGNEE');
    }
    const named = candidates.find((c) => c.userId === body.assignedTo);
    if (named) {
      chosen = named;
    } else {
      // A deliberate override of the recommendation is allowed — an officer may
      // know something the ranking does not — but the person must still be a real
      // inspector in this jurisdiction, and the override is recorded as such.
      const officer = await User.findById(body.assignedTo).select(
        'name role designation state district isActive approvalStatus'
      );
      if (!officer || !INSPECTOR_ROLES.includes(officer.role as Role) || !officer.canSignIn()) {
        throw BadRequest(
          'That person cannot be assigned an inspection',
          'INVALID_ASSIGNEE'
        );
      }
      if (
        officer.role !== 'Admin' &&
        officer.state &&
        officer.state !== application.jurisdiction?.state
      ) {
        throw BadRequest(
          `${officer.name} is posted in ${officer.state} and cannot inspect in ${application.jurisdiction?.state}`,
          'OUT_OF_JURISDICTION'
        );
      }
      chosen = {
        userId: String(officer._id),
        name: officer.name,
        role: officer.role as Role,
        designation: officer.designation,
        state: officer.state,
        district: officer.district,
        score: 0,
        reasons: [`Assigned manually by ${user.role} outside the recommended list`],
        openLoad: 0,
        loadOnDate: 0,
        categoryApproved: false,
      };
    }
  }

  if (!chosen) {
    throw Conflict(
      `No inspector is available in ${application.jurisdiction?.district}, ${application.jurisdiction?.state} for that date. Choose another date, or ask the State Admin to post an officer to this district.`,
      'NO_ASSIGNEE_AVAILABLE'
    );
  }

  const schedule = await Schedule.create({
    applicationId: application._id,
    instrumentId: instrument._id,
    assignedTo: new Types.ObjectId(chosen.userId),
    assignedToRole: chosen.role,
    assignedBy: new Types.ObjectId(user.id),
    scheduledDate,
    slotStart: body.slotStart?.trim(),
    slotEnd: body.slotEnd?.trim(),
    location: {
      address: instrument.address,
      district: instrument.installationDistrict,
      state: instrument.installationState,
      gps: instrument.gpsCoordinates,
    },
    status: 'CONFIRMED',
    ownerPreferredDate: application.preferredDate,
    // Stored so the choice can be explained later, to the owner or in an audit.
    assignmentRationale: chosen.reasons,
    statusReason: body.note?.trim(),
  });

  // One request, one outcome: the slot and the status move together.
  await transitionApplication(
    application as unknown as Parameters<typeof transitionApplication>[0],
    'SCHEDULED',
    user,
    {
      reason: body.note?.trim() || `Inspection booked with ${chosen.name} for ${scheduledDate.toDateString()}`,
      patch: {
        scheduledDate,
        assignedTo: new Types.ObjectId(chosen.userId),
        assignedType: chosen.role,
        scheduleId: schedule._id,
      },
      headers: req.headers,
    }
  );

  await Promise.all([
    notifications.inspectionScheduled(
      String(application.ownerId),
      application.applicationNo,
      String(application._id),
      scheduledDate
    ),
    notifications.assignmentReceived(
      chosen.userId,
      application.applicationNo,
      String(application._id),
      scheduledDate
    ),
  ]).catch((err) => console.error('[schedules] notification failed', err));

  await Schedule.updateOne(
    { _id: schedule._id },
    { notifiedOwnerAt: new Date(), notifiedAssigneeAt: new Date() }
  );

  return ok(
    {
      schedule: {
        id: String(schedule._id),
        scheduledDate,
        slotStart: schedule.slotStart,
        slotEnd: schedule.slotEnd,
        status: schedule.status,
      },
      assignee: {
        id: chosen.userId,
        name: chosen.name,
        role: chosen.role,
        designation: chosen.designation,
      },
      // Returned so the officer sees the ranking that produced the choice.
      rationale: chosen.reasons,
      alternatives: candidates
        .filter((c) => c.userId !== chosen.userId)
        .slice(0, 4)
        .map((c) => ({ id: c.userId, name: c.name, role: c.role, score: c.score, loadOnDate: c.loadOnDate })),
      application: { id: String(application._id), status: application.status },
    },
    201
  );
});

/**
 * Reschedule, confirm, cancel or mark a no-show.
 *
 * A reschedule keeps the slot record and pushes the old date into `history`,
 * because "this inspection was moved twice" is itself information an owner and an
 * auditor are entitled to see.
 */
export const PATCH = handle(async (req: NextRequest) => {
  const user = await requireAuth();

  const body = (await req.json()) as {
    scheduleId?: string;
    action?: 'reschedule' | 'cancel' | 'start' | 'no_show';
    scheduledDate?: string;
    reason?: string;
  };

  const { scheduleId, action } = body;
  if (!scheduleId || !Types.ObjectId.isValid(scheduleId)) {
    throw BadRequest('A schedule must be identified', 'SCHEDULE_REQUIRED');
  }
  if (!action) throw BadRequest('An action is required', 'ACTION_REQUIRED');

  const schedule = await Schedule.findById(scheduleId);
  if (!schedule) throw NotFound('No such inspection slot');

  const application = await Application.findById(schedule.applicationId);
  if (!application) throw NotFound('No such inspection slot');

  const isAssignee = String(schedule.assignedTo) === user.id;
  const isOwner = String(application.ownerId) === user.id;

  if (
    !isAssignee &&
    !canAccessRecord(user, {
      ownerId: application.ownerId,
      state: schedule.location?.state,
      district: schedule.location?.district,
    })
  ) {
    throw NotFound('No such inspection slot');
  }

  if (['COMPLETED', 'CANCELLED'].includes(schedule.status)) {
    throw Conflict(`This slot is already ${schedule.status.toLowerCase()}`, 'SLOT_CLOSED');
  }

  const reason = body.reason?.trim();
  const previous = { scheduledDate: schedule.scheduledDate, status: schedule.status };

  const pushHistory = () => {
    schedule.history = [
      ...(schedule.history ?? []),
      {
        scheduledDate: previous.scheduledDate,
        status: previous.status,
        changedBy: new Types.ObjectId(user.id),
        changedAt: new Date(),
        reason,
      },
    ];
  };

  switch (action) {
    case 'reschedule': {
      // An owner may ask for a different date; an officer may move it. Either way
      // a reason is required, because a moved inspection affects the SLA clock.
      if (!reason || reason.length < 5) {
        throw BadRequest('Give a reason for moving the inspection', 'REASON_REQUIRED');
      }
      if (!body.scheduledDate || Number.isNaN(Date.parse(body.scheduledDate))) {
        throw BadRequest('A valid new date is required', 'DATE_REQUIRED');
      }
      const next = new Date(body.scheduledDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (next < today) throw BadRequest('The new date is in the past', 'DATE_IN_PAST');

      pushHistory();
      schedule.scheduledDate = next;
      schedule.status = 'RESCHEDULED';
      schedule.statusReason = reason;
      schedule.notifiedOwnerAt = undefined;
      await schedule.save();

      await Application.updateOne({ _id: application._id }, { scheduledDate: next });

      /*
       * Both sides, minus whoever did it.
       *
       * This used to notify the owner unconditionally, which meant an owner who
       * asked for a new date was told about their own request, and the inspector who
       * now has to travel on a different day was told nothing at all.
       */
      await Promise.all([
        String(application.ownerId) === user.id
          ? Promise.resolve()
          : notifications.inspectionMoved(
              String(application.ownerId),
              application.applicationNo,
              String(application._id),
              next,
              reason
            ),
        String(schedule.assignedTo) === user.id
          ? Promise.resolve()
          : notifications.inspectionMoved(
              String(schedule.assignedTo),
              application.applicationNo,
              String(application._id),
              next,
              reason
            ),
      ]).catch((err) => console.error('[schedules] reschedule notification failed', err));

      break;
    }

    case 'cancel': {
      if (isOwner) {
        // An owner cancelling a slot is a request to re-book, not a withdrawal of
        // the application, so the application goes back to the scheduling queue.
        if (!reason || reason.length < 5) {
          throw BadRequest('Tell the office why the visit cannot go ahead', 'REASON_REQUIRED');
        }
      } else if (!isOfficial(user.role)) {
        throw Forbidden('You cannot cancel this inspection');
      }

      pushHistory();
      schedule.status = 'CANCELLED';
      schedule.statusReason = reason;
      await schedule.save();

      /*
       * The other side is told. An owner who cancelled knows already; the inspector
       * who was going to travel to the site does not, and an office that withdraws
       * a slot owes the business the reason. Previously neither was notified and the
       * appointment simply vanished from the other party's calendar.
       */
      await notifications
        .inspectionCancelled(
          isOwner ? String(schedule.assignedTo) : String(application.ownerId),
          application.applicationNo,
          String(application._id),
          String(schedule._id),
          reason
        )
        .catch((err) => console.error('[schedules] cancel notification failed', err));

      if (application.status === 'SCHEDULED') {
        await transitionApplication(
          application as unknown as Parameters<typeof transitionApplication>[0],
          'APPROVED_FOR_SCHEDULING',
          user,
          {
            reason: reason || 'Inspection slot cancelled; awaiting a new date',
            patch: { scheduledDate: undefined, scheduleId: undefined },
            headers: req.headers,
          }
        );
      }
      break;
    }

    case 'start': {
      if (!isAssignee && !isOfficial(user.role)) {
        throw Forbidden('Only the assigned inspector can start this inspection');
      }
      pushHistory();
      schedule.status = 'IN_PROGRESS';
      await schedule.save();

      if (application.status === 'SCHEDULED') {
        await transitionApplication(
          application as unknown as Parameters<typeof transitionApplication>[0],
          'INSPECTION_IN_PROGRESS',
          user,
          { headers: req.headers }
        );
      }
      break;
    }

    case 'no_show': {
      if (!isAssignee && !isOfficial(user.role)) {
        throw Forbidden('Only the assigned inspector can record a no-show');
      }
      if (!reason || reason.length < 5) {
        throw BadRequest(
          'Record what happened at the site — a no-show goes on the business’s compliance history',
          'REASON_REQUIRED'
        );
      }
      pushHistory();
      schedule.status = 'NO_SHOW';
      schedule.statusReason = reason;
      await schedule.save();

      // The business is told what was recorded and what to do about it. This is the
      // one consequence in the system that lands on a compliance record, and it was
      // being written without the business ever hearing of it.
      await notifications
        .inspectionMissed(
          String(application.ownerId),
          application.applicationNo,
          String(application._id),
          String(schedule._id),
          reason
        )
        .catch((err) => console.error('[schedules] no-show notification failed', err));
      break;
    }

    default:
      throw BadRequest(`Unknown action "${action}"`, 'UNKNOWN_ACTION');
  }

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    `schedule.${action}`,
    { type: 'Schedule', id: schedule._id, label: application.applicationNo },
    {
      details: reason,
      changes: { from: previous, to: { scheduledDate: schedule.scheduledDate, status: schedule.status } },
      headers: req.headers,
    }
  );

  return ok({
    schedule: {
      id: String(schedule._id),
      status: schedule.status,
      scheduledDate: schedule.scheduledDate,
      reschedules: schedule.history?.length ?? 0,
    },
    application: { id: String(application._id), status: application.status },
  });
});
