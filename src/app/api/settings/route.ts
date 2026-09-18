import { NextRequest } from 'next/server';
import dbConnect from '@/lib/db';
import User from '@/models/User';
import AuditLog from '@/models/AuditLog';
import { handle, ok, requireAuth, BadRequest, NotFound } from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { isEmailConfigured } from '@/lib/email';
import { isTwilioConfigured } from '@/lib/twilio';
import { isCloudinaryConfigured } from '@/lib/uploads';
import { isSigningConfigured } from '@/lib/utils';
import { ADMIN_ROLES } from '@/lib/constants';
import { LOCALES, LOCALE_LABELS, isLocale, type Locale } from '@/lib/i18n';

/**
 * Per-user notification preferences and language.
 *
 * The settings page had four checkboxes wired to `useState` and a save button that
 * set a success banner without sending anything anywhere. Two of the toggles were
 * not preferences at all: "HMAC Digital Signature Verification" and the
 * misspelled `twoFactor` described *server* capabilities, which no user gets to
 * switch off. Those are reported here as read-only platform status, which is the
 * honest version of the same information.
 *
 * `preferences` has been honoured by `notify()` and by the expiry sweep all along
 * — `expiryReminderDays` overrides the rule's default offsets per user — so these
 * writes take effect immediately, without any further wiring.
 */

/** Offsets are capped so a user cannot ask for a reminder every day for a year. */
const MAX_REMINDER_OFFSETS = 6;
const MAX_REMINDER_DAYS = 365;

export const GET = handle(async () => {
  await dbConnect();
  const session = await requireAuth();

  const user = await User.findById(session.id).select('preferences phone isPhoneVerified email isEmailVerified');
  if (!user) throw NotFound('Your account no longer exists');

  const emailReady = isEmailConfigured();
  const smsReady = isTwilioConfigured() && Boolean(process.env.TWILIO_SMS_FROM);
  const whatsappReady = Boolean(
    process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN
  );

  /*
   * The alert sweep, reported to administrators only.
   *
   * `POST /api/alerts/run` is what actually sends the 60/30/7-day expiry
   * reminders, marks lapsed certificates expired, runs the risk detectors and
   * refreshes compliance scores. Nothing in the product ran it, and nothing said
   * so — an installation with no scheduler configured looks identical to a healthy
   * one right up until a business is never warned that its certificate is about to
   * lapse. So the last run is reported from the audit trail, where the route
   * records every sweep, and an administrator is given a button.
   *
   * Whether `CRON_SECRET` is set is deliberately withheld from everyone else: it
   * tells a reader whether an unauthenticated code path exists on this server.
   */
  const isAdmin = ADMIN_ROLES.includes(session.role);
  const lastSweep = isAdmin
    ? await AuditLog.findOne({ action: 'alerts.sweep' })
        .sort({ timestamp: -1 })
        .select('timestamp details userRole outcome')
        .lean()
    : null;

  return ok({
    preferences: {
      notifyEmail: user.preferences?.notifyEmail ?? true,
      notifySms: user.preferences?.notifySms ?? false,
      notifyWhatsapp: user.preferences?.notifyWhatsapp ?? true,
      notifyInApp: user.preferences?.notifyInApp ?? true,
      expiryReminderDays: user.preferences?.expiryReminderDays ?? [60, 30, 7],
      language: user.preferences?.language ?? 'en',
    },

    /*
     * Whether a channel can actually deliver. A toggle that is on for a channel
     * the server cannot send through, or to a phone number nobody has verified,
     * produces silence — and the user blames the reminder, not the setting.
     */
    channels: {
      email: {
        available: emailReady,
        destination: user.email,
        verified: user.isEmailVerified,
        note: emailReady
          ? undefined
          : 'Email delivery is not configured on this server, so email alerts are written to the server log only.',
      },
      sms: {
        available: smsReady,
        destination: user.phone,
        verified: user.isPhoneVerified,
        note: !user.phone
          ? 'Add a mobile number to your profile to receive SMS alerts.'
          : !user.isPhoneVerified
            ? 'Verify your mobile number with an OTP before relying on SMS alerts.'
            : smsReady
              ? undefined
              : 'SMS delivery is not configured on this server.',
      },
      whatsapp: {
        available: whatsappReady,
        destination: user.phone,
        verified: user.isPhoneVerified,
        note: !user.phone
          ? 'Add a mobile number to your profile to receive WhatsApp alerts.'
          : whatsappReady
            ? undefined
            : 'WhatsApp delivery is not configured on this server.',
      },
      inApp: { available: true, destination: 'Notifications page', verified: true },
    },

    languages: LOCALES.map((l) => ({ code: l, label: LOCALE_LABELS[l] })),

    /**
     * Platform capabilities, not preferences. Read-only on purpose — a user
     * cannot switch off certificate signing, and pretending otherwise was one of
     * the fake toggles this route replaces.
     */
    platform: {
      certificateSigning: {
        enabled: isSigningConfigured(),
        algorithm: 'HMAC-SHA256',
        note: isSigningConfigured()
          ? 'Every certificate is signed and can be verified from its QR code.'
          : 'CERT_SIGNING_KEY is not configured, so certificates cannot be signed. Set it before issuing anything real.',
      },
      documentStorage: {
        provider: isCloudinaryConfigured() ? 'cloudinary' : 'database (development fallback)',
        note: isCloudinaryConfigured()
          ? undefined
          : 'Uploads are held in the database because object storage is not configured.',
      },
      otp: {
        provider: isTwilioConfigured() ? 'twilio-verify' : 'development mock',
      },
      /*
       * Administrators only — `undefined` for everyone else, so the field is absent
       * from the response rather than present-and-empty.
       */
      alertSweep: isAdmin
        ? {
            schedulerConfigured: Boolean(process.env.CRON_SECRET),
            canRunManually: true,
            lastRunAt: lastSweep?.timestamp ?? null,
            lastRunDetails: lastSweep?.details ?? null,
            lastRunBy: lastSweep?.userRole ?? null,
          }
        : undefined,
    },
  });
});

export const PATCH = handle(async (req: NextRequest) => {
  await dbConnect();
  const session = await requireAuth();

  const user = await User.findById(session.id);
  if (!user) throw NotFound('Your account no longer exists');

  const body = (await req.json()) as {
    notifyEmail?: boolean;
    notifySms?: boolean;
    notifyWhatsapp?: boolean;
    notifyInApp?: boolean;
    expiryReminderDays?: unknown;
    language?: unknown;
  };

  // Mongoose subdocument defaults are only applied on create, so an account that
  // predates this block may have nothing here to spread.
  const current = user.preferences ?? {
    notifyEmail: true,
    notifySms: false,
    notifyWhatsapp: true,
    notifyInApp: true,
    expiryReminderDays: [60, 30, 7],
    language: 'en' as Locale,
  };

  const next = { ...current };
  const changed: string[] = [];

  for (const key of ['notifyEmail', 'notifySms', 'notifyWhatsapp', 'notifyInApp'] as const) {
    if (typeof body[key] === 'boolean' && body[key] !== current[key]) {
      next[key] = body[key] as boolean;
      changed.push(key);
    }
  }

  if (body.expiryReminderDays !== undefined) {
    if (!Array.isArray(body.expiryReminderDays)) {
      throw BadRequest('Reminder offsets must be a list of days before expiry', 'INVALID_OFFSETS');
    }

    const offsets = [
      ...new Set(
        body.expiryReminderDays
          .map((d) => Math.trunc(Number(d)))
          .filter((d) => Number.isFinite(d) && d >= 1 && d <= MAX_REMINDER_DAYS)
      ),
      // Furthest-out reminder first, which is the order they will be sent in.
    ].sort((a, b) => b - a);

    if (offsets.length === 0) {
      throw BadRequest(
        `Choose at least one reminder, between 1 and ${MAX_REMINDER_DAYS} days before expiry`,
        'INVALID_OFFSETS'
      );
    }
    if (offsets.length > MAX_REMINDER_OFFSETS) {
      throw BadRequest(`Choose at most ${MAX_REMINDER_OFFSETS} reminders`, 'TOO_MANY_OFFSETS');
    }

    next.expiryReminderDays = offsets;
    changed.push('expiryReminderDays');
  }

  if (body.language !== undefined) {
    if (!isLocale(body.language)) {
      throw BadRequest(
        `Language must be one of: ${LOCALES.join(', ')}`,
        'INVALID_LANGUAGE'
      );
    }
    if (body.language !== current.language) {
      next.language = body.language;
      changed.push('language');
    }
  }

  if (changed.length === 0) throw BadRequest('Nothing was changed', 'NO_CHANGES');

  user.preferences = next;
  // A nested object replaced wholesale needs marking, or Mongoose may not persist it.
  user.markModified('preferences');
  await user.save();

  await auditAction(
    { id: session.id, role: user.role, email: user.email },
    'user.preferences.update',
    { type: 'User', id: user._id, label: user.email },
    { details: `Updated ${changed.join(', ')}`, headers: req.headers }
  );

  // Turning every channel off is allowed — statutory reminders still appear on the
  // notifications page — but the user should be told what they have just done.
  const silent = !next.notifyEmail && !next.notifySms && !next.notifyWhatsapp;

  return ok({
    preferences: next,
    changed,
    warning: silent
      ? 'You will no longer be contacted about expiring certificates outside the portal. Reminders will only appear on your notifications page.'
      : undefined,
    message: 'Your preferences have been saved.',
  });
});
