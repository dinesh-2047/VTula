'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Save,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Languages,
  ServerCog,
  ShieldCheck,
  ShieldAlert,
  CalendarClock,
  Mail,
  MessageSquare,
  Smartphone,
  Inbox,
  Info,
  RefreshCw,
  History,
} from 'lucide-react';
import Link from 'next/link';
import { formatDateTime } from '@/lib/constants';
import { isLocale } from '@/lib/i18n';
import { useLocale } from '@/components/LocaleProvider';
import styles from './settings.module.css';

/**
 * Notification preferences and language.
 *
 * The four checkboxes here were wired to `useState` and nothing else: saving set a
 * banner reading "System settings saved successfully" without sending a request,
 * and every toggle reset on refresh. Two of them were not preferences at all —
 * "HMAC Digital Signature Verification" and a misspelled `twoFactor` described
 * *server* capabilities that no user may switch off, so offering a switch was
 * doubly false.
 *
 * Real preferences now go to `/api/settings`, where `notify()` and the expiry
 * sweep already honour them. Server capabilities appear as read-only status,
 * which is the honest version of the same information, and each channel states
 * whether it can actually deliver — a reminder toggled on for an unverified phone
 * number produces silence, and the user blames the reminder rather than the
 * setting.
 */

interface Channel {
  available: boolean;
  destination?: string;
  verified?: boolean;
  note?: string;
}

interface Preferences {
  notifyEmail: boolean;
  notifySms: boolean;
  notifyWhatsapp: boolean;
  notifyInApp: boolean;
  expiryReminderDays: number[];
  language: string;
}

interface Payload {
  success: boolean;
  error?: string;
  preferences?: Preferences;
  channels?: {
    email: Channel;
    sms: Channel;
    whatsapp: Channel;
    inApp: Channel;
  };
  languages?: { code: string; label: string }[];
  platform?: {
    certificateSigning: { enabled: boolean; algorithm: string; note?: string };
    documentStorage: { provider: string; note?: string };
    otp: { provider: string };
    /** Present for StateAdmin and Admin only — see the note in `/api/settings`. */
    alertSweep?: {
      schedulerConfigured: boolean;
      canRunManually: boolean;
      lastRunAt: string | null;
      lastRunDetails: string | null;
      lastRunBy: string | null;
    };
  };
  message?: string;
  warning?: string;
  changed?: string[];
}

/** What `POST /api/alerts/run` reports back. */
interface SweepReport {
  scope: string;
  durationMs: number;
  lifecycle: {
    scanned: number;
    markedExpiringSoon: number;
    markedExpired: number;
    remindersSent: number;
    instrumentsMarkedExpired: number;
    errors: string[];
  };
  risk: { detected: number; byType: Record<string, number> };
  compliance: { ownersScored: number; errors: string[] };
}

/** Offsets the department actually uses; six is the server's cap. */
const OFFSET_CHOICES = [90, 60, 30, 15, 7, 3, 1];
const MAX_OFFSETS = 6;

export default function SettingsPage() {
  const { locale, adoptLocale } = useLocale();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const data = (await res.json()) as Payload;
      if (!data.success || !data.preferences) {
        setError(data.error || 'Your settings could not be loaded.');
        return;
      }
      setError(null);
      setPayload(data);
      setPrefs(data.preferences);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  function toggle(key: 'notifyEmail' | 'notifySms' | 'notifyWhatsapp' | 'notifyInApp', value: boolean) {
    setPrefs((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function setLanguage(code: string) {
    setPrefs((prev) => (prev ? { ...prev, language: code } : prev));
  }

  function toggleOffset(day: number) {
    setPrefs((prev) => {
      if (!prev) return prev;
      const has = prev.expiryReminderDays.includes(day);
      if (!has && prev.expiryReminderDays.length >= MAX_OFFSETS) {
        setError(`You can choose at most ${MAX_OFFSETS} reminders.`);
        return prev;
      }
      setError(null);
      const next = has
        ? prev.expiryReminderDays.filter((d) => d !== day)
        : [...prev.expiryReminderDays, day].sort((a, b) => b - a);
      return { ...prev, expiryReminderDays: next };
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!prefs) return;

    if (prefs.expiryReminderDays.length === 0) {
      setError('Choose at least one expiry reminder.');
      return;
    }

    setSaving(true);
    setNotice(null);
    setWarning(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      });
      const data = (await res.json()) as Payload;
      if (!data.success) {
        setError(data.error ?? 'Your settings could not be saved.');
        return;
      }
      setError(null);
      setNotice(data.message ?? 'Your preferences have been saved.');
      setWarning(data.warning ?? null);
      if (data.preferences) setPrefs(data.preferences);
      /*
       * The interface follows the saved choice immediately.
       *
       * Without this the language select was a write-only control: the value reached
       * the database, the banner said it had been saved, and every word on the screen
       * stayed in English — which is indistinguishable from the setting not working.
       * `adoptLocale` rather than `setLocale`, because the PATCH above has already
       * persisted it and there is nothing to write back.
       */
      if (isLocale(data.preferences?.language) && data.preferences.language !== locale) {
        adoptLocale(data.preferences.language);
      }
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading your settings…</p>
      </div>
    );
  }

  if (!prefs || !payload) {
    return (
      <div className={styles.page}>
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error ?? 'Your settings could not be loaded.'}</span>
        </div>
      </div>
    );
  }

  const channels = payload.channels;

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Settings</h1>
          <p>How and when VTULA contacts you, and in which language.</p>
        </div>
      </div>

      <div className={styles.container}>
        {notice && (
          <div className={styles.successBanner}>
            <CheckCircle2 size={18} />
            <span>{notice}</span>
          </div>
        )}
        {warning && (
          <div className={styles.warnBox}>
            <AlertTriangle size={17} />
            <span>{warning}</span>
          </div>
        )}
        {error && (
          <div className={styles.errorBox}>
            <AlertTriangle size={17} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={save} className={styles.card}>
          <h2>
            <Bell size={17} />
            How you are contacted
          </h2>
          <p className={styles.sectionNote}>
            Statutory reminders always appear on your notifications page. These decide whether they
            also reach you outside the portal.
          </p>

          <ChannelToggle
            icon={<Inbox size={16} />}
            title="On the notifications page"
            description="Every alert, kept in the portal."
            channel={channels?.inApp}
            checked={prefs.notifyInApp}
            onChange={(v) => toggle('notifyInApp', v)}
          />
          <ChannelToggle
            icon={<Mail size={16} />}
            title="Email"
            description="Certificate links, verification outcomes and expiry reminders."
            channel={channels?.email}
            checked={prefs.notifyEmail}
            onChange={(v) => toggle('notifyEmail', v)}
          />
          <ChannelToggle
            icon={<MessageSquare size={16} />}
            title="WhatsApp"
            description="The same alerts, delivered to your mobile number."
            channel={channels?.whatsapp}
            checked={prefs.notifyWhatsapp}
            onChange={(v) => toggle('notifyWhatsapp', v)}
          />
          <ChannelToggle
            icon={<Smartphone size={16} />}
            title="SMS"
            description="Short alerts for scheduled visits and outcomes. Sign-in OTPs are always sent by SMS regardless of this setting."
            channel={channels?.sms}
            checked={prefs.notifySms}
            onChange={(v) => toggle('notifySms', v)}
          />

          <h2 style={{ marginTop: 30 }}>
            <CalendarClock size={17} />
            Expiry reminders
          </h2>
          <p className={styles.sectionNote}>
            How many days before a certificate expires you want to be reminded. Re-verification takes
            time to schedule, so the first reminder is worth setting early. Choose up to{' '}
            {MAX_OFFSETS}.
          </p>
          <div className={styles.offsets}>
            {OFFSET_CHOICES.map((day) => {
              const on = prefs.expiryReminderDays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={`${styles.offsetChip} ${on ? styles.offsetChipActive : ''}`}
                  onClick={() => toggleOffset(day)}
                  aria-pressed={on}
                >
                  {day} day{day === 1 ? '' : 's'}
                </button>
              );
            })}
          </div>
          {prefs.expiryReminderDays.length > 0 && (
            <p className={styles.hint}>
              You will be reminded {prefs.expiryReminderDays.join(', ')} days before expiry.
            </p>
          )}

          <h2 style={{ marginTop: 30 }}>
            <Languages size={17} />
            Language
          </h2>
          <p className={styles.sectionNote}>
            Sets the language of the portal, and follows you to any device you sign in on.
            The choice takes effect when you save; the globe in the top bar changes the
            portal immediately without saving this page. Emails and SMS are still written
            in English — this setting does not yet change them.
          </p>
          <div className={styles.languageRow}>
            <select
              className="clay-input clay-select"
              value={prefs.language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-label="Language"
            >
              {(payload.languages ?? [{ code: 'en', label: 'English' }]).map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.actions}>
            <button type="submit" className="clay-btn clay-btn-primary" disabled={saving}>
              {saving ? <Loader2 size={18} className={styles.spin} /> : <Save size={18} />}
              Save preferences
            </button>
          </div>
        </form>

        {/*
          * Platform capabilities, not preferences. Shown because they explain
          * behaviour a user would otherwise find baffling — an unsigned
          * certificate, or an OTP that arrives in the server log.
          */}
        {payload.platform && (
          <section className={styles.card}>
            <h2>
              <ServerCog size={17} />
              Platform status
            </h2>
            <p className={styles.sectionNote}>
              Set by the department&apos;s administrators, not here.
            </p>

            <div className={styles.statusRow}>
              {payload.platform.certificateSigning.enabled ? (
                <ShieldCheck size={17} className={styles.okIcon} />
              ) : (
                <ShieldAlert size={17} className={styles.warnIcon} />
              )}
              <div>
                <strong>
                  Certificate signing ·{' '}
                  {payload.platform.certificateSigning.enabled ? 'Active' : 'Not configured'}
                </strong>
                <p>
                  {payload.platform.certificateSigning.note ??
                    `Certificates are signed with ${payload.platform.certificateSigning.algorithm}.`}
                </p>
              </div>
            </div>

            <div className={styles.statusRow}>
              <Info size={17} className={styles.infoIcon} />
              <div>
                <strong>Document storage · {payload.platform.documentStorage.provider}</strong>
                {payload.platform.documentStorage.note && (
                  <p>{payload.platform.documentStorage.note}</p>
                )}
              </div>
            </div>

            <div className={styles.statusRow}>
              <Info size={17} className={styles.infoIcon} />
              <div>
                <strong>
                  Sign-in OTP ·{' '}
                  {payload.platform.otp.provider === 'twilio-verify'
                    ? 'Twilio Verify'
                    : 'Development mock'}
                </strong>
                {payload.platform.otp.provider !== 'twilio-verify' && (
                  <p>
                    OTPs are written to the server log instead of being sent. Do not use this
                    configuration with real users.
                  </p>
                )}
              </div>
            </div>
          </section>
        )}

        {/*
          * The one control on this page that does something to other people's
          * records rather than the reader's own, so it lives at the bottom and
          * states its consequences.
          */}
        {payload.platform?.alertSweep && (
          <AlertSweepCard sweep={payload.platform.alertSweep} onRan={() => void load()} />
        )}
      </div>
    </div>
  );
}

/**
 * The alert sweep, for an administrator.
 *
 * `POST /api/alerts/run` sends the expiry reminders, marks lapsed certificates
 * expired, runs the risk detectors and refreshes compliance scores. Nothing in the
 * product called it. On an installation with no scheduler that meant the entire
 * proactive half of the system — every reminder a business relies on to renew
 * before it lapses — silently never happened, and there was no screen anywhere
 * that would have shown it.
 *
 * A manual run is not a substitute for a scheduler and does not pretend to be. It
 * is here so an administrator can refresh the figures before a review, and so the
 * last-run time is visible at all.
 */
function AlertSweepCard({
  sweep,
  onRan,
}: {
  sweep: NonNullable<NonNullable<Payload['platform']>['alertSweep']>;
  onRan: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<SweepReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setFailed(null);
    setReport(null);
    try {
      const res = await fetch('/api/alerts/run', { method: 'POST' });
      const data = (await res.json()) as { success?: boolean; error?: string; report?: SweepReport };
      if (!res.ok || !data.success || !data.report) {
        setFailed(data.error ?? 'The sweep did not complete.');
        return;
      }
      setReport(data.report);
      onRan();
    } catch {
      setFailed('The sweep could not be started. Check your connection and try again.');
    } finally {
      setRunning(false);
    }
  }

  const riskTypes = report ? Object.entries(report.risk.byType).filter(([, n]) => n > 0) : [];
  const problems = report ? [...report.lifecycle.errors, ...report.compliance.errors] : [];

  return (
    <section className={styles.card}>
      <h2>
        <RefreshCw size={17} />
        Alert sweep
      </h2>
      <p className={styles.sectionNote}>
        Sends due expiry reminders, moves lapsed certificates to expired, runs the risk
        detectors and recalculates compliance scores. Everything it does is idempotent, so
        running it twice in a row is harmless — the second run simply finds nothing new to
        send.
      </p>

      {/* An unscheduled installation is the failure worth naming: it looks identical
          to a healthy one until a business is never warned about an expiry. */}
      <div className={styles.statusRow}>
        {sweep.schedulerConfigured ? (
          <ShieldCheck size={17} className={styles.okIcon} />
        ) : (
          <ShieldAlert size={17} className={styles.warnIcon} />
        )}
        <div>
          <strong>
            Scheduled runs ·{' '}
            {sweep.schedulerConfigured ? 'Enabled' : 'Not configured'}
          </strong>
          <p>
            {sweep.schedulerConfigured
              ? 'A scheduler can run the sweep unattended with its own credential. Reminders go out without anyone opening this page.'
              : 'CRON_SECRET is not set, so nothing runs this automatically. Until it is, reminders are only sent when an administrator runs the sweep by hand — a certificate can lapse with no warning ever reaching the business.'}
          </p>
        </div>
      </div>

      <div className={styles.statusRow}>
        <History size={17} className={styles.infoIcon} />
        <div>
          <strong>
            Last run ·{' '}
            {sweep.lastRunAt
              ? `${formatDateTime(sweep.lastRunAt)}${
                  sweep.lastRunBy ? ` (${sweep.lastRunBy})` : ''
                }`
              : 'Never'}
          </strong>
          <p>
            {sweep.lastRunDetails ??
              'No sweep has been recorded on this installation, so no expiry reminder has been sent and no risk flag has been raised by the detectors.'}
          </p>
        </div>
      </div>

      <div className={styles.sweepActions}>
        <button
          type="button"
          className="clay-btn clay-btn-primary"
          onClick={() => void run()}
          disabled={running}
        >
          {running ? <Loader2 size={16} className={styles.spin} /> : <RefreshCw size={16} />}
          {running ? 'Running the sweep…' : 'Run the sweep now'}
        </button>
        {running && (
          <span className={styles.sweepHint}>
            This can take up to a minute. Leave the page open.
          </span>
        )}
      </div>

      {failed && (
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{failed}</span>
        </div>
      )}

      {report && (
        <div className={styles.sweepReport}>
          <p className={styles.sweepScope}>
            Swept {report.scope === 'national' ? 'the whole register' : report.scope} in{' '}
            {(report.durationMs / 1000).toFixed(1)}s.
          </p>
          <ul className={styles.sweepFigures}>
            <li>
              <strong>{report.lifecycle.remindersSent}</strong>
              <span>expiry reminders sent</span>
            </li>
            <li>
              <strong>{report.lifecycle.markedExpiringSoon}</strong>
              <span>certificates now expiring soon</span>
            </li>
            <li>
              <strong>{report.lifecycle.markedExpired}</strong>
              <span>certificates marked expired</span>
            </li>
            <li>
              <strong>{report.lifecycle.instrumentsMarkedExpired}</strong>
              <span>instruments marked lapsed</span>
            </li>
            <li>
              <strong>{report.risk.detected}</strong>
              <span>risk flags raised</span>
            </li>
            <li>
              <strong>{report.compliance.ownersScored}</strong>
              <span>compliance scores refreshed</span>
            </li>
          </ul>
          {riskTypes.length > 0 && (
            <p className={styles.sweepHint}>
              Flags by type: {riskTypes.map(([t, n]) => `${t} (${n})`).join(', ')}.
            </p>
          )}
          {/* Reported rather than swallowed: a sweep that scored 400 owners and
              failed on 3 is a partial success, and the 3 are the interesting part. */}
          {problems.length > 0 && (
            <div className={styles.errorBox}>
              <AlertTriangle size={17} />
              <div>
                <strong>
                  {problems.length} {problems.length === 1 ? 'record' : 'records'} could not be
                  processed
                </strong>
                <ul className={styles.sweepErrors}>
                  {problems.slice(0, 5).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {report.lifecycle.scanned === 0 && (
            <p className={styles.sweepHint}>
              Nothing was in scope: no certificate is close enough to expiry to need a
              reminder.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ChannelToggle({
  icon,
  title,
  description,
  channel,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  channel?: Channel;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleText}>
        <strong>
          {icon}
          {title}
        </strong>
        <p>{description}</p>
        {channel?.destination && (
          <span className={styles.destination}>
            To {channel.destination}
            {channel.verified === false ? ' · not verified yet' : ''}
          </span>
        )}
        {/* The honest part: a toggle that cannot deliver says so. */}
        {checked && channel?.note && (
          <span className={styles.channelNote}>
            <AlertTriangle size={12} />
            {channel.note}
            {channel.verified === false && (
              <>
                {' '}
                <Link href="/dashboard/profile">Update your profile</Link>
              </>
            )}
          </span>
        )}
      </div>
      <label className={styles.switch}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className={styles.slider} />
      </label>
    </div>
  );
}
