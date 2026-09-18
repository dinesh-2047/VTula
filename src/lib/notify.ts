import { Types } from 'mongoose';
import Notification from '@/models/Notification';
import User, { type IUser } from '@/models/User';
import { sendEmail, renderEmailHtml } from '@/lib/email';
import { sendWhatsAppMessage, sendSms } from '@/lib/twilio';
import type { NotificationType } from '@/lib/constants';

/**
 * Event-driven notification delivery.
 *
 * Replaces the previous approach, where `GET /api/notifications` *synthesised*
 * rows on first read by scanning applications and certificates — and for officer
 * roles scanned the entire database with an empty filter, writing other
 * businesses' data into the reader's own notification list. Notifications are now
 * created at the moment the event happens, addressed to a specific user, and the
 * API only reads them.
 *
 * `dedupeKey` makes delivery idempotent, so a repeated alert sweep cannot send
 * the same reminder twice.
 */

export interface NotifyInput {
  userId: string | Types.ObjectId;
  title: string;
  message: string;
  type?: NotificationType;
  relatedModel?: 'Application' | 'Certificate' | 'Instrument' | 'Schedule' | 'EnforcementCase' | 'RiskFlag' | 'User';
  relatedId?: string | Types.ObjectId;
  actionUrl?: string;
  actionLabel?: string;
  /** Stable key — a second call with the same key is a no-op. */
  dedupeKey?: string;
  /** Also attempt delivery on the user's enabled external channels. */
  alsoExternal?: boolean;
}

function appUrl(path: string): string {
  const base = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}${path}`;
}

/**
 * Creates the in-app notification and, when `alsoExternal` is set, fans out to
 * whichever external channels the recipient has enabled.
 *
 * Never throws — a notification failure must not roll back the business action
 * that triggered it.
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    const created = await Notification.findOneAndUpdate(
      input.dedupeKey
        ? { dedupeKey: input.dedupeKey }
        : { _id: new Types.ObjectId() },
      {
        $setOnInsert: {
          userId: new Types.ObjectId(String(input.userId)),
          title: input.title,
          message: input.message,
          type: input.type ?? 'info',
          channel: 'app',
          relatedModel: input.relatedModel,
          relatedId: input.relatedId ? new Types.ObjectId(String(input.relatedId)) : undefined,
          actionUrl: input.actionUrl,
          actionLabel: input.actionLabel,
          dedupeKey: input.dedupeKey,
          deliveryStatus: 'SENT',
          deliveredAt: new Date(),
          isRead: false,
        },
      },
      { upsert: true, new: false, setDefaultsOnInsert: true }
    );

    // `new: false` returns the pre-existing doc, so a non-null result means this
    // notification had already been delivered and we must not re-send it.
    if (created && input.dedupeKey) return;

    if (input.alsoExternal) {
      await deliverExternal(input);
    }
  } catch (err) {
    // A duplicate-key race on dedupeKey means someone else delivered it first.
    if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) return;
    console.error('[notify] failed to create notification:', err);
  }
}

async function deliverExternal(input: NotifyInput): Promise<void> {
  const user = await User.findById(input.userId).lean<IUser>();
  if (!user) return;

  const prefs = user.preferences ?? {
    notifyEmail: true,
    notifySms: false,
    notifyWhatsapp: true,
    notifyInApp: true,
    expiryReminderDays: [60, 30, 7],
    language: 'en' as const,
  };

  /*
   * `prefs.language` is deliberately not read here yet.
   *
   * Titles and bodies arrive already composed, in English, from something like sixty
   * call sites across the routes — so honouring it would mean every caller passing a
   * dictionary key and its variables instead of a sentence. Until that is done, the
   * settings page says plainly that emails and SMS are written in English, rather than
   * implying a translation that would not happen.
   */

  const url = input.actionUrl ? appUrl(input.actionUrl) : undefined;
  const plain = `${input.title}\n\n${input.message}${url ? `\n\n${url}` : ''}`;

  const jobs: Promise<unknown>[] = [];

  if (prefs.notifyEmail && user.email) {
    jobs.push(
      sendEmail({
        to: user.email,
        subject: `VTULA — ${input.title}`,
        text: plain,
        html: renderEmailHtml({
          heading: input.title,
          body: input.message.replace(/\n/g, '<br>'),
          actionUrl: url,
          actionLabel: input.actionLabel ?? 'Open in VTULA',
        }),
      })
    );
  }

  if (prefs.notifyWhatsapp && user.phone) {
    jobs.push(sendWhatsAppMessage(user.phone, plain));
  }

  if (prefs.notifySms && user.phone) {
    jobs.push(sendSms(user.phone, `${input.title}: ${input.message}`.slice(0, 300)));
  }

  // Delivery failures are logged by the individual senders; we only need to make
  // sure one failing channel does not prevent the others.
  await Promise.allSettled(jobs);
}

/** Notifies every user matching a role + jurisdiction — used for officer queues. */
export async function notifyOfficers(
  jurisdiction: { state?: string; district?: string },
  roles: string[],
  input: Omit<NotifyInput, 'userId'>
): Promise<void> {
  try {
    const query: Record<string, unknown> = {
      role: { $in: roles },
      isActive: true,
      approvalStatus: 'APPROVED',
    };
    if (jurisdiction.state) query.state = jurisdiction.state;
    if (jurisdiction.district) {
      query.$or = [
        { district: jurisdiction.district },
        { additionalDistricts: jurisdiction.district },
        { role: 'StateAdmin' },
      ];
    }

    const officers = await User.find(query).select('_id').limit(200).lean<{ _id: Types.ObjectId }[]>();

    await Promise.allSettled(
      officers.map((o) =>
        notify({
          ...input,
          userId: o._id,
          dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${o._id}` : undefined,
        })
      )
    );
  } catch (err) {
    console.error('[notify] failed to notify officers:', err);
  }
}

/* ------------------------------------------------------------------ *
 * Typed helpers for the events the workflow produces
 * ------------------------------------------------------------------ */

export const notifications = {
  applicationSubmitted: (ownerId: string, appNo: string, appId: string) =>
    notify({
      userId: ownerId,
      type: 'success',
      title: 'Application submitted',
      message: `Your verification application ${appNo} has been submitted and is awaiting review by a Legal Metrology Officer.`,
      relatedModel: 'Application',
      relatedId: appId,
      actionUrl: `/dashboard/applications/${appId}`,
      actionLabel: 'Track application',
      dedupeKey: `app-submitted:${appId}`,
      alsoExternal: true,
    }),

  queryRaised: (ownerId: string, appNo: string, appId: string, message: string) =>
    notify({
      userId: ownerId,
      type: 'warning',
      title: 'Action needed on your application',
      message: `An officer has raised a query on ${appNo}: "${message}" Please respond to continue.`,
      relatedModel: 'Application',
      relatedId: appId,
      actionUrl: `/dashboard/applications/${appId}`,
      actionLabel: 'Respond to query',
      alsoExternal: true,
    }),

  inspectionScheduled: (userId: string, appNo: string, appId: string, when: Date) =>
    notify({
      userId,
      type: 'info',
      title: 'Inspection scheduled',
      message: `The inspection for ${appNo} is scheduled for ${when.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      })}. Please ensure the instrument and an authorised person are available on site.`,
      relatedModel: 'Application',
      relatedId: appId,
      actionUrl: `/dashboard/applications/${appId}`,
      actionLabel: 'View details',
      /*
       * The recipient is part of the key.
       *
       * `notify` matches on `dedupeKey` alone — deliberately, so a reminder is sent
       * once and not once per sweep — which means a key that names only the
       * application silences everyone after the first recipient. `notifyOfficers`
       * already suffixes the id for exactly this reason. A reschedule tells both the
       * business and the inspector who has to travel, so this key must too.
       */
      dedupeKey: `scheduled:${appId}:${when.toISOString().slice(0, 10)}:${userId}`,
      alsoExternal: true,
    }),

  /**
   * A booked visit is off.
   *
   * Sent to whichever side did not do the cancelling — an owner who cancels does
   * not need telling, but the inspector who was going to travel does, and an
   * office that withdraws a slot owes the business an explanation. Without this the
   * appointment simply disappeared from the other party's calendar.
   */
  inspectionCancelled: (
    userId: string,
    appNo: string,
    appId: string,
    scheduleId: string,
    reason?: string
  ) =>
    notify({
      userId,
      type: 'warning',
      title: 'Inspection cancelled',
      message: `The inspection visit for ${appNo} has been cancelled.${
        reason ? ` Reason given: ${reason}` : ''
      } The application has gone back to the scheduling queue and a new date will be arranged.`,
      relatedModel: 'Application',
      relatedId: appId,
      actionUrl: `/dashboard/schedule`,
      actionLabel: 'View schedule',
      dedupeKey: `slot-cancelled:${scheduleId}:${userId}`,
      alsoExternal: true,
    }),

  /**
   * The inspector attended and could not carry out the visit.
   *
   * The route already tells the inspector that a no-show "goes on the business's
   * compliance history" — which made it the one consequence in the system recorded
   * against a business without the business being told. It is also the only one
   * they can pre-empt next time, so the message says what to do rather than only
   * what happened.
   */
  inspectionMissed: (
    ownerId: string,
    appNo: string,
    appId: string,
    scheduleId: string,
    reason: string
  ) =>
    notify({
      userId: ownerId,
      type: 'warning',
      title: 'Inspection could not be carried out',
      message: `The inspector attended for ${appNo} but the visit could not go ahead. Recorded on site: ${reason}. A missed visit is noted on your compliance record — please arrange a new date, and make sure the instrument and someone authorised to present it are available.`,
      relatedModel: 'Application',
      relatedId: appId,
      actionUrl: `/dashboard/schedule`,
      actionLabel: 'Arrange a new date',
      dedupeKey: `slot-noshow:${scheduleId}:${ownerId}`,
      alsoExternal: true,
    }),

  applicationDecided: (
    ownerId: string,
    appNo: string,
    appId: string,
    outcome: 'APPROVED' | 'REJECTED',
    justification: string
  ) =>
    notify({
      userId: ownerId,
      type: outcome === 'APPROVED' ? 'success' : 'error',
      title: outcome === 'APPROVED' ? 'Application approved' : 'Application rejected',
      message:
        outcome === 'APPROVED'
          ? `${appNo} has been approved. Your verification certificate is being generated.`
          : `${appNo} was rejected. Reason: ${justification}`,
      relatedModel: 'Application',
      relatedId: appId,
      actionUrl: `/dashboard/applications/${appId}`,
      actionLabel: 'View decision',
      dedupeKey: `decision:${appId}`,
      alsoExternal: true,
    }),

  certificateIssued: (ownerId: string, certNo: string, certId: string, expiry: Date) =>
    notify({
      userId: ownerId,
      type: 'success',
      title: 'Verification certificate issued',
      message: `Certificate ${certNo} has been issued and is valid until ${expiry.toLocaleDateString(
        'en-IN',
        { day: '2-digit', month: 'long', year: 'numeric' }
      )}.`,
      relatedModel: 'Certificate',
      relatedId: certId,
      actionUrl: `/dashboard/certificates`,
      actionLabel: 'View certificate',
      dedupeKey: `cert-issued:${certId}`,
      alsoExternal: true,
    }),

  certificateExpiring: (ownerId: string, certNo: string, certId: string, days: number) =>
    notify({
      userId: ownerId,
      type: days <= 7 ? 'error' : 'warning',
      title: `Certificate expires in ${days} days`,
      message: `Certificate ${certNo} expires in ${days} days. Apply for re-verification now to avoid a lapse — operating with an expired certificate is an offence under the Legal Metrology Act 2009.`,
      relatedModel: 'Certificate',
      relatedId: certId,
      actionUrl: `/dashboard/applications/new`,
      actionLabel: 'Apply for re-verification',
      dedupeKey: `cert-expiring:${certId}:${days}`,
      alsoExternal: true,
    }),

  certificateExpired: (ownerId: string, certNo: string, certId: string) =>
    notify({
      userId: ownerId,
      type: 'error',
      title: 'Certificate has expired',
      message: `Certificate ${certNo} has expired. The instrument must not be used for trade until it is re-verified.`,
      relatedModel: 'Certificate',
      relatedId: certId,
      actionUrl: `/dashboard/applications/new`,
      actionLabel: 'Apply for re-verification',
      dedupeKey: `cert-expired:${certId}`,
      alsoExternal: true,
    }),

  certificateStatusChanged: (
    ownerId: string,
    certNo: string,
    certId: string,
    status: string,
    reason: string
  ) =>
    notify({
      userId: ownerId,
      type: 'error',
      title: `Certificate ${status.toLowerCase()}`,
      message: `Certificate ${certNo} has been ${status.toLowerCase()}. Reason: ${reason}`,
      relatedModel: 'Certificate',
      relatedId: certId,
      actionUrl: `/dashboard/certificates`,
      actionLabel: 'View certificate',
      alsoExternal: true,
    }),

  assignmentReceived: (officerId: string, appNo: string, appId: string, when: Date) =>
    notify({
      userId: officerId,
      type: 'info',
      title: 'New inspection assigned',
      message: `You have been assigned the inspection for ${appNo} on ${when.toLocaleDateString('en-IN')}.`,
      relatedModel: 'Application',
      relatedId: appId,
      actionUrl: `/dashboard/tasks`,
      actionLabel: 'Open task queue',
      dedupeKey: `assigned:${appId}:${officerId}`,
      alsoExternal: true,
    }),

  /**
   * The visit has moved to a different day.
   *
   * Worded for either side, because both get it: the business has to have the
   * instrument available on a new date and the inspector has to travel on one.
   * Deliberately not `assignmentReceived` ("New inspection assigned"), which is
   * wrong twice over — nothing has been newly assigned, and its dedupe key carries
   * no date, so a moved visit would be silently suppressed as a duplicate of the
   * original assignment.
   */
  inspectionMoved: (
    userId: string,
    appNo: string,
    appId: string,
    when: Date,
    reason: string
  ) =>
    notify({
      userId,
      type: 'warning',
      title: 'Inspection moved to a new date',
      message: `The inspection for ${appNo} has been moved to ${when.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      })}. Reason given: ${reason}`,
      relatedModel: 'Application',
      relatedId: appId,
      actionUrl: `/dashboard/schedule`,
      actionLabel: 'View schedule',
      dedupeKey: `slot-moved:${appId}:${when.toISOString().slice(0, 10)}:${userId}`,
      alsoExternal: true,
    }),

  accountPendingApproval: (userId: string, role: string) =>
    notify({
      userId,
      type: 'warning',
      title: 'Account awaiting approval',
      message: `Your ${role} account has been created but must be approved by an administrator before you can sign in.`,
      relatedModel: 'User',
      relatedId: userId,
      dedupeKey: `pending-approval:${userId}`,
      alsoExternal: true,
    }),
};
