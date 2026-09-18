'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  IndianRupee,
  Loader2,
  MapPin,
  Paperclip,
  Scale,
  ScrollText,
  Send,
  ShieldAlert,
  UserCheck,
} from 'lucide-react';
import {
  ENFORCEMENT_CASE_STATUS_LABELS,
  ENFORCEMENT_CASE_TYPE_LABELS,
  enforcementStatusBadgeClass,
  formatDate,
  formatDateTime,
  formatInr,
  type EnforcementCaseStatus,
  type EnforcementCaseType,
} from '@/lib/constants';
import styles from './ownerCase.module.css';

/**
 * An enforcement case, read by the business it is against.
 *
 * This exists because the system was already telling businesses that cases had been
 * opened against them. Both intake paths send the owner a notification with a "View
 * the case" button, and that button led to a 403 — notice of a case, followed by a
 * refusal to show it. The API now serves a redacted case to the owner, and this is
 * that case.
 *
 * Three rules shaped the page:
 *
 *  - **It says what it does not show, and why.** The complainant is withheld and the
 *    officer's working notes are withheld. Silently omitting them would read as a
 *    complete record; saying so plainly is the difference between confidentiality
 *    and concealment.
 *  - **The right of reply is the primary action.** Notice without an opportunity to
 *    answer is half of due process, so the response box is a card in its own right
 *    rather than a link at the bottom, and it says on the button that what is written
 *    becomes a permanent part of the record.
 *  - **`respond.allowed` comes from the server.** Nothing here decides whether a
 *    response is still possible — a closed case or an exhausted limit arrives as a
 *    reason, which is displayed. The same principle as `allowedNextStatuses` on the
 *    officer's console.
 *
 * The stage rail is the officer's rail with the outcomes removed: a business reading
 * "penalty imposed" as a *future* step on their own case would be alarming and
 * misleading, so only the stage reached and the stages behind it are drawn.
 */

export interface OwnerCasePayload {
  viewer: 'OWNER';
  case: {
    id: string;
    caseNo: string;
    caseType: string;
    status: string;
    severity: string;
    title: string;
    description: string;
    origin: string;
    createdAt: string;
    closedAt?: string;
    outcome?: string;
    penalty?: {
      amount?: number;
      currency?: string;
      imposedAt?: string;
      reference?: string;
      paidAt?: string;
    };
    ageDays: number;
  };
  subject: {
    instrument?: {
      _id: string;
      serialNo?: string;
      type?: string;
      brand?: string;
      model?: string;
      capacity?: string;
      installationDistrict?: string;
      address?: string;
    } | null;
    certificate?: {
      _id: string;
      certNo?: string;
      status?: string;
      expiryDate?: string;
    } | null;
  };
  office: {
    state?: string;
    district?: string;
    officer?: { name?: string; designation?: string } | null;
  };
  timeline: { action: string; at: string; note?: string; byOffice: boolean }[];
  evidence: { count: number; types: string[] };
  respond: {
    allowed: boolean;
    used: number;
    limit: number;
    minLength: number;
    blockedReason?: string;
  };
}

/**
 * What each step in the log means to the business, rather than to the officer.
 *
 * "Case opened" and "Complaint filed" are the same event from the outside, and the
 * business is not told which of the two it was through this label — the case type
 * already carries that, and a log entry is not the place to imply an accuser.
 */
const STEP_LABELS: Record<string, string> = {
  FILED: 'Case recorded',
  OPENED: 'Case opened',
  ASSIGNED: 'Assigned to an officer',
  SEVERITY_CHANGED: 'Priority reviewed',
  EVIDENCE_ADDED: 'Material added to the file',
  OWNER_RESPONSE: 'Your response',
  PENALTY_RECORDED: 'Penalty recorded',
  PENALTY_PAID: 'Penalty marked paid',
  NOTE: 'Noted on the file',
  REOPENED: 'Case reopened',
  STATUS_OPEN: 'Returned to triage',
  STATUS_INVESTIGATING: 'Investigation started',
  STATUS_NOTICE_ISSUED: 'Notice issued to you',
  STATUS_HEARING: 'Set down for hearing',
  STATUS_PENALTY_IMPOSED: 'Penalty imposed',
  STATUS_CLOSED: 'Case closed',
  STATUS_DISMISSED: 'Case dismissed',
};

/** The stages a case passes through, in order, for the rail. */
const STAGES = ['OPEN', 'INVESTIGATING', 'NOTICE_ISSUED', 'HEARING', 'PENALTY_IMPOSED'] as const;

const STAGE_LABELS: Record<string, string> = {
  OPEN: 'Recorded',
  INVESTIGATING: 'Being looked into',
  NOTICE_ISSUED: 'Notice issued',
  HEARING: 'Hearing',
  PENALTY_IMPOSED: 'Penalty',
};

function statusLabel(s: string): string {
  return ENFORCEMENT_CASE_STATUS_LABELS[s as EnforcementCaseStatus] ?? s;
}

function stepLabel(code: string): string {
  return STEP_LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

export default function OwnerCaseView({
  data,
  onReload,
}: {
  data: OwnerCasePayload;
  onReload: () => Promise<void>;
}) {
  const { case: c, subject, office, timeline, evidence, respond } = data;

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const closed = c.status === 'CLOSED' || c.status === 'DISMISSED';
  const stageIndex = STAGES.indexOf(c.status as (typeof STAGES)[number]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text.length < respond.minLength) {
      setError(`Write at least ${respond.minLength} characters, so the officer has something to act on.`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/enforcement/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: text }),
      });
      const body = (await res.json()) as { success: boolean; error?: string; message?: string };
      if (!body.success) {
        setError(body.error || 'That could not be recorded.');
        return;
      }
      setDraft('');
      setSent(body.message ?? 'Your response has been added to the case record.');
      await onReload();
    } catch {
      setError('Could not reach the server. Nothing was recorded — try again.');
    } finally {
      setSending(false);
    }
  }, [draft, respond.minLength, c.id, onReload]);

  return (
    <div className={styles.page}>
      <Link href="/dashboard/notifications" className={styles.backLink}>
        <ArrowLeft size={15} />
        Back to notifications
      </Link>

      {/* ── What this is ── */}
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.caseNo}>{c.caseNo}</span>
          <span className={`clay-badge ${enforcementStatusBadgeClass(c.status)}`}>
            {statusLabel(c.status)}
          </span>
        </div>
        <h1>{c.title}</h1>
        <p className={styles.headerType}>
          {ENFORCEMENT_CASE_TYPE_LABELS[c.caseType as EnforcementCaseType] ?? c.caseType} · recorded{' '}
          {formatDate(c.createdAt)}
          {!closed && c.ageDays > 0 && ` · open ${c.ageDays} day${c.ageDays === 1 ? '' : 's'}`}
        </p>
      </header>

      {/*
        * The one thing the business most needs to know, at the top: what is
        * happening and whether it has to do anything. Dismissed and closed are
        * separated because they mean opposite things to the person reading.
        */}
      {c.status === 'DISMISSED' ? (
        <div className={`${styles.verdict} ${styles.verdictOk}`}>
          <CheckCircle2 size={22} />
          <div>
            <strong>This case was dismissed</strong>
            <span>
              The department found the allegation was not made out. Nothing is required of you.
              {c.outcome ? ` Recorded outcome: ${c.outcome}` : ''}
            </span>
          </div>
        </div>
      ) : c.status === 'CLOSED' ? (
        <div className={`${styles.verdict} ${styles.verdictNeutral}`}>
          <CheckCircle2 size={22} />
          <div>
            <strong>This case is closed</strong>
            <span>
              {c.outcome
                ? c.outcome
                : 'The department has finished with it. Its record is now final.'}
            </span>
          </div>
        </div>
      ) : (
        <div className={`${styles.verdict} ${styles.verdictOpen}`}>
          <ShieldAlert size={22} />
          <div>
            <strong>This case is open</strong>
            <span>
              The Legal Metrology office for{' '}
              {office.district ?? office.state ?? 'your area'} is dealing with it. You may add a
              written response below, and the office will contact you about anything it needs. Do
              not use the instrument for trade if you have been told not to.
            </span>
          </div>
        </div>
      )}

      {/* ── Where it has got to ── */}
      {!closed && stageIndex >= 0 && (
        <ol className={styles.rail} aria-label="Progress of the case">
          {STAGES.slice(0, Math.max(stageIndex + 1, 1)).map((stage, i) => (
            <li
              key={stage}
              className={i === stageIndex ? styles.railNow : styles.railDone}
            >
              <span className={styles.railDot} />
              <span>{STAGE_LABELS[stage]}</span>
            </li>
          ))}
        </ol>
      )}

      {/* ── The allegation ── */}
      <section className={styles.card}>
        <h2>
          <ScrollText size={15} />
          What the case says
        </h2>
        <p className={styles.description}>{c.description}</p>
        {/*
          * Said outright. The business is entitled to know the substance of the
          * allegation and is not entitled to know who made it, and a page that
          * quietly omitted the reporter would read as though nobody had.
          */}
        <p className={styles.withheld}>
          If this case began with a report from a member of the public, their identity is not shown
          here and will not be given to you. The officer&apos;s working notes are also not shown —
          anything the department formally requires of you arrives as a notice in its own right.
        </p>
      </section>

      {/* ── What it is about ── */}
      {(subject.instrument || subject.certificate) && (
        <section className={styles.card}>
          <h2>
            <Scale size={15} />
            The instrument concerned
          </h2>
          <dl className={styles.detailList}>
            {subject.instrument?.serialNo && (
              <div className={styles.detailRow}>
                <dt>Serial number</dt>
                <dd>
                  <code>{subject.instrument.serialNo}</code>
                </dd>
              </div>
            )}
            {subject.instrument && (subject.instrument.brand || subject.instrument.model) && (
              <div className={styles.detailRow}>
                <dt>Make and model</dt>
                <dd>
                  {[subject.instrument.brand, subject.instrument.model].filter(Boolean).join(' ')}
                  {subject.instrument.capacity ? ` · ${subject.instrument.capacity}` : ''}
                </dd>
              </div>
            )}
            {subject.instrument?.address && (
              <div className={styles.detailRow}>
                <dt>
                  <MapPin size={13} />
                  Where it is installed
                </dt>
                <dd>{subject.instrument.address}</dd>
              </div>
            )}
            {subject.certificate?.certNo && (
              <div className={styles.detailRow}>
                <dt>Certificate</dt>
                <dd>
                  <Link href={`/verify/${subject.certificate.certNo}`} className={styles.certLink}>
                    {subject.certificate.certNo}
                  </Link>
                  {subject.certificate.expiryDate
                    ? ` · valid until ${formatDate(subject.certificate.expiryDate)}`
                    : ''}
                </dd>
              </div>
            )}
            {subject.instrument?._id && (
              <div className={styles.detailRow}>
                <dt>Registration</dt>
                <dd>
                  <Link
                    href={`/dashboard/instruments/${subject.instrument._id}`}
                    className={styles.certLink}
                  >
                    Open this instrument&apos;s record
                  </Link>
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {/* ── Penalty ── */}
      {c.penalty?.amount != null && (
        <section className={`${styles.card} ${styles.penaltyCard}`}>
          <h2>
            <IndianRupee size={15} />
            Penalty
          </h2>
          <p className={styles.penaltyAmount}>{formatInr(c.penalty.amount)}</p>
          <p className={styles.penaltyMeta}>
            {c.penalty.imposedAt ? `Imposed ${formatDate(c.penalty.imposedAt)}. ` : ''}
            {c.penalty.reference ? `Reference ${c.penalty.reference}. ` : ''}
            {c.penalty.paidAt
              ? `Recorded as paid on ${formatDate(c.penalty.paidAt)}.`
              : 'Not yet recorded as paid. Pay it through the office that issued it, quoting the case number above — this page does not take payment.'}
          </p>
        </section>
      )}

      {/* ── The record ── */}
      <section className={styles.card}>
        <h2>
          <Clock size={15} />
          What has happened, in order
        </h2>
        <ol className={styles.timeline}>
          {timeline.map((t, i) => (
            <li key={`${t.action}-${t.at}-${i}`} className={t.byOffice ? undefined : styles.timelineMine}>
              <span className={styles.timelineDot} />
              <div>
                <strong>{stepLabel(t.action)}</strong>
                <time>{formatDateTime(t.at)}</time>
                {t.note && <p className={styles.timelineNote}>{t.note}</p>}
              </div>
            </li>
          ))}
        </ol>
        {evidence.count > 0 && (
          <p className={styles.evidenceNote}>
            <Paperclip size={13} />
            {evidence.count} {evidence.count === 1 ? 'item' : 'items'} of material on the file
            {evidence.types.length > 0 ? ` (${evidence.types.join(', ')})` : ''}. Copies are provided
            with a formal notice or at a hearing, not through this page.
          </p>
        )}
      </section>

      {/* ── Right of reply ── */}
      <section className={`${styles.card} ${styles.respondCard}`}>
        <h2>
          <Send size={15} />
          Your response
        </h2>

        {sent && (
          <p className={styles.sentBox}>
            <CheckCircle2 size={15} />
            {sent}
          </p>
        )}

        {respond.allowed ? (
          <>
            <p className={styles.respondIntro}>
              Anything you write here is added to the case record, dated, and the officer dealing
              with it is notified. It becomes a permanent part of the file — it cannot be edited or
              withdrawn afterwards, which is what makes it worth having if the case is ever
              challenged.
            </p>
            <textarea
              className="clay-input"
              rows={5}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Explain what happened, what you have done about it, or what you disagree with."
              maxLength={4000}
            />
            <div className={styles.respondFoot}>
              <span className={styles.counter}>
                {draft.trim().length < respond.minLength
                  ? `${respond.minLength - draft.trim().length} more characters needed`
                  : `${draft.length} of 4000 characters`}
              </span>
              <button
                type="button"
                className="clay-btn clay-btn-primary"
                onClick={() => void send()}
                disabled={sending || draft.trim().length < respond.minLength}
              >
                {sending ? <Loader2 size={15} className={styles.spin} /> : <Send size={15} />}
                {sending ? 'Recording…' : 'Add this to the record'}
              </button>
            </div>
            {respond.used > 0 && (
              <p className={styles.respondUsed}>
                You have added {respond.used} of {respond.limit} responses to this case.
              </p>
            )}
          </>
        ) : (
          <p className={styles.blocked}>
            <AlertTriangle size={15} />
            {respond.blockedReason ??
              'A response cannot be added to this case. Contact the Legal Metrology office directly.'}
          </p>
        )}

        {error && (
          <p className={styles.errorBox}>
            <AlertTriangle size={15} />
            {error}
          </p>
        )}
      </section>

      {/* ── Who to contact ── */}
      <section className={styles.card}>
        <h2>
          <UserCheck size={15} />
          Who is dealing with it
        </h2>
        <p className={styles.contactLine}>
          {office.officer?.name
            ? `${office.officer.name}${office.officer.designation ? `, ${office.officer.designation}` : ''}, at the Legal Metrology office for ${office.district ?? office.state ?? 'your area'}.`
            : `No individual officer has taken the case yet. It sits with the Legal Metrology office for ${office.district ?? office.state ?? 'your area'}.`}
        </p>
        <p className={styles.contactNote}>
          Quote <strong>{c.caseNo}</strong> in any letter, call or visit. This page does not carry
          the office&apos;s telephone number because the department has not published one through
          this system — the notice you were sent does.
        </p>
      </section>

      <p className={styles.footNote}>
        You are shown this case because it concerns an instrument registered to your business.
        Cases against other businesses are not visible to you, and the record above is the same
        record the officer is working from, less the two things named at the top.
      </p>
    </div>
  );
}
