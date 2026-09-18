import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import User from '@/models/User';
import Organization from '@/models/Organization';
import { handle, ok, BadRequest, Conflict } from '@/lib/rbac';
import { writeAudit } from '@/lib/audit';
import { notifications } from '@/lib/notify';
import {
  ROLES,
  SELF_REGISTERABLE_ROLES,
  INDIAN_STATES,
  type Role,
} from '@/lib/constants';
import { isValidDistrict } from '@/lib/districts';

/**
 * Self-registration.
 *
 * The privilege-escalation hole this closes: the old handler accepted `role`
 * from the request body, checked it against `['Owner', 'LMO', 'GATC', 'Admin']`,
 * and created the account immediately and active. Anyone who could reach the
 * public registration endpoint could POST `role: 'Admin'` and hold a national
 * administrator session seconds later.
 *
 * Now:
 *  - only the roles in `SELF_REGISTERABLE_ROLES` (Owner) may be created here;
 *  - anything else is created `PENDING` and cannot sign in until an existing
 *    administrator approves it, so the request is at worst a queue entry;
 *  - `canSignIn()` on the User model enforces that at the authentication layer
 *    too, rather than trusting this route to be the only writer.
 */

const MIN_PASSWORD_LENGTH = 10;

export const POST = handle(async (req: NextRequest) => {
  await dbConnect();

  const body = (await req.json()) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');

  const name = str('name');
  const email = str('email').toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const phone = str('phone');
  const state = str('state');
  const district = str('district');
  const organizationName = str('organizationName');

  if (!name || !email || !password) {
    throw BadRequest('Name, email and password are required', 'MISSING_FIELDS');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw BadRequest('That does not look like a valid email address', 'INVALID_EMAIL');
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw BadRequest(
      `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`,
      'WEAK_PASSWORD'
    );
  }

  // Enough to stop the worst choices without pretending to be a strength meter.
  if (/^(password|12345678|qwertyui)/i.test(password) || new Set(password).size < 5) {
    throw BadRequest(
      'That password is too easily guessed. Use a longer phrase with a mix of characters.',
      'WEAK_PASSWORD'
    );
  }

  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw BadRequest(
      'Enter the phone number in international format, for example +919876543210',
      'INVALID_PHONE'
    );
  }

  if (state && !(INDIAN_STATES as readonly string[]).includes(state)) {
    throw BadRequest(`"${state}" is not a recognised state or union territory`, 'INVALID_STATE');
  }

  /*
   * A district that is not a real district of the chosen state is worse than no
   * district at all. `scopeFilter` narrows every officer's queue by an exact
   * string match, so "Shimla " or "shimla" or a Kerala district under Himachal
   * Pradesh files the account into a jurisdiction nobody's filter will ever
   * match — the applications sit there, invisible to the office responsible for
   * them. The registration form now offers a closed list; this is the check that
   * makes it true for every client.
   */
  if (district) {
    if (!state) {
      throw BadRequest('Choose a state before a district', 'STATE_REQUIRED');
    }
    if (!isValidDistrict(state, district)) {
      throw BadRequest(`"${district}" is not a district of ${state}`, 'INVALID_DISTRICT');
    }
  }

  // The requested role is a *request*, never an assignment.
  const requestedRole = str('role') as Role;
  const isKnownRole = (ROLES as readonly string[]).includes(requestedRole);
  const role: Role = isKnownRole ? requestedRole : 'Owner';

  const selfServe = SELF_REGISTERABLE_ROLES.includes(role);
  const approvalStatus: 'PENDING' | 'APPROVED' = selfServe ? 'APPROVED' : 'PENDING';

  if (!selfServe) {
    // A departmental account needs a jurisdiction for the approver to route it.
    if (!state) {
      throw BadRequest(
        'A departmental account request must name the state it is for',
        'STATE_REQUIRED'
      );
    }
  }

  const existing = await User.findOne({ email }).select('_id');
  if (existing) {
    throw Conflict(
      'An account already exists for this email address. Sign in instead, or use a different address.',
      'EMAIL_TAKEN'
    );
  }

  if (phone) {
    const phoneTaken = await User.findOne({ phone }).select('_id');
    if (phoneTaken) {
      // Phone login resolves an account from the number, so a shared number
      // would make that ambiguous.
      throw Conflict(
        'This phone number is already registered to another account.',
        'PHONE_TAKEN'
      );
    }
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await User.create({
    name,
    email,
    phone: phone || undefined,
    passwordHash,
    role,
    state: state || undefined,
    district: district || undefined,
    organizationName: organizationName || undefined,
    approvalStatus,
    isActive: true,
  });

  // An Owner giving a business name gets an Organization record, so instruments
  // and compliance scores can be grouped by business rather than by person. It is
  // created after the user because it needs a primary owner.
  let organizationId: Types.ObjectId | undefined;
  if (role === 'Owner' && organizationName) {
    const org = await Organization.create({
      name: organizationName,
      address: { state: state || undefined, district: district || undefined },
      contactEmail: email,
      contactPhone: phone || undefined,
      primaryOwnerId: user._id,
      memberIds: [user._id],
    });
    organizationId = org._id;
    await User.updateOne({ _id: user._id }, { organizationId });
  }

  await writeAudit({
    action: 'auth.register',
    userId: String(user._id),
    userRole: role,
    userEmail: email,
    outcome: 'SUCCESS',
    details:
      approvalStatus === 'APPROVED'
        ? `Self-registered as ${role}`
        : `Requested the ${role} role${isKnownRole ? '' : ' (unrecognised role, defaulted to Owner)'}; awaiting administrator approval`,
    resourceType: 'User',
    resourceId: user._id,
    resourceLabel: email,
    headers: req.headers,
  });

  if (approvalStatus === 'PENDING') {
    await notifications
      .accountPendingApproval(String(user._id), role)
      .catch((err) => console.error('[register] approval notification failed', err));
  }

  return ok(
    {
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        approvalStatus: user.approvalStatus,
        organizationId: organizationId ? String(organizationId) : undefined,
      },
      // The client uses this to decide between "you're in" and "we'll be in touch".
      canSignInNow: approvalStatus === 'APPROVED',
      message:
        approvalStatus === 'APPROVED'
          ? 'Your account is ready. You can sign in now.'
          : `A ${role} account cannot be self-issued. Your request has been sent to the ${state} Legal Metrology administrator for approval — you will be notified once it is reviewed.`,
    },
    201
  );
});
