import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import dbConnect from '@/lib/db';
import User from '@/models/User';
import Organization from '@/models/Organization';
import Instrument from '@/models/Instrument';
import Application from '@/models/Application';
import Certificate from '@/models/Certificate';
import Inspection from '@/models/Inspection';
import { handle, ok, requireAuth, BadRequest, Conflict, NotFound, isOfficial } from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { INDIAN_STATES, ROLE_LABELS, OPEN_APPLICATION_STATUSES, IN_FLIGHT_APPLICATION_STATUSES } from '@/lib/constants';

/**
 * The signed-in user's own account.
 *
 * The profile page was rendering invented values — `'+91 98765 43210'`,
 * `'Legal Metrology Commercial Enterprise'`, `'Gujarat'`, `'Ahmedabad'` — as if
 * they were the user's details, and its save button called `setSaved(true)` and
 * nothing else. Every field was fiction and no edit survived a refresh.
 *
 * One deliberate asymmetry: **an officer cannot edit their own jurisdiction.**
 * `scopeFilter` decides what an LMO may see from `state`/`district`, so a
 * self-service state field would be a one-request escape from jurisdiction into
 * another state's caseload. Owners set their own state and district freely — for
 * them it is a postal address, not an authority boundary. An officer's
 * jurisdiction is changed by an administrator through `/api/users/[id]`.
 */

const MIN_PASSWORD_LENGTH = 10;

export const GET = handle(async () => {
  await dbConnect();
  const session = await requireAuth();

  const user = await User.findById(session.id).select('+aadhaarLinkedId');
  if (!user) throw NotFound('Your account no longer exists');

  const organization = user.organizationId
    ? await Organization.findById(user.organizationId).lean()
    : null;

  /*
   * A short summary of what the account is responsible for. For an owner that is
   * their estate; for an officer it is their caseload. Both are cheap counts and
   * both are what the person actually wants to see on their own page.
   */
  const activity = isOfficial(user.role)
    ? {
        kind: 'officer' as const,
        assignedOpen: await Application.countDocuments({
          assignedTo: user._id,
          status: { $in: [...IN_FLIGHT_APPLICATION_STATUSES] },
        }),
        inspectionsSubmitted: await Inspection.countDocuments({ inspectorId: user._id, isSubmitted: true }),
        certificatesIssued: await Certificate.countDocuments({ issuedBy: user._id }),
      }
    : {
        kind: 'owner' as const,
        instruments: await Instrument.countDocuments({
          ownerId: user._id,
          isDecommissioned: { $ne: true },
        }),
        openApplications: await Application.countDocuments({
          ownerId: user._id,
          status: { $in: [...OPEN_APPLICATION_STATUSES] },
        }),
        activeCertificates: await Certificate.countDocuments({ ownerId: user._id, status: 'ACTIVE' }),
      };

  return ok({
    profile: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      state: user.state,
      district: user.district,
      additionalDistricts: user.additionalDistricts,
      organizationName: user.organizationName,
      organizationId: user.organizationId ? String(user.organizationId) : undefined,
      officerCode: user.officerCode,
      designation: user.designation,
      accreditationNo: user.accreditationNo,
      accreditationValidUntil: user.accreditationValidUntil,
      categoriesApproved: user.categoriesApproved,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      approvalStatus: user.approvalStatus,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      // Present as a flag only. The identifier itself is `select: false` for a
      // reason and there is no purpose in echoing it back.
      aadhaarLinked: Boolean(user.aadhaarLinkedId),
    },
    organization: organization
      ? {
          id: String(organization._id),
          name: organization.name,
          legalName: organization.legalName,
          type: organization.type,
          gstin: organization.gstin,
          pan: organization.pan,
          address: organization.address,
          /*
           * `instrumentCount` and `complianceScore` were returned here from two
           * denormalised fields on the organisation that nothing ever wrote. The
           * score defaulted to 100, so this block told every business it was fully
           * compliant across zero instruments. Both fields are gone from the model.
           * The truthful instrument count is in `activity` below, and the real score
           * is at `/api/compliance`.
           */
        }
      : null,
    activity,
    /** What this account is allowed to change about itself. */
    editable: {
      jurisdiction: !isOfficial(user.role),
      organization: !isOfficial(user.role),
    },
  });
});

export const PATCH = handle(async (req: NextRequest) => {
  await dbConnect();
  const session = await requireAuth();

  const user = await User.findById(session.id).select('+passwordHash');
  if (!user) throw NotFound('Your account no longer exists');

  const body = (await req.json()) as {
    action?: 'change-password';
    currentPassword?: string;
    newPassword?: string;
    name?: string;
    email?: string;
    phone?: string;
    state?: string;
    district?: string;
    organizationName?: string;
    organization?: {
      legalName?: string;
      type?: string;
      gstin?: string;
      pan?: string;
      address?: Record<string, string>;
    };
  };

  /* --- Password change ---------------------------------------------------- */
  if (body.action === 'change-password') {
    const current = body.currentPassword ?? '';
    const next = body.newPassword ?? '';

    // Knowing the current password is the whole point: a stolen session should not
    // be enough to take the account over permanently.
    if (!current || !(await bcrypt.compare(current, user.passwordHash))) {
      throw BadRequest('Your current password is not correct', 'WRONG_PASSWORD');
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      throw BadRequest(
        `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        'WEAK_PASSWORD'
      );
    }
    if (await bcrypt.compare(next, user.passwordHash)) {
      throw BadRequest('The new password must be different from the old one', 'PASSWORD_UNCHANGED');
    }

    user.passwordHash = await bcrypt.hash(next, 12);
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;
    await user.save();

    await Promise.all([
      auditAction(
        { id: session.id, role: user.role, email: user.email },
        'user.password.change',
        { type: 'User', id: user._id, label: user.email },
        { details: 'Password changed by the account holder', headers: req.headers }
      ),
      // Sent whether or not it was them: if it was not, this is how they find out.
      notify({
        userId: user._id,
        title: 'Your password was changed',
        message:
          'Your VTULA password was changed just now. If this was not you, contact the Legal Metrology office immediately.',
        type: 'warning',
        alsoExternal: true,
      }).catch(() => undefined),
    ]);

    return ok({ message: 'Your password has been changed.' });
  }

  /* --- Profile fields ----------------------------------------------------- */
  const changes: Record<string, unknown> = {};

  if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== user.name) {
    changes.name = { from: user.name, to: body.name.trim() };
    user.name = body.name.trim();
  }

  if (typeof body.email === 'string') {
    const email = body.email.trim().toLowerCase();
    if (email && email !== user.email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        throw BadRequest('That does not look like a valid email address', 'INVALID_EMAIL');
      }
      // The email is the sign-in identity, so changing it is a credential change.
      if (!body.currentPassword || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
        throw BadRequest(
          'Confirm your current password to change the email address you sign in with',
          'PASSWORD_REQUIRED'
        );
      }
      if (await User.exists({ email })) {
        throw Conflict('An account already exists for that email address', 'EMAIL_TAKEN');
      }
      changes.email = { from: user.email, to: email };
      user.email = email;
      user.isEmailVerified = false;
    }
  }

  if (typeof body.phone === 'string') {
    const phone = body.phone.trim();
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
      throw BadRequest(
        'Enter the phone number in international format, e.g. +919876543210',
        'INVALID_PHONE'
      );
    }
    const previous = user.phone;
    if (phone !== (previous ?? '')) {
      if (phone && (await User.exists({ phone, _id: { $ne: user._id } }))) {
        throw Conflict('That phone number is registered to another account', 'PHONE_TAKEN');
      }
      changes.phone = { from: previous, to: phone || undefined };
      user.phone = phone || undefined;
      // A new number is unproven until it has been through OTP again — and OTP
      // sign-in depends on it, so this matters.
      user.isPhoneVerified = false;
    }
  }

  /*
   * Jurisdiction. Refused outright for officers rather than silently ignored: a
   * form that appears to accept a change and discards it is worse than one that
   * explains itself.
   */
  if (typeof body.state === 'string' || typeof body.district === 'string') {
    if (isOfficial(user.role)) {
      throw BadRequest(
        'Your jurisdiction is set by an administrator and cannot be changed here, because it decides which records you can see.',
        'JURISDICTION_LOCKED'
      );
    }

    if (typeof body.state === 'string' && body.state.trim()) {
      const state = body.state.trim();
      if (!(INDIAN_STATES as readonly string[]).includes(state)) {
        throw BadRequest(`"${state}" is not a recognised state or union territory`, 'INVALID_STATE');
      }
      if (state !== user.state) {
        changes.state = { from: user.state, to: state };
        user.state = state;
      }
    }

    if (typeof body.district === 'string' && body.district.trim() !== (user.district ?? '')) {
      changes.district = { from: user.district, to: body.district.trim() || undefined };
      user.district = body.district.trim() || undefined;
    }
  }

  if (typeof body.organizationName === 'string' && !isOfficial(user.role)) {
    const name = body.organizationName.trim();
    if (name !== (user.organizationName ?? '')) {
      changes.organizationName = { from: user.organizationName, to: name || undefined };
      user.organizationName = name || undefined;
    }
  }

  /* --- Business details --------------------------------------------------- */
  if (body.organization && !isOfficial(user.role)) {
    const org = user.organizationId ? await Organization.findById(user.organizationId) : null;
    if (!org) {
      throw BadRequest(
        'No business record is linked to your account yet. Register an instrument first — the business is created with it.',
        'NO_ORGANIZATION'
      );
    }

    const o = body.organization;
    if (typeof o.legalName === 'string') org.legalName = o.legalName.trim() || undefined;
    if (typeof o.type === 'string' && o.type.trim()) {
      org.type = o.type.trim() as typeof org.type;
    }
    if (typeof o.gstin === 'string') {
      const gstin = o.gstin.trim().toUpperCase();
      // 15 characters: 2 state code, 10 PAN, 1 entity, 1 filler, 1 checksum.
      if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d][A-Z\d]$/.test(gstin)) {
        throw BadRequest('That is not a valid 15-character GSTIN', 'INVALID_GSTIN');
      }
      if (gstin && (await Organization.exists({ gstin, _id: { $ne: org._id } }))) {
        throw Conflict('That GSTIN is already registered to another business', 'GSTIN_TAKEN');
      }
      org.gstin = gstin || undefined;
    }
    if (typeof o.pan === 'string') {
      const pan = o.pan.trim().toUpperCase();
      if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) {
        throw BadRequest('That is not a valid 10-character PAN', 'INVALID_PAN');
      }
      org.pan = pan || undefined;
    }
    if (o.address) {
      const a = o.address;
      if (a.state && !(INDIAN_STATES as readonly string[]).includes(a.state)) {
        throw BadRequest(`"${a.state}" is not a recognised state or union territory`, 'INVALID_STATE');
      }
      if (a.pincode && !/^\d{6}$/.test(a.pincode.trim())) {
        throw BadRequest('A pincode is six digits', 'INVALID_PINCODE');
      }
      org.address = {
        line1: a.line1?.trim() || org.address?.line1,
        line2: a.line2?.trim() || org.address?.line2,
        city: a.city?.trim() || org.address?.city,
        district: a.district?.trim() || org.address?.district,
        state: a.state?.trim() || org.address?.state,
        pincode: a.pincode?.trim() || org.address?.pincode,
      };
    }

    await org.save();
    changes.organization = 'updated';
  }

  if (Object.keys(changes).length === 0) {
    throw BadRequest('Nothing was changed', 'NO_CHANGES');
  }

  await user.save();

  await auditAction(
    { id: session.id, role: user.role, email: user.email },
    'user.profile.update',
    { type: 'User', id: user._id, label: user.email },
    { details: `Updated ${Object.keys(changes).join(', ')}`, changes, headers: req.headers },
  );

  return ok({
    profile: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone,
      state: user.state,
      district: user.district,
      organizationName: user.organizationName,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
    },
    changed: Object.keys(changes),
    // The session carries name and email, so the client has to refresh it for the
    // header and sidebar to stop showing the old values.
    sessionStale: 'name' in changes || 'email' in changes,
    message:
      'email' in changes
        ? 'Your details have been saved. Sign in with your new email address next time.'
        : 'Your details have been saved.',
  });
});
