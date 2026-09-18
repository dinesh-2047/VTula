'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  Hash,
  Loader2,
  QrCode,
  Send,
  ShieldCheck,
} from 'lucide-react';
import styles from './report.module.css';

/**
 * Reporting an instrument when you do not have a certificate number.
 *
 * The trust page already carries a complaint form, but it can only ever file
 * against the certificate whose verdict is on screen. That leaves out the two
 * commonest real cases: the sticker is missing or unreadable, and the citizen was
 * sent here by a link rather than by a scan. Both of those people have the serial
 * number stamped on the machine, which is what this form accepts.
 *
 * What the server fixes, and this form therefore does not ask:
 *  - case type (always PUBLIC_COMPLAINT),
 *  - severity (a complainant does not triage their own report),
 *  - jurisdiction (derived from the instrument's installation district, because a
 *    complainant naming their own district would route the case away from the
 *    office that has to act on it).
 *
 * Anonymity is the default. It has a real cost — nobody can come back to you for
 * the detail that makes a case winnable — so the form states the cost rather than
 * burying it, and leaves the choice with the person filing.
 */

interface Props {
  /** Prefilled from the URL when a verdict page or a QR link sent the citizen here. */
  initialCertNo?: string;
  initialSerialNo?: string;
}

const TITLE_MIN = 5;
const DESCRIPTION_MIN = 20;

type SubjectMode = 'serialNo' | 'certNo';

export default function ReportForm({ initialCertNo, initialSerialNo }: Props) {
  const [mode, setMode] = useState<SubjectMode>(initialCertNo && !initialSerialNo ? 'certNo' : 'serialNo');
  const [serialNo, setSerialNo] = useState(initialSerialNo ?? '');
  const [certNo, setCertNo] = useState(initialCertNo ?? '');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [anonymous, setAnonymous] = useState(true);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ caseNo: string; message: string } | null>(null);

  const subject = mode === 'serialNo' ? serialNo.trim() : certNo.trim();
  const ready =
    Boolean(subject) &&
    title.trim().length >= TITLE_MIN &&
    description.trim().length >= DESCRIPTION_MIN &&
    !submitting;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/enforcement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // One identifier only. The server resolves a certificate number first,
          // so sending both would quietly ignore whichever the citizen actually
          // read off the machine.
          ...(mode === 'certNo' ? { certNo: certNo.trim() } : { serialNo: serialNo.trim() }),
          title: title.trim(),
          description: description.trim(),
          isAnonymous: anonymous,
          contactName: anonymous ? undefined : contactName.trim() || undefined,
          contactPhone: anonymous ? undefined : contactPhone.trim() || undefined,
          contactEmail: anonymous ? undefined : contactEmail.trim() || undefined,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        caseNo?: string;
        message?: string;
      };

      if (!res.ok || !data.success || !data.caseNo) {
        setError(data.error ?? 'The report could not be filed. Please try again.');
        return;
      }

      setFiled({ caseNo: data.caseNo, message: data.message ?? '' });
    } catch {
      setError('The report could not be sent. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (filed) {
    return (
      <section className={styles.filedCard}>
        <CheckCircle2 size={34} />
        <h2>Report filed</h2>
        <p className={styles.filedRef}>{filed.caseNo}</p>
        <p className={styles.filedMessage}>{filed.message}</p>
        {/*
          * Said plainly because the alternative is worse: a promise of updates
          * that nothing in the system delivers. There is no public status page,
          * so the reference number is the whole of what the citizen holds.
          */}
        <p className={styles.filedNote}>
          Write this number down. There is no public page showing a case&apos;s progress — quote the
          number if you contact the office, and an officer can tell you where it has got to. If you
          left contact details, the department can reach you for anything it needs.
        </p>
        <Link href="/verify" className="clay-btn clay-btn-outline">
          Check another instrument
        </Link>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className={styles.form}>
      {/* ── Which instrument ── */}
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          <Hash size={16} />
          Which instrument
        </h2>

        <div className={styles.modeRow}>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'serialNo' ? styles.modeActive : ''}`}
            onClick={() => setMode('serialNo')}
          >
            I have the serial number
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'certNo' ? styles.modeActive : ''}`}
            onClick={() => setMode('certNo')}
          >
            I have the certificate number
          </button>
        </div>

        {mode === 'serialNo' ? (
          <label className={styles.field}>
            <span>Serial number on the machine</span>
            <input
              className="clay-input"
              value={serialNo}
              onChange={(e) => setSerialNo(e.target.value)}
              placeholder="Stamped or printed on the instrument itself"
              autoComplete="off"
              maxLength={60}
              required
            />
            <em className={styles.fieldHint}>
              Usually on a metal plate or a label on the body of the machine — not on the sticker.
              Capitals, spaces and dashes do not matter.
            </em>
          </label>
        ) : (
          <label className={styles.field}>
            <span>Certificate number on the sticker</span>
            <input
              className="clay-input"
              value={certNo}
              onChange={(e) => setCertNo(e.target.value)}
              placeholder="VT-CERT-2026-000123"
              autoComplete="off"
              maxLength={40}
              required
            />
            <em className={styles.fieldHint}>
              Printed beneath the QR code on the verification sticker.
            </em>
          </label>
        )}

        <p className={styles.subjectNote}>
          <AlertTriangle size={15} />
          <span>
            Your report goes to the Legal Metrology office for the district where the instrument is
            registered, so it has to be matched to a registered instrument first. If neither number
            finds anything, the instrument may not be registered at all — which is itself an offence.
            Contact your district office directly and describe where the machine is.
          </span>
        </p>
      </section>

      {/* ── What is wrong ── */}
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          <ShieldCheck size={16} />
          What is wrong
        </h2>

        <label className={styles.field}>
          <span>In one line</span>
          <input
            className="clay-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Petrol pump appears to deliver less than it shows"
            minLength={TITLE_MIN}
            maxLength={140}
            required
          />
        </label>

        <label className={styles.field}>
          <span>What you saw</span>
          <textarea
            className="clay-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Where the machine is, what happened, and when. Write it for an officer who was not there and may not be able to call you."
            rows={6}
            minLength={DESCRIPTION_MIN}
            maxLength={2000}
            required
          />
          <em
            className={
              description.trim().length < DESCRIPTION_MIN ? styles.fieldHintWarn : styles.fieldHint
            }
          >
            {description.trim().length < DESCRIPTION_MIN
              ? `At least ${DESCRIPTION_MIN - description.trim().length} more character${
                  DESCRIPTION_MIN - description.trim().length === 1 ? '' : 's'
                } — a one-word report cannot be investigated.`
              : `${description.trim().length} characters.`}
          </em>
        </label>
      </section>

      {/* ── Who is reporting ── */}
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          <QrCode size={16} />
          About you
        </h2>

        <label className={styles.checkLine}>
          <input
            type="checkbox"
            checked={anonymous}
            onChange={(e) => setAnonymous(e.target.checked)}
          />
          <span>
            File anonymously. The department still investigates — but it cannot come back to you for
            the detail that often decides a case, and it cannot tell you the outcome.
          </span>
        </label>

        {!anonymous && (
          <>
            <div className={styles.contactGrid}>
              <label className={styles.field}>
                <span>Your name</span>
                <input
                  className="clay-input"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  maxLength={120}
                  autoComplete="name"
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
                  autoComplete="tel"
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
                  autoComplete="email"
                />
              </label>
            </div>
            <p className={styles.fieldHint}>
              Your details are visible to the officers handling the case and are not shown to the
              business the report is about.
            </p>
          </>
        )}
      </section>

      {error && (
        <p className={styles.errorBox}>
          <AlertTriangle size={16} />
          <span>{error}</span>
        </p>
      )}

      <div className={styles.actions}>
        <button type="submit" className="clay-btn clay-btn-primary clay-btn-lg" disabled={!ready}>
          {submitting ? <Loader2 size={17} className={styles.spin} /> : <Send size={17} />}
          {submitting ? 'Filing…' : 'File the report'}
        </button>
        <span className={styles.actionsNote}>
          Filing a report you know to be false is itself an offence. Reports are rate-limited per
          connection.
        </span>
      </div>
    </form>
  );
}
