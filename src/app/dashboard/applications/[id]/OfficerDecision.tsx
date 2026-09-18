'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  ClipboardCheck,
  Gauge,
  Loader2,
  MessageSquareWarning,
  ShieldAlert,
  ShieldCheck,
  Stamp,
  Undo2,
  UserCheck,
  XCircle,
} from 'lucide-react';
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  applicationStatusLabel,
  type ApplicationStatus,
  type DocumentType,
} from '@/lib/constants';
import styles from './application.module.css';

/**
 * The officer's decision panel.
 *
 * Its buttons are generated from the server's `availableTransitions` and a table
 * of per-target metadata — never from a status list written out again here. That
 * matters more than it looks: the state machine and its role table live in
 * `src/lib/workflow.ts`, and a second copy in the UI drifts. When it drifts it
 * offers a button the server then refuses, which the officer reasonably reads as
 * the system being broken, and the fix gets deferred because "it works for me".
 *
 * The obligations the server enforces are surfaced *before* the click rather than
 * after the rejection:
 *   - a decision needs a written justification (`JUSTIFICATION_REQUIRED`);
 *   - an approval needs a submitted inspection that passed (`NO_INSPECTION`,
 *     `INSPECTION_NOT_PASSED`) — so Approve is disabled with the reason shown,
 *     not offered and then refused;
 *   - a query needs a message (`REASON_REQUIRED`).
 *
 * Scheduling is a two-step because the spec rules out unexplained automated
 * decisions: `GET /api/schedules/recommend` returns ranked inspectors with the
 * reasons behind each score, and the officer confirms one. Auto-assign is still a
 * single click, but the ranking it acted on is on screen.
 */

interface OfficerApplication {
  _id: string;
  applicationNo: string;
  status: ApplicationStatus;
  preferredDate?: string;
  jurisdiction?: { state: string; district: string };
}

interface Props {
  application: OfficerApplication;
  availableTransitions: ApplicationStatus[];
  hasPassedInspection: boolean;
  currentInspectionResult: string | null;
  missingDocuments: string[];
  onChanged: () => Promise<void> | void;
}

/** What each target status is called from the officer's side, and what it needs. */
type Need = 'none' | 'reason' | 'justification' | 'query' | 'schedule';

const ACTIONS: Partial<
  Record<
    ApplicationStatus,
    {
      label: string;
      icon: React.ReactNode;
      variant: string;
      need: Need;
      /** Shown above the form, in the officer's own terms. */
      blurb?: string;
    }
  >
> = {
  UNDER_REVIEW: {
    label: 'Start reviewing',
    icon: <ClipboardCheck size={16} />,
    variant: 'clay-btn-primary',
    need: 'none',
    blurb: 'Takes the file out of the unassigned queue and puts it on your desk.',
  },
  QUERY_RAISED: {
    label: 'Ask the applicant for something',
    icon: <MessageSquareWarning size={16} />,
    variant: 'clay-btn-outline',
    need: 'query',
  },
  APPROVED_FOR_SCHEDULING: {
    label: 'Paperwork is in order',
    icon: <CheckCircle2 size={16} />,
    variant: 'clay-btn-primary',
    need: 'none',
    blurb: 'Clears the documents and moves the application into the scheduling queue.',
  },
  SCHEDULED: {
    label: 'Book the inspection',
    icon: <CalendarCheck size={16} />,
    variant: 'clay-btn-primary',
    need: 'schedule',
  },
  INSPECTION_IN_PROGRESS: {
    label: 'Send back for re-inspection',
    icon: <Undo2 size={16} />,
    variant: 'clay-btn-outline',
    need: 'reason',
    blurb:
      'Reopens the inspection. The existing readings stay on the record — a correction is filed as a new version, never an edit.',
  },
  INSPECTION_SUBMITTED: {
    label: 'Mark the inspection complete',
    icon: <Gauge size={16} />,
    variant: 'clay-btn-primary',
    need: 'none',
  },
  UNDER_DECISION: {
    label: 'Take this for decision',
    icon: <ClipboardCheck size={16} />,
    variant: 'clay-btn-primary',
    need: 'none',
    blurb: 'You are recorded as the deciding officer from this point.',
  },
  APPROVED: {
    label: 'Approve',
    icon: <CheckCircle2 size={16} />,
    variant: 'clay-btn-primary',
    need: 'justification',
  },
  REJECTED: {
    label: 'Reject',
    icon: <XCircle size={16} />,
    variant: 'clay-btn-outline',
    need: 'justification',
  },
  CERTIFICATE_GENERATED: {
    label: 'Issue the certificate',
    icon: <Stamp size={16} />,
    variant: 'clay-btn-primary',
    need: 'none',
    blurb:
      'Signs and issues the verification certificate, then makes the instrument live. This is what the trader displays.',
  },
  SUSPENDED: {
    label: 'Suspend the certificate',
    icon: <ShieldAlert size={16} />,
    variant: 'clay-btn-outline',
    need: 'reason',
    blurb:
      'The instrument may not be used for trade while suspended. Reversible once the ground is cleared.',
  },
  REVOKED: {
    label: 'Revoke the certificate',
    icon: <ShieldAlert size={16} />,
    variant: 'clay-btn-outline',
    need: 'reason',
    blurb: 'Final. The certificate is withdrawn and cannot be restored.',
  },
  ACTIVE: {
    label: 'Restore the certificate',
    icon: <ShieldCheck size={16} />,
    variant: 'clay-btn-primary',
    need: 'reason',
  },
  EXPIRED: {
    label: 'Mark as expired',
    icon: <XCircle size={16} />,
    variant: 'clay-btn-ghost',
    need: 'reason',
  },
  CANCELLED: {
    label: 'Cancel the application',
    icon: <XCircle size={16} />,
    variant: 'clay-btn-ghost',
    need: 'reason',
  },
  DRAFT: {
    label: 'Return to the applicant as a draft',
    icon: <Undo2 size={16} />,
    variant: 'clay-btn-ghost',
    need: 'reason',
  },
};

interface Candidate {
  userId: string;
  name: string;
  role: string;
  designation?: string;
  district?: string;
  score: number;
  reasons: string[];
  openLoad: number;
  loadOnDate: number;
  categoryApproved: boolean;
}

export default function OfficerDecision({
  application: app,
  availableTransitions,
  hasPassedInspection,
  currentInspectionResult,
  missingDocuments,
  onChanged,
}: Props) {
  const [open, setOpen] = useState<ApplicationStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [reason, setReason] = useState('');
  const [legalReference, setLegalReference] = useState('');
  const [requested, setRequested] = useState<DocumentType[]>([]);
  const [queryDueDays, setQueryDueDays] = useState(7);

  // Scheduling
  const [visitDate, setVisitDate] = useState(defaultVisitDate(app.preferredDate));
  const [slotStart, setSlotStart] = useState('10:00');
  const [slotEnd, setSlotEnd] = useState('12:00');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [chosen, setChosen] = useState<string>('');
  const [recommendNote, setRecommendNote] = useState<string | null>(null);

  const offered = availableTransitions.filter((t) => ACTIONS[t]);

  function reset() {
    setOpen(null);
    setError(null);
    setReason('');
    setLegalReference('');
    setRequested([]);
    setQueryDueDays(7);
    setCandidates(null);
    setChosen('');
    setRecommendNote(null);
  }

  /** Why Approve cannot be pressed yet, or null when it can. */
  const approvalBlocker = !hasPassedInspection
    ? currentInspectionResult
      ? `The inspection result is ${currentInspectionResult}. An application cannot be approved on an inspection that did not pass — reject it, or send it back for re-inspection.`
      : 'No submitted inspection exists yet. An approval has to rest on recorded readings.'
    : null;

  async function post(
    to: ApplicationStatus,
    body: Record<string, unknown>,
    successNote: string
  ): Promise<void> {
    setBusy(to);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/applications/${app._id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, ...body }),
      });
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        certificate?: { certNo: string; expiryDate: string };
      };
      if (!data.success) {
        setError(data.error || 'The action could not be completed.');
        return;
      }
      setNotice(
        data.certificate
          ? `Certificate ${data.certificate.certNo} issued, valid until ${new Date(
              data.certificate.expiryDate
            ).toLocaleDateString('en-IN')}.`
          : successNote
      );
      reset();
      await onChanged();
    } catch {
      setError('Could not reach the server. Nothing has changed.');
    } finally {
      setBusy(null);
    }
  }

  const loadCandidates = useCallback(
    async (dateISO: string) => {
      setBusy('recommend');
      setError(null);
      try {
        const res = await fetch(
          `/api/schedules/recommend?applicationId=${app._id}&date=${encodeURIComponent(dateISO)}`
        );
        const data = (await res.json()) as {
          success: boolean;
          error?: string;
          candidates?: Candidate[];
          note?: string;
        };
        if (!data.success) {
          setError(data.error || 'The inspector list could not be loaded.');
          setCandidates([]);
          return;
        }
        setCandidates(data.candidates ?? []);
        setRecommendNote(data.note ?? null);
        // Pre-select the best fit; the officer can override, and the reasons for
        // every candidate stay visible either way.
        setChosen(data.candidates?.[0]?.userId ?? '');
      } catch {
        setError('Could not reach the server to rank inspectors.');
        setCandidates([]);
      } finally {
        setBusy(null);
      }
    },
    [app._id]
  );

  async function openSchedulePanel() {
    setOpen('SCHEDULED');
    setError(null);
    setNotice(null);
    await loadCandidates(visitDate);
  }

  async function bookInspection() {
    if (!visitDate) {
      setError('Choose a date for the visit.');
      return;
    }
    setBusy('SCHEDULED');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: app._id,
          // Empty means "take the best-ranked candidate", which is what the
          // endpoint does when no assignee is named.
          assignedTo: chosen || undefined,
          scheduledDate: visitDate,
          slotStart: slotStart || undefined,
          slotEnd: slotEnd || undefined,
          note: reason.trim() || undefined,
        }),
      });
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        assignee?: { name: string; role: string };
        schedule?: { scheduledDate: string };
      };
      if (!data.success) {
        setError(data.error || 'The inspection could not be booked.');
        return;
      }
      setNotice(
        `Booked with ${data.assignee?.name ?? 'the assigned inspector'} for ${new Date(
          visitDate
        ).toLocaleDateString('en-IN')}. The applicant has been notified.`
      );
      reset();
      await onChanged();
    } catch {
      setError('Could not reach the server. Nothing has been booked.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`${styles.card} ${styles.decisionCard}`}>
      <h2>
        <UserCheck size={15} />
        Officer actions
      </h2>

      {error && (
        <p className={styles.formError}>
          <AlertTriangle size={16} />
          <span>{error}</span>
        </p>
      )}
      {notice && (
        <p className={styles.formOk}>
          <CheckCircle2 size={16} />
          <span>{notice}</span>
        </p>
      )}

      {offered.length === 0 && (
        <p className={styles.formNote}>
          There is nothing for you to do on this application at {applicationStatusLabel(app.status)}
          {availableTransitions.length === 0
            ? '. It has reached the end of its workflow.'
            : ' — the next move belongs to another role.'}
        </p>
      )}

      {/* ── The buttons, when no form is open ── */}
      {open === null && offered.length > 0 && (
        <div className={styles.actionStack}>
          {offered.map((to) => {
            const meta = ACTIONS[to]!;
            const blocked = to === 'APPROVED' ? approvalBlocker : null;
            return (
              <div key={to}>
                <button
                  type="button"
                  className={`clay-btn ${meta.variant}`}
                  style={{ width: '100%' }}
                  disabled={busy !== null || Boolean(blocked)}
                  title={blocked ?? undefined}
                  onClick={() => {
                    if (blocked) return;
                    if (to === 'SCHEDULED') {
                      void openSchedulePanel();
                    } else if (meta.need === 'none') {
                      void post(
                        to,
                        {},
                        `Moved to ${applicationStatusLabel(to)}.`
                      );
                    } else {
                      setOpen(to);
                      setError(null);
                      setNotice(null);
                    }
                  }}
                >
                  {busy === to ? <Loader2 size={16} className={styles.spin} /> : meta.icon}
                  {meta.label}
                </button>
                {blocked && <span className={styles.hint}>{blocked}</span>}
              </div>
            );
          })}

          {missingDocuments.length > 0 && (
            <p className={styles.formWarn} style={{ marginTop: 6, marginBottom: 0 }}>
              <AlertTriangle size={16} />
              <span>
                {missingDocuments.length} document
                {missingDocuments.length === 1 ? '' : 's'} required by the applicable rule{' '}
                {missingDocuments.length === 1 ? 'is' : 'are'} still missing. Raise a query rather
                than clearing the paperwork.
              </span>
            </p>
          )}
        </div>
      )}

      {/* ── Query form ── */}
      {open === 'QUERY_RAISED' && (
        <div className={styles.form}>
          <div className={styles.field}>
            <label className="clay-label" htmlFor="queryMessage">
              What does the applicant need to provide? *
            </label>
            <textarea
              id="queryMessage"
              className="clay-input"
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. The purchase invoice is illegible — please upload a clear scan showing the serial number."
            />
            <span className={styles.hint}>
              This is sent to the applicant as written. The application stops here until they answer.
            </span>
          </div>

          <div className={styles.field}>
            <span className="clay-label">Documents to request</span>
            <div className={styles.checkGrid}>
              {DOCUMENT_TYPES.filter((t) => t !== 'INSPECTION_EVIDENCE').map((t) => (
                <label key={t} className={styles.checkItem}>
                  <input
                    type="checkbox"
                    checked={requested.includes(t)}
                    onChange={(e) =>
                      setRequested((prev) =>
                        e.target.checked ? [...prev, t] : prev.filter((x) => x !== t)
                      )
                    }
                  />
                  <span>{DOCUMENT_TYPE_LABELS[t]}</span>
                </label>
              ))}
            </div>
            {missingDocuments.length > 0 && (
              <span className={styles.hint}>
                The rule for this application also requires:{' '}
                {missingDocuments
                  .map((t) => DOCUMENT_TYPE_LABELS[t as DocumentType] ?? t)
                  .join(', ')}
                .
              </span>
            )}
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="dueDays">
              Days allowed to respond
            </label>
            <input
              id="dueDays"
              type="number"
              min={1}
              max={90}
              className="clay-input"
              value={queryDueDays}
              onChange={(e) => setQueryDueDays(Number(e.target.value))}
              style={{ maxWidth: 120 }}
            />
          </div>

          <div className={styles.formActions}>
            <button type="button" className="clay-btn clay-btn-ghost" onClick={reset} disabled={busy !== null}>
              Cancel
            </button>
            <button
              type="button"
              className="clay-btn clay-btn-primary"
              disabled={busy !== null}
              onClick={() => {
                if (!reason.trim()) {
                  setError('Describe what the applicant needs to provide.');
                  return;
                }
                void post(
                  'QUERY_RAISED',
                  {
                    reason: reason.trim(),
                    requestedDocuments: requested,
                    queryDueDays,
                  },
                  'The query has been sent to the applicant.'
                );
              }}
            >
              {busy === 'QUERY_RAISED' ? (
                <Loader2 size={16} className={styles.spin} />
              ) : (
                <MessageSquareWarning size={16} />
              )}
              Send query
            </button>
          </div>
        </div>
      )}

      {/* ── Decision form ── */}
      {(open === 'APPROVED' || open === 'REJECTED') && (
        <div className={styles.form}>
          <p className={open === 'APPROVED' ? styles.formNote : styles.formWarn}>
            {open === 'REJECTED' && <AlertTriangle size={16} />}
            <span>
              {open === 'APPROVED'
                ? 'Approving records you as the deciding officer. The certificate is issued in a second, separate step.'
                : 'A rejection is on the applicant’s record and sets the instrument back to unverified. The justification is shown to them in full.'}
            </span>
          </p>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="justification">
              Justification *
            </label>
            <textarea
              id="justification"
              className="clay-input"
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                open === 'APPROVED'
                  ? 'e.g. All readings within Class III tolerance; seal intact; documents verified.'
                  : 'e.g. Error at 50 kg test point is 0.42%, outside the 0.1% permitted for Class III.'
              }
            />
            <span className={styles.hint}>
              Recorded permanently against the application and readable by the applicant.
            </span>
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="legalRef">
              Legal reference
            </label>
            <input
              id="legalRef"
              className="clay-input"
              value={legalReference}
              onChange={(e) => setLegalReference(e.target.value)}
              placeholder="e.g. Legal Metrology Act 2009, s.24"
            />
            <span className={styles.hint}>
              The provision the decision rests on. Optional, but it is what an appeal turns on.
            </span>
          </div>

          <div className={styles.formActions}>
            <button type="button" className="clay-btn clay-btn-ghost" onClick={reset} disabled={busy !== null}>
              Cancel
            </button>
            <button
              type="button"
              className="clay-btn clay-btn-primary"
              disabled={busy !== null}
              onClick={() => {
                if (!reason.trim()) {
                  setError('A written justification is required for any decision.');
                  return;
                }
                void post(
                  open,
                  { justification: reason.trim(), legalReference: legalReference.trim() || undefined },
                  open === 'APPROVED'
                    ? 'Approved. Issue the certificate to complete it.'
                    : 'The application has been rejected and the applicant notified.'
                );
              }}
            >
              {busy === open ? (
                <Loader2 size={16} className={styles.spin} />
              ) : open === 'APPROVED' ? (
                <CheckCircle2 size={16} />
              ) : (
                <XCircle size={16} />
              )}
              {open === 'APPROVED' ? 'Approve' : 'Reject'}
            </button>
          </div>
        </div>
      )}

      {/* ── Schedule form ── */}
      {open === 'SCHEDULED' && (
        <div className={styles.form}>
          <div className={styles.field}>
            <label className="clay-label" htmlFor="visitDate">
              Visit date *
            </label>
            <input
              id="visitDate"
              type="date"
              className="clay-input"
              value={visitDate}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => {
                setVisitDate(e.target.value);
                if (e.target.value) void loadCandidates(e.target.value);
              }}
            />
            {app.preferredDate && (
              <span className={styles.hint}>
                The applicant asked for {new Date(app.preferredDate).toLocaleDateString('en-IN')}.
              </span>
            )}
          </div>

          <div className={styles.field} style={{ flexDirection: 'row', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="clay-label" htmlFor="slotStart">
                From
              </label>
              <input
                id="slotStart"
                type="time"
                className="clay-input"
                value={slotStart}
                onChange={(e) => setSlotStart(e.target.value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="clay-label" htmlFor="slotEnd">
                To
              </label>
              <input
                id="slotEnd"
                type="time"
                className="clay-input"
                value={slotEnd}
                onChange={(e) => setSlotEnd(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.field}>
            <span className="clay-label">Inspector</span>
            {busy === 'recommend' ? (
              <p className={styles.hint}>
                <Loader2 size={14} className={styles.spin} /> Ranking inspectors for that date…
              </p>
            ) : candidates === null ? null : candidates.length === 0 ? (
              <p className={styles.formWarn}>
                <AlertTriangle size={16} />
                <span>
                  {recommendNote ??
                    `No inspector is available in ${app.jurisdiction?.district ?? 'this district'} on that date.`}{' '}
                  Choose another date, or ask the State Admin to post an officer to this district.
                </span>
              </p>
            ) : (
              <ul className={styles.queryList}>
                {candidates.map((c) => (
                  <li
                    key={c.userId}
                    className={`${styles.query} ${chosen === c.userId ? styles.queryOpen : ''}`}
                  >
                    <label className={styles.checkItem} style={{ alignItems: 'center' }}>
                      <input
                        type="radio"
                        name="assignee"
                        checked={chosen === c.userId}
                        onChange={() => setChosen(c.userId)}
                      />
                      <span>
                        <strong>{c.name}</strong> — {c.role}
                        {c.designation ? `, ${c.designation}` : ''}
                        {c.district ? ` · ${c.district}` : ''}
                        <span className={styles.docChip} style={{ marginLeft: 8 }}>
                          fit {c.score}
                        </span>
                        {!c.categoryApproved && (
                          <span className={styles.docChip} style={{ marginLeft: 6 }}>
                            not accredited for this type
                          </span>
                        )}
                      </span>
                    </label>
                    {c.reasons.length > 0 && (
                      <ul className={styles.reasonList}>
                        {c.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="visitNote">
              Note for the applicant
            </label>
            <input
              id="visitNote"
              className="clay-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Please keep the standard weights accessible."
            />
          </div>

          <div className={styles.formActions}>
            <button type="button" className="clay-btn clay-btn-ghost" onClick={reset} disabled={busy !== null}>
              Cancel
            </button>
            <button
              type="button"
              className="clay-btn clay-btn-primary"
              onClick={bookInspection}
              disabled={busy !== null || candidates?.length === 0}
            >
              {busy === 'SCHEDULED' ? (
                <Loader2 size={16} className={styles.spin} />
              ) : (
                <CalendarCheck size={16} />
              )}
              Book and notify
            </button>
          </div>
        </div>
      )}

      {/* ── Everything that just needs a reason ── */}
      {open !== null &&
        !['QUERY_RAISED', 'APPROVED', 'REJECTED', 'SCHEDULED'].includes(open) &&
        ACTIONS[open] && (
          <div className={styles.form}>
            {ACTIONS[open]!.blurb && (
              <p
                className={
                  open === 'REVOKED' || open === 'SUSPENDED' ? styles.formWarn : styles.formNote
                }
              >
                {(open === 'REVOKED' || open === 'SUSPENDED') && <AlertTriangle size={16} />}
                <span>{ACTIONS[open]!.blurb}</span>
              </p>
            )}
            <div className={styles.field}>
              <label className="clay-label" htmlFor="actionReason">
                Reason *
              </label>
              <textarea
                id="actionReason"
                className="clay-input"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded on the application history and visible to the applicant."
              />
            </div>
            <div className={styles.formActions}>
              <button
                type="button"
                className="clay-btn clay-btn-ghost"
                onClick={reset}
                disabled={busy !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                className="clay-btn clay-btn-primary"
                disabled={busy !== null}
                onClick={() => {
                  if (!reason.trim()) {
                    setError('A written reason is required for this action.');
                    return;
                  }
                  void post(
                    open,
                    { reason: reason.trim() },
                    `Moved to ${applicationStatusLabel(open)}.`
                  );
                }}
              >
                {busy === open ? (
                  <Loader2 size={16} className={styles.spin} />
                ) : (
                  ACTIONS[open]!.icon
                )}
                {ACTIONS[open]!.label}
              </button>
            </div>
          </div>
        )}

      {open === null && offered.length > 0 && (
        <p className={styles.note}>
          Every action here is recorded against your account with a timestamp.{' '}
          <Link href="/dashboard/applications?queue=officer">Back to the queue</Link>
        </p>
      )}
    </section>
  );
}

/**
 * Sensible default visit date: the applicant's preference if it is not in the
 * past, otherwise tomorrow. Booking in the past is refused by the endpoint, so
 * defaulting to a stale preference would just produce an error the officer has to
 * clear before they can start.
 */
function defaultVisitDate(preferred?: string): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (preferred) {
    const p = new Date(preferred);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!Number.isNaN(p.getTime()) && p >= today) return p.toISOString().slice(0, 10);
  }
  return tomorrow.toISOString().slice(0, 10);
}
