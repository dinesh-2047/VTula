'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarX,
  CheckCircle2,
  FileUp,
  IndianRupee,
  Loader2,
  Paperclip,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  MAX_UPLOAD_BYTES,
  formatDate,
  type ApplicationStatus,
  type DocumentType,
} from '@/lib/constants';
import { payApplicationFee, prefetchCheckout } from '@/lib/razorpayCheckout';
import styles from './application.module.css';

/**
 * Everything an applicant can do to their own application.
 *
 * Two of these existed only as server endpoints with no way to reach them:
 *
 *  - **Answering a query.** `PATCH /api/applications/[id]` has accepted a
 *    `queryResponse` since it was written, and nothing ever sent one. An officer
 *    asking for a missing invoice therefore parked the application in
 *    QUERY_RAISED permanently — the applicant could see no query, had no field to
 *    answer it in, and the only escape was to cancel and file again.
 *  - **Paying the fee afterwards.** The new-application page tells an owner whose
 *    card was declined that they "can pay from the application page", and that
 *    page did not exist, so an unpaid application had no route to payment at all.
 *
 * The buttons offered come from the server's `availableTransitions`, not from a
 * status list rewritten here. `QUERY_RAISED → RESUBMITTED` is the applicant's
 * own transition; if the server has not offered it, the reply form is not shown,
 * because the reply would be rejected.
 */

interface OwnerApplication {
  _id: string;
  applicationNo: string;
  status: ApplicationStatus;
  feeStatus: string;
  inspectionLocation: string;
  preferredDate?: string;
}

interface Props {
  application: OwnerApplication;
  outstanding: number;
  openQuery: { message: string; requestedDocuments: string[]; dueBy?: string } | null;
  availableTransitions: ApplicationStatus[];
  owner: { name?: string; email?: string; phone?: string } | null;
  onChanged: () => Promise<void> | void;
}

type Panel = 'reply' | 'cancel' | null;

interface StagedFile {
  key: string;
  file: File;
  documentType: DocumentType;
}

export default function OwnerActions({
  application: app,
  outstanding,
  openQuery,
  availableTransitions,
  owner,
  onChanged,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);

  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [replyText, setReplyText] = useState('');
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [cancelReason, setCancelReason] = useState('');

  const canSubmit = availableTransitions.includes('SUBMITTED');
  const canReply = availableTransitions.includes('RESUBMITTED');
  const canCancel = availableTransitions.includes('CANCELLED');
  const canReleaseSlot = availableTransitions.includes('APPROVED_FOR_SCHEDULING');
  const canRefile = availableTransitions.includes('DRAFT');
  const feeDue = outstanding > 0 && app.feeStatus !== 'Waived';

  // Start the checkout download as soon as we know a fee is payable, so pressing
  // pay opens a window rather than waiting on a script. A fully-paid application
  // never fetches the gateway at all.
  useEffect(() => {
    if (feeDue) prefetchCheckout();
  }, [feeDue]);

  /** The reply is only useful if the query it answers is still open. */
  const showReply = canReply && Boolean(openQuery);

  function reset() {
    setPanel(null);
    setError(null);
    setReplyText('');
    setStaged([]);
    setCancelReason('');
  }

  /** One transition, with the server's message shown verbatim on refusal. */
  async function transition(
    to: ApplicationStatus,
    body: Record<string, unknown> = {},
    successNote?: string
  ): Promise<boolean> {
    setBusy(to);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/applications/${app._id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, ...body }),
      });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (!data.success) {
        setError(data.error || 'The department could not accept that action.');
        return false;
      }
      if (successNote) setNotice(successNote);
      reset();
      await onChanged();
      return true;
    } catch {
      setError('Could not reach the server. Nothing has changed.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const rejected: string[] = [];
    const accepted: StagedFile[] = [];

    Array.from(list).forEach((file, i) => {
      if (!(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
        rejected.push(`${file.name} — only JPG, PNG, WebP or PDF are accepted`);
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        rejected.push(`${file.name} — over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`);
        return;
      }
      accepted.push({
        // The index keeps two same-named files distinguishable in one selection.
        key: `${file.name}-${file.size}-${i}-${staged.length}`,
        file,
        // Default to the first thing the officer asked for; it is right most of
        // the time and always changeable.
        documentType: (openQuery?.requestedDocuments?.[0] as DocumentType) ?? 'OTHER',
      });
    });

    if (accepted.length) setStaged((prev) => [...prev, ...accepted]);
    // Silently dropping a file the applicant believes they attached is how a
    // query gets answered with nothing in it.
    setError(rejected.length ? `Not attached: ${rejected.join('; ')}` : null);
    if (fileInput.current) fileInput.current.value = '';
  }

  /** Uploads the staged files, then answers the query, then resubmits. */
  async function sendReply() {
    if (!replyText.trim()) {
      setError('Write what you are sending back to the officer.');
      return;
    }

    setBusy('reply');
    setError(null);
    setNotice(null);

    const documentIds: string[] = [];
    try {
      for (const item of staged) {
        const form = new FormData();
        form.append('file', item.file);
        form.append('documentType', item.documentType);
        form.append('applicationId', app._id);

        const res = await fetch('/api/documents', { method: 'POST', body: form });
        const data = (await res.json()) as {
          success: boolean;
          error?: string;
          document?: { id: string };
        };
        if (!data.success || !data.document) {
          setError(`${item.file.name} could not be uploaded: ${data.error ?? 'unknown error'}`);
          setBusy(null);
          return;
        }
        documentIds.push(data.document.id);
      }
    } catch {
      setError('An attachment failed to upload. Nothing has been sent.');
      setBusy(null);
      return;
    }

    // The response is recorded first — it is what marks the query resolved. Only
    // then is the application handed back to the officer.
    try {
      const res = await fetch(`/api/applications/${app._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryResponse: replyText.trim(), queryResponseDocumentIds: documentIds }),
      });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (!data.success) {
        setError(data.error || 'Your response could not be saved.');
        setBusy(null);
        return;
      }
    } catch {
      setError('Could not reach the server. Your response has not been sent.');
      setBusy(null);
      return;
    }

    setBusy(null);
    const moved = await transition(
      'RESUBMITTED',
      { reason: 'Applicant responded to the officer’s query' },
      'Your response has been sent. The application is back with the reviewing officer.'
    );

    if (!moved) {
      // The response is saved either way; say so, so nobody types it twice.
      setNotice(
        'Your response and attachments were saved, but the application could not be handed back automatically. Reload the page — if it still shows as awaiting a response, contact the office.'
      );
    }
  }

  async function payFee() {
    setBusy('fee');
    setError(null);
    setNotice(null);

    const result = await payApplicationFee({
      applicationId: app._id,
      applicationNo: app.applicationNo,
      prefill: {
        name: owner?.name,
        email: owner?.email,
        contact: owner?.phone,
      },
    });

    setBusy(null);

    if (result.status === 'paid') {
      setNotice(result.message ?? 'Payment received. Thank you.');
      await onChanged();
    } else if (result.status === 'failed') {
      setError(result.message);
    }
    // A dismissed modal is the applicant changing their mind; nothing to report.
  }

  const nothingToDo =
    !canSubmit && !showReply && !canCancel && !canReleaseSlot && !canRefile && !feeDue;

  return (
    <section className={`${styles.card} ${styles.decisionCard}`}>
      <h2>
        <Send size={15} />
        Your next step
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

      {nothingToDo && (
        <p className={styles.formNote}>
          Nothing is needed from you right now. The department will be in touch — you will get a
          notification the moment this application moves.
        </p>
      )}

      {/* ── Fee ── */}
      {feeDue && (
        <>
          <p className={styles.formNote}>
            ₹{outstanding.toLocaleString('en-IN')} of the verification fee is outstanding. An
            inspection is not scheduled until the fee is paid.
          </p>
          <div className={styles.actionStack} style={{ marginTop: 12 }}>
            <button
              type="button"
              className="clay-btn clay-btn-primary"
              onClick={payFee}
              disabled={busy !== null}
            >
              {busy === 'fee' ? (
                <Loader2 size={16} className={styles.spin} />
              ) : (
                <IndianRupee size={16} />
              )}
              {busy === 'fee' ? 'Opening payment…' : `Pay ₹${outstanding.toLocaleString('en-IN')}`}
            </button>
          </div>
        </>
      )}

      {/* ── Reply to the officer's query ── */}
      {showReply && panel !== 'cancel' && (
        <>
          {panel !== 'reply' ? (
            <div className={styles.actionStack} style={{ marginTop: feeDue ? 12 : 0 }}>
              <button
                type="button"
                className="clay-btn clay-btn-primary"
                onClick={() => setPanel('reply')}
                disabled={busy !== null}
              >
                <Send size={16} />
                Respond to the officer
              </button>
            </div>
          ) : (
            <div className={styles.form} style={{ marginTop: 4 }}>
              <p className={styles.formNote}>
                {openQuery!.message}
                {openQuery!.dueBy ? ` (asked for by ${formatDate(openQuery!.dueBy)})` : ''}
              </p>

              <div className={styles.field}>
                <label className="clay-label" htmlFor="reply">
                  Your response *
                </label>
                <textarea
                  id="reply"
                  className="clay-input"
                  rows={4}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Explain what you are providing, or answer the officer's question."
                />
                <span className={styles.hint}>
                  This goes on the application record and is read by the reviewing officer.
                </span>
              </div>

              {openQuery!.requestedDocuments.length > 0 && (
                <div className={styles.field}>
                  <span className="clay-label">The officer asked for</span>
                  <ul className={styles.priorityList}>
                    {openQuery!.requestedDocuments.map((t) => (
                      <li key={t}>{DOCUMENT_TYPE_LABELS[t as DocumentType] ?? t}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className={styles.field}>
                <span className="clay-label">Attachments</span>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={ALLOWED_UPLOAD_MIME_TYPES.join(',')}
                  onChange={(e) => addFiles(e.target.files)}
                  style={{ display: 'none' }}
                />
                <div className={styles.uploadRow}>
                  <button
                    type="button"
                    className="clay-btn clay-btn-outline clay-btn-sm"
                    onClick={() => fileInput.current?.click()}
                    disabled={busy !== null}
                  >
                    <Paperclip size={15} />
                    Choose files
                  </button>
                  <span className={styles.hint}>
                    JPG, PNG, WebP or PDF, up to{' '}
                    {Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB each.
                  </span>
                </div>

                {staged.length > 0 && (
                  <ul className={styles.fileList}>
                    {staged.map((item) => (
                      <li key={item.key}>
                        <FileUp size={14} />
                        <span>{item.file.name}</span>
                        <select
                          className="clay-input clay-select"
                          value={item.documentType}
                          onChange={(e) =>
                            setStaged((prev) =>
                              prev.map((s) =>
                                s.key === item.key
                                  ? { ...s, documentType: e.target.value as DocumentType }
                                  : s
                              )
                            )
                          }
                          style={{ maxWidth: 190, padding: '4px 8px', fontSize: '0.76rem' }}
                          aria-label={`Document type for ${item.file.name}`}
                        >
                          {DOCUMENT_TYPES.filter((t) => t !== 'INSPECTION_EVIDENCE').map((t) => (
                            <option key={t} value={t}>
                              {DOCUMENT_TYPE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={styles.dropFile}
                          onClick={() =>
                            setStaged((prev) => prev.filter((s) => s.key !== item.key))
                          }
                          aria-label={`Remove ${item.file.name}`}
                        >
                          <X size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
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
                  onClick={sendReply}
                  disabled={busy !== null}
                >
                  {busy === 'reply' || busy === 'RESUBMITTED' ? (
                    <Loader2 size={16} className={styles.spin} />
                  ) : (
                    <Send size={16} />
                  )}
                  {busy === 'reply'
                    ? staged.length
                      ? 'Uploading…'
                      : 'Sending…'
                    : busy === 'RESUBMITTED'
                      ? 'Sending…'
                      : 'Send response'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Submit a draft ── */}
      {canSubmit && panel === null && (
        <div className={styles.actionStack} style={{ marginTop: feeDue || showReply ? 12 : 0 }}>
          <button
            type="button"
            className="clay-btn clay-btn-primary"
            onClick={() =>
              transition('SUBMITTED', {}, 'Filed. The local Legal Metrology office can now see it.')
            }
            disabled={busy !== null}
          >
            {busy === 'SUBMITTED' ? (
              <Loader2 size={16} className={styles.spin} />
            ) : (
              <Send size={16} />
            )}
            Submit this application
          </button>
        </div>
      )}

      {/* ── Refile after a rejection ── */}
      {canRefile && panel === null && (
        <div className={styles.actionStack} style={{ marginTop: 12 }}>
          <button
            type="button"
            className="clay-btn clay-btn-outline"
            onClick={() =>
              transition(
                'DRAFT',
                {},
                'Reopened as a draft. Fix what the officer raised, then submit it again.'
              )
            }
            disabled={busy !== null}
          >
            {busy === 'DRAFT' ? (
              <Loader2 size={16} className={styles.spin} />
            ) : (
              <RotateCcw size={16} />
            )}
            Reopen and revise
          </button>
        </div>
      )}

      {/* ── Give up the inspection slot ── */}
      {canReleaseSlot && panel === null && (
        <div className={styles.actionStack} style={{ marginTop: 12 }}>
          <button
            type="button"
            className="clay-btn clay-btn-outline"
            onClick={() =>
              transition(
                'APPROVED_FOR_SCHEDULING',
                { reason: 'Applicant cannot make the scheduled visit' },
                'The slot has been released. The office will offer another date.'
              )
            }
            disabled={busy !== null}
          >
            {busy === 'APPROVED_FOR_SCHEDULING' ? (
              <Loader2 size={16} className={styles.spin} />
            ) : (
              <CalendarX size={16} />
            )}
            I cannot make this visit
          </button>
          <span className={styles.hint}>
            This gives up the appointment only. The application stays open and goes back into the
            scheduling queue.
          </span>
        </div>
      )}

      {/* ── Withdraw ── */}
      {canCancel && panel !== 'reply' && (
        <>
          {panel !== 'cancel' ? (
            <div className={styles.actionStack} style={{ marginTop: 12 }}>
              <button
                type="button"
                className="clay-btn clay-btn-ghost clay-btn-sm"
                onClick={() => setPanel('cancel')}
                disabled={busy !== null}
              >
                <Trash2 size={15} />
                Withdraw this application
              </button>
            </div>
          ) : (
            <div className={styles.form} style={{ marginTop: 4 }}>
              <p className={styles.formWarn}>
                <AlertTriangle size={16} />
                <span>
                  Withdrawing closes this application for good — it cannot be reopened, and any fee
                  already paid is not refunded automatically. If the instrument is still in
                  commercial use it must be verified, so you would need to file again.
                </span>
              </p>
              <div className={styles.field}>
                <label className="clay-label" htmlFor="cancelReason">
                  Why are you withdrawing? *
                </label>
                <input
                  id="cancelReason"
                  className="clay-input"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="e.g. the instrument has been sold"
                />
                <span className={styles.hint}>Recorded on the application permanently.</span>
              </div>
              <div className={styles.formActions}>
                <button
                  type="button"
                  className="clay-btn clay-btn-ghost"
                  onClick={reset}
                  disabled={busy !== null}
                >
                  Keep it open
                </button>
                <button
                  type="button"
                  className="clay-btn clay-btn-primary"
                  onClick={() => {
                    if (!cancelReason.trim()) {
                      setError('A reason is required to withdraw an application.');
                      return;
                    }
                    void transition(
                      'CANCELLED',
                      { reason: cancelReason.trim() },
                      'The application has been withdrawn.'
                    );
                  }}
                  disabled={busy !== null}
                >
                  {busy === 'CANCELLED' ? (
                    <Loader2 size={16} className={styles.spin} />
                  ) : (
                    <Trash2 size={16} />
                  )}
                  Withdraw
                </button>
              </div>
            </div>
          )}
        </>
      )}

    </section>
  );
}
