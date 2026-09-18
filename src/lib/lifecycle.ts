import { Types } from 'mongoose';
import Certificate from '@/models/Certificate';
import CertificateEvent from '@/models/CertificateEvent';
import Instrument from '@/models/Instrument';
import InstrumentEvent from '@/models/InstrumentEvent';
import User, { type IUser } from '@/models/User';
import { notifications } from '@/lib/notify';
import { resolveRule } from '@/lib/rules';
import { EXPIRY_ALERT_OFFSETS_DAYS, EXPIRING_SOON_WINDOW_DAYS } from '@/lib/constants';

/**
 * Certificate lifecycle sweep.
 *
 * The spec calls for a proactive 60/30/7-day reminder cadence plus an
 * expired-state alert. Previously nothing of the sort ran: `GET /api/notifications`
 * synthesised rows on first read, which meant a business only ever found out
 * about an impending expiry if they happened to open the notifications page, and
 * certificate `status` was never recomputed, so an expired certificate kept
 * reporting itself as active.
 *
 * This is idempotent. It can be called from a cron endpoint as often as you like:
 * status writes are conditional and reminders are deduplicated by
 * `cert-expiring:<certId>:<days>`, so a second run on the same day sends nothing.
 */

export interface SweepReport {
  scanned: number;
  markedExpiringSoon: number;
  markedExpired: number;
  remindersSent: number;
  instrumentsMarkedExpired: number;
  errors: string[];
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Whole days from today until `date`; negative once past. */
function daysUntilDate(date: Date): number {
  return Math.ceil((new Date(date).getTime() - startOfToday().getTime()) / 86_400_000);
}

/**
 * Runs the sweep.
 *
 * @param state Restrict to one state's instruments — useful for a state admin
 *              triggering a manual run without touching other jurisdictions.
 */
export async function runLifecycleSweep(state?: string): Promise<SweepReport> {
  const report: SweepReport = {
    scanned: 0,
    markedExpiringSoon: 0,
    markedExpired: 0,
    remindersSent: 0,
    instrumentsMarkedExpired: 0,
    errors: [],
  };

  const horizon = new Date(Date.now() + (Math.max(...EXPIRY_ALERT_OFFSETS_DAYS, EXPIRING_SOON_WINDOW_DAYS) + 1) * 86_400_000);

  const query: Record<string, unknown> = {
    status: { $in: ['ACTIVE', 'EXPIRING_SOON'] },
    expiryDate: { $lte: horizon },
  };
  if (state) query['instrumentSnapshot.installationState'] = state;

  const certificates = await Certificate.find(query)
    .select(
      'certNo status expiryDate ownerId instrumentId instrumentSnapshot remindersSent appliedRuleSnapshot'
    )
    .limit(2000);

  report.scanned = certificates.length;

  // Owner notification preferences decide which offsets they actually get.
  const ownerIds = [...new Set(certificates.map((c) => String(c.ownerId)))];
  const owners = await User.find({ _id: { $in: ownerIds } })
    .select('_id preferences')
    .lean<Pick<IUser, '_id' | 'preferences'>[]>();
  const prefsByOwner = new Map(owners.map((o) => [String(o._id), o.preferences]));

  for (const cert of certificates) {
    try {
      const daysLeft = daysUntilDate(cert.expiryDate);

      /* ---- Expired ---------------------------------------------------- */
      if (daysLeft <= 0) {
        if (cert.status !== 'EXPIRED') {
          const from = cert.status;
          cert.status = 'EXPIRED';
          await cert.save();
          report.markedExpired += 1;

          await CertificateEvent.create({
            certificateId: cert._id,
            certNo: cert.certNo,
            instrumentId: cert.instrumentId,
            eventType: 'EXPIRED',
            summary: `Certificate reached its expiry date of ${new Date(cert.expiryDate).toLocaleDateString('en-IN')}.`,
            fromStatus: from,
            toStatus: 'EXPIRED',
            isSystem: true,
            isPublic: true,
          });

          // Only demote the instrument if this is still its live certificate.
          const instrument = await Instrument.findOne({
            _id: cert.instrumentId,
            currentCertificateId: cert._id,
          });
          if (instrument && instrument.status !== 'EXPIRED') {
            instrument.status = 'EXPIRED';
            await instrument.save();
            report.instrumentsMarkedExpired += 1;

            await InstrumentEvent.create({
              instrumentId: instrument._id,
              eventType: 'CERTIFICATE_EXPIRED',
              title: `Certificate ${cert.certNo} expired`,
              description:
                'The instrument must not be used for trade until it has been re-verified and re-stamped.',
              certificateId: cert._id,
              isSystem: true,
            });
          }

          await notifications.certificateExpired(String(cert.ownerId), cert.certNo, String(cert._id));
          report.remindersSent += 1;
        }
        continue;
      }

      /* ---- Approaching expiry ---------------------------------------- */
      const rule = await resolveRule(
        cert.instrumentSnapshot?.installationState,
        cert.instrumentSnapshot?.type
      );

      if (cert.status === 'ACTIVE' && daysLeft <= rule.expiringSoonWindowDays) {
        cert.status = 'EXPIRING_SOON';
        await cert.save();
        report.markedExpiringSoon += 1;
      }

      // The owner's own preference wins over the rule's default cadence.
      const offsets = prefsByOwner.get(String(cert.ownerId))?.expiryReminderDays?.length
        ? prefsByOwner.get(String(cert.ownerId))!.expiryReminderDays
        : rule.expiryAlertOffsetsDays;

      // Fire the largest offset that today has reached but that has not been
      // sent yet, so a system that was down for a week still sends one alert
      // rather than three at once.
      const due = offsets
        .filter((o) => daysLeft <= o)
        .sort((a, b) => a - b)[0];

      if (due === undefined) continue;

      const already = (cert.remindersSent ?? []).some((r) => r.offsetDays === due);
      if (already) continue;

      await notifications.certificateExpiring(
        String(cert.ownerId),
        cert.certNo,
        String(cert._id),
        daysLeft
      );

      cert.remindersSent = [
        ...(cert.remindersSent ?? []),
        { offsetDays: due, sentAt: new Date(), channel: 'app' },
      ];
      await cert.save();
      report.remindersSent += 1;

      await CertificateEvent.create({
        certificateId: cert._id,
        certNo: cert.certNo,
        instrumentId: cert.instrumentId,
        eventType: 'REMINDER_SENT',
        summary: `${due}-day expiry reminder sent to the owner (${daysLeft} days remaining).`,
        isSystem: true,
        // Reminder traffic is internal; the public trust page should not expose
        // how often a business was chased.
        isPublic: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`${cert.certNo}: ${msg}`);
      console.error(`[lifecycle] ${cert.certNo}:`, err);
    }
  }

  return report;
}

/**
 * Recomputes a single certificate's status. Used after an admin edits an expiry
 * date or reinstates a suspension, so the row does not wait for the next sweep.
 */
export async function refreshCertificateStatus(certificateId: string | Types.ObjectId): Promise<void> {
  const cert = await Certificate.findById(certificateId);
  if (!cert) return;
  if (['REVOKED', 'SUSPENDED', 'SUPERSEDED'].includes(cert.status)) return;

  const daysLeft = daysUntilDate(cert.expiryDate);
  const next = daysLeft <= 0 ? 'EXPIRED' : daysLeft <= EXPIRING_SOON_WINDOW_DAYS ? 'EXPIRING_SOON' : 'ACTIVE';

  if (cert.status !== next) {
    cert.status = next;
    await cert.save();
  }
}
