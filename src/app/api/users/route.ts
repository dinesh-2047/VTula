import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import User from '@/models/User';
import {
  handle,
  ok,
  requireAdmin,
  BadRequest,
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
  SELF_REGISTERABLE_ROLES,
  type Role,
} from '@/lib/constants';

/**
 * Departmental account administration.
 *
 * This route is the other half of the registration fix. `/api/auth/register` now
 * creates any non-Owner account as `PENDING` and `canSignIn()` refuses it a
 * session — which, without this route, would mean an LMO who registered could
 * *never* sign in, because nothing existed to approve them. The users page was
 * meanwhile rendering a hardcoded `INITIAL_USERS` array, so the department's user
 * list was fiction.
 *
 * Jurisdiction applies to administration too: a StateAdmin administers accounts in
 * their own state, not nationally. Only a system Admin sees and provisions across
 * states.
 */

const MIN_PASSWORD_LENGTH = 10;

/** Which roles a given administrator may create or change someone to. */
function grantableRoles(actorRole: Role): Role[] {
  if (actorRole === 'Admin') return [...ROLES];
  // A StateAdmin staffs their own state but cannot mint peers or system admins —
  // otherwise state-level scoping could be escaped in one step.
  return ['Owner', 'LMO', 'GATC', 'GATCTechnician'];
}

export const GET = handle(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireAdmin('users.list');
  const sp = req.nextUrl.searchParams;

  const query: Record<string, unknown> = {};

  // A StateAdmin's list is their state's list.
  if (!hasGlobalScope(user.role)) {
    if (!user.state) {
      throw Forbidden('Your account has no state assigned, so it cannot administer users');
    }
    query.state = user.state;
  } else {
    const state = sp.get('state');
    if (state && state !== 'all') query.state = state;
  }

  const role = sp.get('role');
  if (role && role !== 'all' && (ROLES as readonly string[]).includes(role)) query.role = role;

  const status = sp.get('approvalStatus');
  if (status && status !== 'all' && ['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    query.approvalStatus = status;
  }

  if (sp.get('active') === 'true') query.isActive = true;
  if (sp.get('active') === 'false') query.isActive = false;

  const search = sp.get('search')?.trim();
  if (search) {
    const rx = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { email: { $regex: rx, $options: 'i' } },
      { phone: { $regex: rx, $options: 'i' } },
      { officerCode: { $regex: rx, $options: 'i' } },
      { organizationName: { $regex: rx, $options: 'i' } },
    ];
  }

  const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 50));
  const page = Math.max(1, Number(sp.get('page')) || 1);

  const [users, total, pendingCount, byRole] = await Promise.all([
    User.find(query)
      // Pending accounts first: they are the ones waiting on somebody.
      .sort({ approvalStatus: 1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select(
        'name email phone role state district additionalDistricts organizationName officerCode designation accreditationNo accreditationValidUntil categoriesApproved isActive isEmailVerified isPhoneVerified approvalStatus approvedAt rejectionReason lastLoginAt createdAt'
      )
      .lean(),
    User.countDocuments(query),
    User.countDocuments({ ...query, approvalStatus: 'PENDING' }),
    User.aggregate([{ $match: query }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
  ]);

  return ok({
    users: users.map((u) => ({
      ...u,
      id: String(u._id),
      roleLabel: ROLE_LABELS[u.role as Role] ?? u.role,
      // Surfaced so an administrator can see at a glance who is blocked and why.
      canSignIn: u.isActive && u.approvalStatus === 'APPROVED',
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
    pendingCount,
    countsByRole: Object.fromEntries(byRole.map((r) => [r._id, r.count])),
    scope: hasGlobalScope(user.role) ? 'national' : user.state,
    grantableRoles: grantableRoles(user.role),
  });
});

/**
 * Provisions a departmental account directly.
 *
 * This is how an LMO or GATC technician is *supposed* to get an account — created
 * by an administrator who knows who they are, already approved, rather than
 * self-registered and waiting.
 */
export const POST = handle(async (req: NextRequest) => {
  await dbConnect();
  const actor = await requireAdmin('users.create');

  const body = (await req.json()) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');

  const name = str('name');
  const email = str('email').toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const requestedRole = str('role') as Role;
  const phone = str('phone');
  const state = str('state') || (hasGlobalScope(actor.role) ? '' : actor.state ?? '');
  const district = str('district');

  if (!name || !email || !password) {
    throw BadRequest('Name, email and an initial password are required', 'MISSING_FIELDS');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw BadRequest('That does not look like a valid email address', 'INVALID_EMAIL');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw BadRequest(
      `The initial password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      'WEAK_PASSWORD'
    );
  }
  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw BadRequest('Enter the phone number in international format, e.g. +919876543210', 'INVALID_PHONE');
  }

  const allowed = grantableRoles(actor.role);
  if (!allowed.includes(requestedRole)) {
    throw Forbidden(
      `You cannot create a ${ROLE_LABELS[requestedRole] ?? requestedRole} account. You may create: ${allowed
        .map((r) => ROLE_LABELS[r])
        .join(', ')}.`
    );
  }

  // Every account except a system Admin belongs to a jurisdiction — otherwise
  // `scopeFilter` cannot decide what it may see and denies everything.
  if (requestedRole !== 'Admin' && !SELF_REGISTERABLE_ROLES.includes(requestedRole) && !state) {
    throw BadRequest('A departmental account must be assigned to a state', 'STATE_REQUIRED');
  }
  if (state && !(INDIAN_STATES as readonly string[]).includes(state)) {
    throw BadRequest(`"${state}" is not a recognised state or union territory`, 'INVALID_STATE');
  }
  if (!hasGlobalScope(actor.role) && state !== actor.state) {
    throw Forbidden('You can only create accounts in your own state');
  }

  if (await User.exists({ email })) {
    throw Conflict('An account already exists for this email address', 'EMAIL_TAKEN');
  }
  if (phone && (await User.exists({ phone }))) {
    throw Conflict('That phone number is already registered to another account', 'PHONE_TAKEN');
  }

  const officerCode = str('officerCode');
  if (officerCode && (await User.exists({ officerCode }))) {
    throw Conflict(`Officer code ${officerCode} is already in use`, 'OFFICER_CODE_TAKEN');
  }

  const created = await User.create({
    name,
    email,
    phone: phone || undefined,
    passwordHash: await bcrypt.hash(password, 12),
    role: requestedRole,
    state: state || undefined,
    district: district || undefined,
    additionalDistricts: Array.isArray(body.additionalDistricts)
      ? (body.additionalDistricts as unknown[]).filter((d): d is string => typeof d === 'string')
      : [],
    officerCode: officerCode || undefined,
    designation: str('designation') || undefined,
    accreditationNo: str('accreditationNo') || undefined,
    organizationName: str('organizationName') || undefined,
    // Provisioned by an administrator, so it is approved on the spot — with that
    // administrator recorded as the approver.
    approvalStatus: 'APPROVED',
    approvedBy: new Types.ObjectId(actor.id),
    approvedAt: new Date(),
    isActive: true,
  });

  await auditAction(
    { id: actor.id, role: actor.role, email: actor.email },
    'user.create',
    { type: 'User', id: created._id, label: email },
    {
      details: `Provisioned ${ROLE_LABELS[requestedRole]} for ${state || 'national'}${district ? `, ${district}` : ''}`,
      headers: req.headers,
    }
  );

  await notify({
    userId: created._id,
    title: 'Your VTULA account is ready',
    message: `An account has been created for you as ${ROLE_LABELS[requestedRole]}${state ? ` (${state})` : ''}. Sign in with your email address and change your password straight away.`,
    type: 'success',
    actionUrl: '/dashboard/profile',
    actionLabel: 'Change password',
    dedupeKey: `account-created:${created._id}`,
    alsoExternal: true,
  }).catch((err) => console.error('[users] welcome notification failed', err));

  return ok(
    {
      user: {
        id: String(created._id),
        name: created.name,
        email: created.email,
        role: created.role,
        roleLabel: ROLE_LABELS[created.role],
        state: created.state,
        district: created.district,
        approvalStatus: created.approvalStatus,
      },
      message: `${name} can now sign in. Ask them to change the initial password.`,
    },
    201
  );
});
