import { Types } from 'mongoose';
import Application, { type IApplication } from '@/models/Application';
import InstrumentEvent from '@/models/InstrumentEvent';
import {
  APPLICATION_TRANSITIONS,
  APPLICATION_STATUS_LABELS,
  type ApplicationStatus,
  type Role,
} from '@/lib/constants';
import { BadRequest, Forbidden, type AuthedUser } from '@/lib/rbac';
import { auditAction } from '@/lib/audit';

/**
 * Application state machine.
 *
 * The previous status set was six ad-hoc values with no transition rules at all:
 * any writer could set any status, and the UI filtered on statuses (`Submitted`,
 * `UnderReview`) the schema could never produce. This module is the single place
 * where an application's status changes, and it enforces both
 *
 *   (a) whether the transition is legal at all, and
 *   (b) whether *this* role is allowed to perform it.
 */

/** Which roles may drive each transition. */
const TRANSITION_ROLES: Partial<Record<`${ApplicationStatus}->${ApplicationStatus}`, Role[]>> = {
  'DRAFT->SUBMITTED': ['Owner'],
  'DRAFT->CANCELLED': ['Owner', 'StateAdmin', 'Admin'],

  'SUBMITTED->UNDER_REVIEW': ['LMO', 'StateAdmin', 'Admin'],
  'SUBMITTED->CANCELLED': ['Owner', 'StateAdmin', 'Admin'],

  'UNDER_REVIEW->QUERY_RAISED': ['LMO', 'StateAdmin', 'Admin'],
  'UNDER_REVIEW->APPROVED_FOR_SCHEDULING': ['LMO', 'StateAdmin', 'Admin'],
  'UNDER_REVIEW->REJECTED': ['LMO', 'StateAdmin', 'Admin'],
  'UNDER_REVIEW->CANCELLED': ['StateAdmin', 'Admin'],

  'QUERY_RAISED->RESUBMITTED': ['Owner'],
  'QUERY_RAISED->CANCELLED': ['Owner', 'StateAdmin', 'Admin'],
  'QUERY_RAISED->REJECTED': ['LMO', 'StateAdmin', 'Admin'],

  'RESUBMITTED->UNDER_REVIEW': ['LMO', 'StateAdmin', 'Admin'],
  'RESUBMITTED->CANCELLED': ['Owner', 'StateAdmin', 'Admin'],

  'APPROVED_FOR_SCHEDULING->SCHEDULED': ['LMO', 'GATC', 'StateAdmin', 'Admin'],
  'APPROVED_FOR_SCHEDULING->CANCELLED': ['StateAdmin', 'Admin'],

  'SCHEDULED->INSPECTION_IN_PROGRESS': ['LMO', 'GATC', 'GATCTechnician'],
  // An owner cancelling their own inspection slot sends the application back to
  // the scheduling queue rather than withdrawing it. `assertTransition` already
  // confines an Owner to their own applications.
  'SCHEDULED->APPROVED_FOR_SCHEDULING': ['Owner', 'LMO', 'GATC', 'StateAdmin', 'Admin'],
  'SCHEDULED->CANCELLED': ['StateAdmin', 'Admin'],

  'INSPECTION_IN_PROGRESS->INSPECTION_SUBMITTED': ['LMO', 'GATC', 'GATCTechnician'],
  'INSPECTION_IN_PROGRESS->SCHEDULED': ['LMO', 'GATC', 'StateAdmin', 'Admin'],
  'INSPECTION_IN_PROGRESS->CANCELLED': ['StateAdmin', 'Admin'],

  'INSPECTION_SUBMITTED->UNDER_DECISION': ['LMO', 'StateAdmin', 'Admin'],
  'INSPECTION_SUBMITTED->INSPECTION_IN_PROGRESS': ['LMO', 'GATC', 'StateAdmin', 'Admin'],

  // Only a Legal Metrology Officer (or an admin acting as one) may decide.
  // A GATC tests; it does not adjudicate.
  'UNDER_DECISION->APPROVED': ['LMO', 'StateAdmin', 'Admin'],
  'UNDER_DECISION->REJECTED': ['LMO', 'StateAdmin', 'Admin'],
  'UNDER_DECISION->QUERY_RAISED': ['LMO', 'StateAdmin', 'Admin'],
  'UNDER_DECISION->INSPECTION_IN_PROGRESS': ['LMO', 'StateAdmin', 'Admin'],

  'APPROVED->CERTIFICATE_GENERATED': ['LMO', 'StateAdmin', 'Admin'],
  'CERTIFICATE_GENERATED->ACTIVE': ['LMO', 'StateAdmin', 'Admin'],

  'REJECTED->DRAFT': ['Owner'],

  'ACTIVE->EXPIRED': ['StateAdmin', 'Admin'],
  'ACTIVE->SUSPENDED': ['LMO', 'StateAdmin', 'Admin'],
  'ACTIVE->REVOKED': ['LMO', 'StateAdmin', 'Admin'],
  'SUSPENDED->ACTIVE': ['LMO', 'StateAdmin', 'Admin'],
  'SUSPENDED->REVOKED': ['LMO', 'StateAdmin', 'Admin'],
};

/** Transitions that require a written reason. */
const REASON_REQUIRED: ApplicationStatus[] = [
  'QUERY_RAISED',
  'REJECTED',
  'CANCELLED',
  'SUSPENDED',
  'REVOKED',
];

export interface TransitionOptions {
  reason?: string;
  /** Set for automated transitions (alert sweeps, expiry jobs). */
  isSystem?: boolean;
  /** Extra fields to set on the application as part of the same save. */
  patch?: Partial<Record<string, unknown>>;
  headers?: Headers;
}

/** True when `to` is reachable from `from`. */
export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return (APPLICATION_TRANSITIONS[from] ?? []).includes(to);
}

/** Roles permitted to drive a specific transition. */
export function rolesForTransition(from: ApplicationStatus, to: ApplicationStatus): Role[] {
  return TRANSITION_ROLES[`${from}->${to}`] ?? [];
}

/** The transitions `user` may currently perform on `app`. */
export function availableTransitions(
  app: Pick<IApplication, 'status' | 'ownerId' | 'assignedTo'>,
  user: AuthedUser
): ApplicationStatus[] {
  const from = app.status;
  return (APPLICATION_TRANSITIONS[from] ?? []).filter((to) => {
    const roles = rolesForTransition(from, to);
    if (!roles.includes(user.role)) return false;
    // An owner-driven transition only applies to their own application.
    if (user.role === 'Owner' && String(app.ownerId) !== user.id) return false;
    return true;
  });
}

/** Throws unless the transition is both legal and permitted for this role. */
export function assertTransition(
  app: Pick<IApplication, 'status' | 'ownerId'>,
  to: ApplicationStatus,
  user: AuthedUser,
  opts: { isSystem?: boolean; reason?: string } = {}
): void {
  const from = app.status;

  if (from === to) {
    throw BadRequest(`Application is already ${APPLICATION_STATUS_LABELS[to]}`, 'NO_OP_TRANSITION');
  }

  if (!canTransition(from, to)) {
    throw BadRequest(
      `Cannot move an application from ${APPLICATION_STATUS_LABELS[from]} to ${APPLICATION_STATUS_LABELS[to]}`,
      'ILLEGAL_TRANSITION'
    );
  }

  if (!opts.isSystem) {
    const roles = rolesForTransition(from, to);
    if (!roles.includes(user.role)) {
      throw Forbidden(
        `Your role (${user.role}) cannot move an application to ${APPLICATION_STATUS_LABELS[to]}`
      );
    }
    if (user.role === 'Owner' && String(app.ownerId) !== user.id) {
      throw Forbidden('You can only act on your own applications');
    }
  }

  if (REASON_REQUIRED.includes(to) && !opts.reason?.trim()) {
    throw BadRequest(
      `A written reason is required when moving an application to ${APPLICATION_STATUS_LABELS[to]}`,
      'REASON_REQUIRED'
    );
  }
}

/**
 * Applies a transition: validates it, appends to `statusHistory`, saves, writes
 * an audit entry and adds an instrument-timeline event where relevant.
 *
 * Returns the saved application.
 */
export async function transitionApplication(
  app: IApplication & { save: () => Promise<unknown>; _id: Types.ObjectId },
  to: ApplicationStatus,
  user: AuthedUser,
  opts: TransitionOptions = {}
): Promise<IApplication> {
  assertTransition(app, to, user, { isSystem: opts.isSystem, reason: opts.reason });

  const from = app.status;

  app.status = to;
  app.statusHistory = [
    ...(app.statusHistory ?? []),
    {
      from,
      to,
      actorId: opts.isSystem ? undefined : new Types.ObjectId(user.id),
      actorRole: opts.isSystem ? 'SYSTEM' : user.role,
      reason: opts.reason,
      isSystem: Boolean(opts.isSystem),
      at: new Date(),
    },
  ];

  // Status-driven side effects on the application itself.
  if (to === 'SUBMITTED' || to === 'RESUBMITTED') {
    app.submittedDate = app.submittedDate ?? new Date();
  }
  if (to === 'APPROVED' || to === 'REJECTED') {
    app.completedDate = new Date();
  }

  if (opts.patch) {
    Object.assign(app, opts.patch);
  }

  await app.save();

  await auditAction(
    { id: user.id, role: opts.isSystem ? 'SYSTEM' : user.role, email: user.email },
    'application.transition',
    { type: 'Application', id: app._id, label: app.applicationNo },
    {
      details: `${from} → ${to}${opts.reason ? `: ${opts.reason}` : ''}`,
      changes: { from, to, reason: opts.reason },
      headers: opts.headers,
    }
  );

  // Mirror the meaningful steps onto the instrument's digital passport.
  const timelineEvent = INSTRUMENT_TIMELINE_FOR_STATUS[to];
  if (timelineEvent) {
    await InstrumentEvent.create({
      instrumentId: app.instrumentId,
      eventType: timelineEvent.eventType,
      title: timelineEvent.title(app),
      description: opts.reason,
      applicationId: app._id,
      actorId: opts.isSystem ? undefined : new Types.ObjectId(user.id),
      actorRole: opts.isSystem ? 'SYSTEM' : user.role,
      isSystem: Boolean(opts.isSystem),
      occurredAt: new Date(),
    }).catch((err) => console.error('[workflow] failed to append instrument event', err));
  }

  return app;
}

const INSTRUMENT_TIMELINE_FOR_STATUS: Partial<
  Record<ApplicationStatus, { eventType: string; title: (app: IApplication) => string }>
> = {
  SUBMITTED: {
    eventType: 'APPLICATION_SUBMITTED',
    title: (app) => `Verification application ${app.applicationNo} submitted`,
  },
  SCHEDULED: {
    eventType: 'INSPECTION_SCHEDULED',
    title: (app) => `Inspection scheduled for application ${app.applicationNo}`,
  },
  INSPECTION_SUBMITTED: {
    eventType: 'INSPECTION_COMPLETED',
    title: (app) => `Inspection completed for application ${app.applicationNo}`,
  },
};

/**
 * Fetches an application and narrows it to what `user` may act on.
 * Returns null when it does not exist or is out of scope.
 */
export async function findApplicationForUser(id: string, user: AuthedUser) {
  if (!Types.ObjectId.isValid(id)) return null;

  const app = await Application.findById(id);
  if (!app) return null;

  if (user.role === 'Owner') {
    return String(app.ownerId) === user.id ? app : null;
  }
  if (user.role === 'Admin') return app;

  // Officers: jurisdiction or explicit assignment.
  if (app.assignedTo && String(app.assignedTo) === user.id) return app;
  if (!user.state) return null;
  if (app.jurisdiction?.state !== user.state) return null;
  if (user.role !== 'StateAdmin' && user.district && app.jurisdiction?.district !== user.district) {
    return null;
  }
  return app;
}
