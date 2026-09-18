import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import User from '@/models/User';
import Application from '@/models/Application';
import Instrument from '@/models/Instrument';
import Inspection from '@/models/Inspection';
import {
  handle,
  ok,
  requireAdmin,
  BadRequest,
  NotFound,
  Conflict,
  Forbidden,
  hasGlobalScope,
} from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { notify } from '@/lib/notify';
import {
  ROLES,
  ROLE_LABELS,
  INDIAN_STATES,
  IN_FLIGHT_APPLICATION_STATUSES,
  type Role,
} from '@/lib/constants';

/**
 * One departmental account: read, amend, approve, reject, deactivate.
 *
 * The approval actions here are what make the registration fix survivable — a
 * self-registered LMO sits `PENDING` and cannot hold a session until an
 * administrator in their state acts on it.
 *
 * Two things this route deliberately refuses:
 *  - **acting on yourself.** An administrator cannot change their own role or
 *    deactivate their own account, because a single mistake would otherwise lock
 *    the department out of its own administration.
 *  - **deleting an account.** Officers sign inspections and certificates; deleting
 *    the user would orphan a signature that has legal weight. Accounts are
 *    deactivated, which stops sign-in and leaves the history intact.
 */

function grantableRoles(actorRole: Role): Role[] {
  if (actorRole === 'Admin') return [...ROLES];
  return ['Owner', 'LMO', 'GATC', 'GATCTechnician'];
}

/** Loads the target and refuses anything outside the administrator's jurisdiction. */
async function loadTarget(id: string, actor: { role: Role; state?: string }) {
  if (!Types.ObjectId.isValid(id)) throw NotFound('No such account');

  const target = await User.findById(id);
  if (!target) throw NotFound('No such account');

  // 404 rather than 403, so account ids in another state are not confirmed.
  if (!hasGlobalScope(actor.role) && target.state !== actor.state) {
    throw NotFound('No such account');
  }

  return target;
}

export const GET = handle(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();
  const actor = await requireAdmin('users.read');

  const target = await loadTarget(id, actor);

  // Workload, so an administrator can see what reassigning or deactivating this
  // account would strand.
  const [openApplications, instrumentsOwned, inspectionsSigned, approver] = await Promise.all([
    Application.countDocuments({
      assignedTo: target._id,
      status: { $in: [...IN_FLIGHT_APPLICATION_STATUSES] },
    }),
    Instrument.countDocuments({ ownerId: target._id, isDecommissioned: { $ne: true } }),
    Inspection.countDocuments({ inspectorId: target._id, isSubmitted: true }),
    target.approvedBy ? User.findById(target.approvedBy).select('name role').lean() : null,
  ]);

  const obj: Record<string, unknown> = { ...(target.toObject() as object) };
  delete obj.passwordHash;

  return ok({
    user: {
      ...obj,
      id: String(target._id),
      roleLabel: ROLE_LABELS[target.role],
      canSignIn: target.canSignIn(),
      approvedByName: approver?.name,
    },
    workload: {
      openApplications,
      instrumentsOwned,
      inspectionsSigned,
    },
    grantableRoles: grantableRoles(actor.role),
  });
});

export const PATCH = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();
  const actor = await requireAdmin('users.update');

  const target = await loadTarget(id, actor);
  const isSelf = String(target._id) === actor.id;

  const body = (await req.json()) as {
    action?: 'approve' | 'reject' | 'deactivate' | 'reactivate' | 'reset-password';
    reason?: string;
    /** Deactivate anyway, when the officer has left and the queue must be cleared. */
    force?: boolean;
    newPassword?: string;
    /** Field edits. */
    name?: string;
    phone?: string;
    role?: string;
    state?: string;
    district?: string;
    additionalDistricts?: string[];
    officerCode?: string;
    designation?: string;
    accreditationNo?: string;
    accreditationValidUntil?: string;
  };

  const changes: Record<string, unknown> = {};

  /* --- Approval decisions ------------------------------------------------ */
  if (body.action === 'approve') {
    if (target.approvalStatus === 'APPROVED') {
      throw Conflict('This account is already approved', 'ALREADY_APPROVED');
    }
    if (!grantableRoles(actor.role).includes(target.role)) {
      throw Forbidden(
        `You cannot approve a ${ROLE_LABELS[target.role]} account — that requires a system administrator`
      );
    }

    target.approvalStatus = 'APPROVED';
    target.approvedBy = new Types.ObjectId(actor.id);
    target.approvedAt = new Date();
    target.rejectionReason = undefined;
    target.isActive = true;
    await target.save();

    await Promise.all([
      auditAction(
        { id: actor.id, role: actor.role, email: actor.email },
        'user.approve',
        { type: 'User', id: target._id, label: target.email },
        { details: `Approved as ${ROLE_LABELS[target.role]}`, headers: req.headers }
      ),
      notify({
        userId: target._id,
        title: 'Your account has been approved',
        message: `You can now sign in to VTULA as ${ROLE_LABELS[target.role]}${target.state ? ` for ${target.state}` : ''}.`,
        type: 'success',
        actionUrl: '/login',
        actionLabel: 'Sign in',
        dedupeKey: `account-approved:${target._id}`,
        alsoExternal: true,
      }),
    ]);

    return ok({
      user: { id: String(target._id), approvalStatus: target.approvalStatus, canSignIn: target.canSignIn() },
      message: `${target.name} can now sign in.`,
    });
  }

  if (body.action === 'reject') {
    const reason = body.reason?.trim();
    if (!reason || reason.length < 5) {
      // The applicant is told this verbatim, so it has to be a real reason.
      throw BadRequest(
        'Give a reason for rejecting the request — it is shown to the applicant',
        'REASON_REQUIRED'
      );
    }
    if (isSelf) throw BadRequest('You cannot reject your own account', 'SELF_ACTION');

    target.approvalStatus = 'REJECTED';
    target.rejectionReason = reason;
    target.isActive = false;
    target.approvedBy = new Types.ObjectId(actor.id);
    target.approvedAt = new Date();
    await target.save();

    await Promise.all([
      auditAction(
        { id: actor.id, role: actor.role, email: actor.email },
        'user.reject',
        { type: 'User', id: target._id, label: target.email },
        { details: reason, outcome: 'DENIED', headers: req.headers }
      ),
      notify({
        userId: target._id,
        title: 'Your account request was not approved',
        message: `${reason} If you believe this is a mistake, contact the Legal Metrology office in ${target.state ?? 'your state'}.`,
        type: 'error',
        dedupeKey: `account-rejected:${target._id}`,
        alsoExternal: true,
      }),
    ]);

    return ok({
      user: { id: String(target._id), approvalStatus: target.approvalStatus },
      message: `The request from ${target.name} has been rejected.`,
    });
  }

  /* --- Deactivate / reactivate ------------------------------------------- */
  if (body.action === 'deactivate') {
    if (isSelf) {
      throw BadRequest(
        'You cannot deactivate your own account — ask another administrator',
        'SELF_ACTION'
      );
    }
    if (!target.isActive) throw Conflict('This account is already deactivated', 'ALREADY_INACTIVE');

    const reason = body.reason?.trim();
    if (!reason || reason.length < 5) {
      throw BadRequest('Give a reason for deactivating this account', 'REASON_REQUIRED');
    }

    // An officer with live assignments cannot simply vanish — the work has to be
    // moved first, or the applications stall silently. `force` is for the case
    // where the person has genuinely left and the queue has to be cleared anyway.
    const open = await Application.countDocuments({
      assignedTo: target._id,
      status: { $in: [...IN_FLIGHT_APPLICATION_STATUSES] },
    });
    if (open > 0 && body.force !== true) {
      throw Conflict(
        `${target.name} still has ${open} open application${open === 1 ? '' : 's'} assigned. Reassign them first, or deactivate with force if the officer has left.`,
        'HAS_OPEN_WORK'
      );
    }

    target.isActive = false;
    await target.save();

    await auditAction(
      { id: actor.id, role: actor.role, email: actor.email },
      'user.deactivate',
      { type: 'User', id: target._id, label: target.email },
      { details: reason, headers: req.headers }
    );

    return ok({
      user: { id: String(target._id), isActive: false },
      message: `${target.name} can no longer sign in. Their inspections and certificates remain on record.`,
    });
  }

  if (body.action === 'reactivate') {
    target.isActive = true;
    await target.save();
    await auditAction(
      { id: actor.id, role: actor.role, email: actor.email },
      'user.reactivate',
      { type: 'User', id: target._id, label: target.email },
      { details: body.reason?.trim() || 'Reactivated', headers: req.headers }
    );
    return ok({ user: { id: String(target._id), isActive: true, canSignIn: target.canSignIn() } });
  }

  /* --- Administrative password reset ------------------------------------- */
  if (body.action === 'reset-password') {
    const newPassword = body.newPassword ?? '';
    if (newPassword.length < 10) {
      throw BadRequest('The new password must be at least 10 characters', 'WEAK_PASSWORD');
    }

    target.passwordHash = await bcrypt.hash(newPassword, 12);
    // A reset clears any brute-force lockout, which is usually why it is being done.
    target.failedLoginAttempts = 0;
    target.lockedUntil = undefined;
    await target.save();

    await Promise.all([
      auditAction(
        { id: actor.id, role: actor.role, email: actor.email },
        'user.password.reset',
        { type: 'User', id: target._id, label: target.email },
        { details: 'Password reset by an administrator', headers: req.headers }
      ),
      notify({
        userId: target._id,
        title: 'Your password was reset',
        message:
          'An administrator has reset your VTULA password. If you did not ask for this, contact the Legal Metrology office immediately.',
        type: 'warning',
        dedupeKey: `password-reset:${target._id}:${Date.now()}`,
        alsoExternal: true,
      }),
    ]);

    return ok({ message: `Password reset for ${target.name}.` });
  }

  /* --- Field edits -------------------------------------------------------- */
  if (typeof body.name === 'string' && body.name.trim()) {
    changes.name = { from: target.name, to: body.name.trim() };
    target.name = body.name.trim();
  }

  if (typeof body.phone === 'string') {
    const phone = body.phone.trim();
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
      throw BadRequest('Enter the phone number in international format', 'INVALID_PHONE');
    }
    const previous = target.phone;
    if (phone && phone !== previous && (await User.exists({ phone }))) {
      throw Conflict('That phone number is registered to another account', 'PHONE_TAKEN');
    }
    changes.phone = { from: previous, to: phone || undefined };
    target.phone = phone || undefined;
    // A new number is unproven until it has been through OTP again.
    if (phone !== previous) target.isPhoneVerified = false;
  }

  if (typeof body.role === 'string' && body.role !== target.role) {
    if (isSelf) {
      throw BadRequest(
        'You cannot change your own role — ask another administrator',
        'SELF_ACTION'
      );
    }
    const newRole = body.role as Role;
    if (!grantableRoles(actor.role).includes(newRole)) {
      throw Forbidden(`You cannot grant the ${ROLE_LABELS[newRole] ?? newRole} role`);
    }
    changes.role = { from: target.role, to: newRole };
    target.role = newRole;
  }

  if (typeof body.state === 'string' && body.state.trim()) {
    const state = body.state.trim();
    if (!(INDIAN_STATES as readonly string[]).includes(state)) {
      throw BadRequest(`"${state}" is not a recognised state or union territory`, 'INVALID_STATE');
    }
    if (!hasGlobalScope(actor.role) && state !== actor.state) {
      // Otherwise a StateAdmin could move an account into a state they do not
      // administer, and lose sight of it.
      throw Forbidden('You can only assign accounts within your own state');
    }
    changes.state = { from: target.state, to: state };
    target.state = state;
  }

  if (typeof body.district === 'string') {
    changes.district = { from: target.district, to: body.district.trim() || undefined };
    target.district = body.district.trim() || undefined;
  }

  if (Array.isArray(body.additionalDistricts)) {
    target.additionalDistricts = body.additionalDistricts
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      .map((d) => d.trim());
    changes.additionalDistricts = target.additionalDistricts;
  }

  if (typeof body.officerCode === 'string') {
    const code = body.officerCode.trim();
    if (code && code !== target.officerCode && (await User.exists({ officerCode: code }))) {
      throw Conflict(`Officer code ${code} is already in use`, 'OFFICER_CODE_TAKEN');
    }
    changes.officerCode = { from: target.officerCode, to: code || undefined };
    target.officerCode = code || undefined;
  }

  if (typeof body.designation === 'string') {
    target.designation = body.designation.trim() || undefined;
    changes.designation = target.designation;
  }

  if (typeof body.accreditationNo === 'string') {
    target.accreditationNo = body.accreditationNo.trim() || undefined;
    changes.accreditationNo = target.accreditationNo;
  }

  if (body.accreditationValidUntil !== undefined) {
    const d = body.accreditationValidUntil ? new Date(body.accreditationValidUntil) : undefined;
    target.accreditationValidUntil = d && !Number.isNaN(d.getTime()) ? d : undefined;
    changes.accreditationValidUntil = target.accreditationValidUntil;
  }

  if (Object.keys(changes).length === 0) throw BadRequest('Nothing to update', 'NO_CHANGES');

  await target.save();

  await auditAction(
    { id: actor.id, role: actor.role, email: actor.email },
    'user.update',
    { type: 'User', id: target._id, label: target.email },
    { details: `Updated ${Object.keys(changes).join(', ')}`, changes, headers: req.headers }
  );

  return ok({
    user: {
      id: String(target._id),
      name: target.name,
      role: target.role,
      roleLabel: ROLE_LABELS[target.role],
      state: target.state,
      district: target.district,
      officerCode: target.officerCode,
      canSignIn: target.canSignIn(),
    },
    changed: Object.keys(changes),
  });
});

/**
 * Deleting a user is not offered. An officer's name appears on inspections and
 * signed certificates; removing the row would orphan records that carry legal
 * weight. `PATCH { action: 'deactivate' }` is the supported way to stop access.
 */
export const DELETE = handle(async () => {
  await requireAdmin('users.delete');
  throw BadRequest(
    'Accounts are not deleted, because officers are named on inspections and certificates. Deactivate the account instead.',
    'USE_DEACTIVATE'
  );
});
