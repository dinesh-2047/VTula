'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, Send, Loader2, CheckCircle2, ChevronDown, ShieldAlert } from 'lucide-react';
import type { VerifyOutcome } from '@/lib/publicVerify';
import styles from './verify.module.css';

/**
 * Public complaint intake, from the trust page.
 *
 * `POST /api/enforcement` has always had an unauthenticated branch built for
 * exactly this — the spec's verification story ends with a customer who has just
 * discovered that the pump they are standing at is running on a lapsed
 * certificate. Nothing called it. The trust page simply stopped at "Certificate
 * Expired" and left the citizen with a fact and no lever.
 *
 * What the server decides, and this form therefore does not offer:
 *  - severity (a complainant does not get to mark their own report HIGH),
 *  - case type (fixed at PUBLIC_COMPLAINT),
 *  - jurisdiction (derived from the instrument, because a complainant naming
 *    their own district would route the case away from the office that should
 *    see it).
 *
 * Contact details are optional and the form says why leaving them out is a real
 * choice rather than a hidden penalty: the server treats a report with no contact
 * as anonymous and still acts on it.
 */

interface Props {
  certNo: string;
  certExists: boolean;
  outcome: VerifyOutcome;
  /** Opened by default when the instrument is not currently legal for trade. */
  startExpanded?: boolean;
}

/** Enough of a starting point that a citizen is not staring at a blank box. */
const TITLE_SUGGESTIONS: Partial<Record<VerifyOutcome, string>> = {
  EXPIRED: 'Instrument in use with an expired certificate',
  SUSPENDED: 'Instrument in use while its certificate is suspended',
  REVOKED: 'Instrument in use after its certificate was revoked',
  SUPERSEDED: 'Sticker shows a certificate that has been replaced',
  NOT_FOUND: 'Sticker shows a certificate number that does not exist',
  INTEGRITY_FAILED: 'Certificate could not be authenticated',
  VALID: 'Suspected short measure',
  EXPIRING_SOON: 'Suspected short measure',
};

const MIN_DESCRIPTION = 20;

export default function ReportProblem({ certNo, certExists, outcome, startExpanded }: Props) {
  const [open, setOpen] = useState(Boolean(startExpanded));
  const [title, setTitle] = useState(TITLE_SUGGESTIONS[outcome] ?? '');
  const [description, setDescription] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [anonymous, setAnonymous] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ caseNo: string; message: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/enforcement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          /*
           * The certificate number is the only subject sent. When the number does
           * not resolve the server refuses the report and says to use the serial
           * number instead — which is correct: a complaint against a number that
           * does not exist cannot be routed to any office.
           */
          certNo,
          title: title.trim(),
          description: description.trim(),
          isAnonymous: anonymous,
          contactName: anonymous ? undefined : contactName.trim() || undefined,
          contactPhone: anonymous ? undefined : contactPhone.trim() || undefined,
          contactEmail: anonymous ? undefined : contactEmail.trim() || undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error ?? 'The report could not be filed. Please try again.');
        return;
      }

      setFiled({ caseNo: data.caseNo, message: data.message });
    } catch {
      setError('The report could not be sent. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (filed) {
    return (
      <section className={`${styles.card} ${styles.reportFiled}`}>
        <h2>
          <CheckCircle2 size={18} />
          Report filed
        </h2>
        <p className={styles.reportRef}>{filed.caseNo}</p>
        <p className={styles.matchNote}>{filed.message}</p>
      </section>
    );
  }

  return (
    <section className={`${styles.card} ${styles.reportCard}`}>
      <button
        type="button"
        className={styles.reportToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ShieldAlert size={18} />
        <span>
          <strong>Something wrong with this instrument?</strong>
          <em>
            Report it to the Legal Metrology office for the district where it is installed. No
            account needed.
          </em>
        </span>
        <ChevronDown size={18} className={open ? styles.chevronOpen : undefined} />
      </button>

      {open && (
        <form onSubmit={submit} className={styles.reportForm}>
          {!certExists && (
            <p className={styles.reportWarn}>
              <AlertTriangle size={15} />
              <span>
                No certificate carries this number, so a report cannot be attached to it. If the
                sticker is on a real machine,{' '}
                <Link href="/report" className={styles.inlineLink}>
                  report it by the serial number stamped on the instrument
                </Link>{' '}
                instead, or contact your district Legal Metrology office.
              </span>
            </p>
          )}

          <label className={styles.field}>
            <span>What is wrong?</span>
            <input
              className="clay-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="A short summary"
              minLength={5}
              maxLength={140}
              required
            />
          </label>

          <label className={styles.field}>
            <span>Describe what you saw</span>
            <textarea
              className="clay-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Where the instrument is, what happened, and when. An officer has to be able to act on this without calling you."
              rows={4}
              minLength={MIN_DESCRIPTION}
              maxLength={2000}
              required
            />
            <em className={styles.fieldHint}>
              {description.trim().length < MIN_DESCRIPTION
                ? `At least ${MIN_DESCRIPTION - description.trim().length} more character${
                    MIN_DESCRIPTION - description.trim().length === 1 ? '' : 's'
                  } — a one-word report cannot be investigated.`
                : `${description.trim().length} characters.`}
            </em>
          </label>

          <label className={styles.checkLine}>
            <input
              type="checkbox"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            <span>
              File anonymously. The department still investigates, but cannot come back to you for
              details or tell you the outcome.
            </span>
          </label>

          {!anonymous && (
            <div className={styles.contactGrid}>
              <label className={styles.field}>
                <span>Your name</span>
                <input
                  className="clay-input"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  maxLength={120}
                />
              </label>
              <label className={styles.field}>
                <span>Phone</span>
                <input
                  className="clay-input"
                  type="tel"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  maxLength={20}
                />
              </label>
              <label className={styles.field}>
                <span>Email</span>
                <input
                  className="clay-input"
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  maxLength={160}
                />
              </label>
            </div>
          )}

          {error && (
            <p className={styles.reportWarn}>
              <AlertTriangle size={15} />
              <span>{error}</span>
            </p>
          )}

          <div className={styles.reportActions}>
            <button
              type="submit"
              className="clay-btn clay-btn-primary"
              disabled={
                submitting || title.trim().length < 5 || description.trim().length < MIN_DESCRIPTION
              }
            >
              {submitting ? <Loader2 size={16} className={styles.spin} /> : <Send size={16} />}
              {submitting ? 'Filing…' : 'File the report'}
            </button>
            <span className={styles.matchNote}>
              Filing a knowingly false report is itself an offence. Reports are rate-limited.
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
