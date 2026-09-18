'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Film,
  Gavel,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Store,
  UserX,
} from 'lucide-react';
import {
  COMPLAINT_STATUS_LABELS,
  COMPLAINT_CLOSED_STATUSES,
  COMPLAINT_TYPE_LABELS,
  COMPLAINT_PRIORITIES,
  formatDate,
  formatDateTime,
  type ComplaintStatus,
  type ComplaintType,
} from '@/lib/constants';
import styles from '../complaints.module.css';

/**
 * One public complaint, for the officer handling it.
 *
 * Two rules govern this page:
 *
 *  - **The transition buttons come from the server.** `availableTransitions` is in
 *    the GET response and is re-read from every PATCH response. A client-computed
 *    list is how a button appears for an action the API then refuses.
 *  - **Both parties are shown in full, with working contact links.** The point of
 *    asking a complainant for a phone number was so that somebody could ring them;
 *    a detail page that displays it as plain text and nothing more wastes the only
 *    thing the citizen gave up privacy for.
 */

interface EvidenceItem {
  index: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  kind: 'image' | 'video' | 'document';
  uploadedAt: string;
  url: string;
}

interface HistoryEntry {
  from?: ComplaintStatus;
  to: ComplaintStatus;
  internalNote?: string;
  publicNote?: string;
  actorRole?: string;
  at: string;
}

interface ComplaintDetail {
  _id: string;
  complaintNo: string;
  status: ComplaintStatus;
  priority: string;
  complaintType: string;
  description: string;
  incidentDate?: string;
  createdAt: string;
  resolutionNote?: string;
  resolvedAt?: string;
  assignedAt?: string;
  gps?: { lat: number; lng: number; accuracyMetres?: number };
  evidence: EvidenceItem[];
  statusHistory: HistoryEntry[];
  complainant: {
    name: string;
    phone: string;
    email?: string;
    address?: string;
    isAnonymousToTrader?: boolean;
  };
  against: {
    businessName: string;
    ownerName?: string;
    phone?: string;
    address: string;
    state: string;
    district: string;
    pincode?: string;
    landmark?: string;
    instrumentDescription?: string;
    certNo?: string;
  };
}

interface Assignee {
  _id: string;
  name?: string;
  email?: string;
  role?: string;
  district?: string;
}

interface Transition {
  status: ComplaintStatus;
  label: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** The two closing statuses require a note the complainant will read. */
const NEEDS_PUBLIC_NOTE = new Set<ComplaintStatus>(['RESOLVED', 'REJECTED']);

export default function ComplaintDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [complaint, setComplaint] = useState<ComplaintDetail | null>(null);
  const [assignee, setAssignee] = useState<Assignee | null>(null);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [target, setTarget] = useState<ComplaintStatus | ''>('');
  const [publicNote, setPublicNote] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [priorityBusy, setPriorityBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/complaints/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        complaint?: ComplaintDetail;
        assignee?: Assignee | null;
        availableTransitions?: Transition[];
      };
      if (!data.success || !data.complaint) {
        setError(data.error || 'This complaint could not be loaded.');
        return;
      }
      setComplaint(data.complaint);
      setAssignee(data.assignee ?? null);
      setTransitions(data.availableTransitions ?? []);
      setError(null);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [id]);

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

  async function submitTransition() {
    if (!target || saving) return;

    if (NEEDS_PUBLIC_NOTE.has(target) && publicNote.trim().length < 10) {
      setError(
        'Write a note for the complainant before closing this. They will read it, and a blank one is not an answer.'
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/complaints/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: target,
          publicNote: publicNote.trim() || undefined,
          internalNote: internalNote.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'The status could not be changed.');
      }
      setTarget('');
      setPublicNote('');
      setInternalNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function changePriority(priority: string) {
    if (priorityBusy) return;
    setPriorityBusy(true);
    try {
      const res = await fetch(`/api/complaints/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error || 'Priority not changed.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Priority not changed.');
    } finally {
      setPriorityBusy(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.loading}>
        <Loader2 size={30} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        Loading complaint…
      </div>
    );
  }

  if (notFound || !complaint) {
    return (
      <div className={styles.page}>
        <Link href="/dashboard/complaints" className={styles.backLink}>
          <ArrowLeft size={15} />
          All complaints
        </Link>
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <AlertTriangle size={30} />
          </div>
          <div className={styles.emptyTitle}>Complaint not found</div>
          <p className={styles.emptyText}>
            It may have been filed against premises outside your jurisdiction, in which case the
            office responsible for that district is handling it.
          </p>
        </div>
      </div>
    );
  }

  const closed = COMPLAINT_CLOSED_STATUSES.includes(complaint.status);
  const c = complaint;

  return (
    <div className={styles.page}>
      <Link href="/dashboard/complaints" className={styles.backLink}>
        <ArrowLeft size={15} />
        All complaints
      </Link>

      <div className={styles.detailHead}>
        <div>
          <div className={styles.detailRef}>{c.complaintNo}</div>
          <h1 className={styles.detailTitle}>{c.against.businessName}</h1>
          <div className={styles.detailBadges}>
            <span
              className={`clay-badge ${
                closed ? 'clay-badge-success' : 'clay-badge-warning'
              }`}
            >
              {COMPLAINT_STATUS_LABELS[c.status]}
            </span>
            <span className="clay-badge clay-badge-primary">
              {COMPLAINT_TYPE_LABELS[c.complaintType as ComplaintType] ?? c.complaintType}
            </span>
            <span className="clay-badge clay-badge-info">{c.priority}</span>
            <span className="clay-badge">
              Filed {formatDateTime(c.createdAt)}
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div className={styles.error}>
          <AlertCircle size={17} />
          <span>{error}</span>
        </div>
      )}

      <div className={styles.detailLayout}>
        <div>
          {/* ---------------- The allegation ---------------- */}
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>
              <AlertTriangle size={17} />
              What was reported
            </h2>
            <p className={styles.descriptionBlock}>{c.description}</p>

            <div className={styles.factGrid} style={{ marginTop: 18 }}>
              {c.incidentDate && (
                <div className={styles.fact}>
                  <span className={styles.factLabel}>Incident date</span>
                  <span className={styles.factValue}>{formatDate(c.incidentDate)}</span>
                </div>
              )}
              {c.against.instrumentDescription && (
                <div className={styles.fact}>
                  <span className={styles.factLabel}>Instrument described as</span>
                  <span className={styles.factValue}>{c.against.instrumentDescription}</span>
                </div>
              )}
              {c.against.certNo && (
                <div className={styles.fact}>
                  <span className={styles.factLabel}>Certificate quoted</span>
                  <span className={styles.factValue}>
                    <Link href={`/verify/${c.against.certNo}`} target="_blank">
                      {c.against.certNo} <ExternalLink size={12} />
                    </Link>
                  </span>
                </div>
              )}
              {c.gps && (
                <div className={styles.fact}>
                  <span className={styles.factLabel}>Location captured</span>
                  <span className={styles.factValue}>
                    <a
                      href={`https://www.google.com/maps?q=${c.gps.lat},${c.gps.lng}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {c.gps.lat.toFixed(5)}, {c.gps.lng.toFixed(5)} <ExternalLink size={12} />
                    </a>
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* ---------------- The premises ---------------- */}
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>
              <Store size={17} />
              The business complained about
            </h2>
            <div className={styles.factGrid}>
              <div className={styles.fact}>
                <span className={styles.factLabel}>Business name</span>
                <span className={styles.factValue}>{c.against.businessName}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factLabel}>Owner / in charge</span>
                <span className={styles.factValue}>{c.against.ownerName || 'Not known'}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factLabel}>Phone</span>
                <span className={styles.factValue}>
                  {c.against.phone ? (
                    <a href={`tel:${c.against.phone}`}>{c.against.phone}</a>
                  ) : (
                    'Not known'
                  )}
                </span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factLabel}>Address</span>
                <span className={styles.factValue}>{c.against.address}</span>
              </div>
              {c.against.landmark && (
                <div className={styles.fact}>
                  <span className={styles.factLabel}>Landmark</span>
                  <span className={styles.factValue}>{c.against.landmark}</span>
                </div>
              )}
              <div className={styles.fact}>
                <span className={styles.factLabel}>Jurisdiction</span>
                <span className={styles.factValue}>
                  {c.against.district}, {c.against.state}
                  {c.against.pincode ? ` — ${c.against.pincode}` : ''}
                </span>
              </div>
            </div>
          </section>

          {/* ---------------- The complainant ---------------- */}
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>
              <Phone size={17} />
              Who filed it
            </h2>
            <div className={styles.factGrid}>
              <div className={styles.fact}>
                <span className={styles.factLabel}>Name</span>
                <span className={styles.factValue}>{c.complainant.name}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factLabel}>Mobile</span>
                <span className={styles.factValue}>
                  <a href={`tel:${c.complainant.phone}`}>{c.complainant.phone}</a>
                </span>
              </div>
              {c.complainant.email && (
                <div className={styles.fact}>
                  <span className={styles.factLabel}>Email</span>
                  <span className={styles.factValue}>
                    <a href={`mailto:${c.complainant.email}`}>
                      <Mail size={12} /> {c.complainant.email}
                    </a>
                  </span>
                </div>
              )}
              {c.complainant.address && (
                <div className={styles.fact}>
                  <span className={styles.factLabel}>Address</span>
                  <span className={styles.factValue}>{c.complainant.address}</span>
                </div>
              )}
            </div>

            {c.complainant.isAnonymousToTrader && (
              <div className={styles.anonNote}>
                <UserX size={15} />
                <span>
                  This person asked not to be named to the business. Their details are for the
                  department&apos;s use — do not repeat them to the trader or record them in any
                  notice served on the premises.
                </span>
              </div>
            )}
          </section>

          {/* ---------------- Evidence ---------------- */}
          {c.evidence.length > 0 && (
            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>
                <Camera size={17} />
                Evidence ({c.evidence.length})
              </h2>
              <div className={styles.evidenceGrid}>
                {c.evidence.map((e) => (
                  <div key={e.index} className={styles.evidenceItem}>
                    {e.kind === 'image' && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={e.url} alt={e.fileName} className={styles.evidenceMedia} />
                    )}
                    {e.kind === 'video' && (
                      <video src={e.url} className={styles.evidenceMedia} controls preload="metadata" />
                    )}
                    {e.kind === 'document' && (
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={styles.evidenceDoc}
                      >
                        <FileText size={34} />
                      </a>
                    )}
                    <div className={styles.evidenceMeta}>
                      <span className={styles.evidenceName}>
                        {e.kind === 'video' ? <Film size={11} /> : null} {e.fileName}
                      </span>
                      <span className={styles.evidenceSize}>{formatBytes(e.sizeBytes)}</span>
                    </div>
                    {/* The hash is what makes this admissible later: it proves the
                        file has not changed since intake. */}
                    <div className={styles.evidenceHash} title={e.sha256}>
                      SHA-256 {e.sha256.slice(0, 16)}…
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ---------------- History ---------------- */}
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>
              <Clock size={17} />
              Case history
            </h2>
            <div className={styles.history}>
              {c.statusHistory.map((h, i) => {
                const latest = i === c.statusHistory.length - 1;
                return (
                  <div key={`${h.to}-${h.at}-${i}`} className={styles.historyItem}>
                    <span
                      className={`${styles.historyDot} ${latest ? styles.historyDotLatest : ''}`}
                    >
                      <Check size={13} />
                    </span>
                    <div className={styles.historyBody}>
                      <div className={styles.historyLabel}>
                        {COMPLAINT_STATUS_LABELS[h.to] ?? h.to}
                        {h.from ? ` — from ${COMPLAINT_STATUS_LABELS[h.from] ?? h.from}` : ''}
                      </div>
                      {h.publicNote && <p className={styles.historyNote}>{h.publicNote}</p>}
                      {h.internalNote && (
                        <p className={styles.historyInternal}>
                          Internal: {h.internalNote}
                        </p>
                      )}
                      <div className={styles.historyMeta}>
                        {formatDateTime(h.at)}
                        {h.actorRole ? ` · ${h.actorRole}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        {/* ---------------- Action panel ---------------- */}
        <aside className={styles.sticky}>
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>
              <Gavel size={17} />
              Act on this complaint
            </h2>

            {transitions.length === 0 ? (
              <div className={styles.closedNote}>
                <strong>{COMPLAINT_STATUS_LABELS[c.status]}</strong> — this complaint is closed and
                cannot be moved further.
                {c.resolutionNote && (
                  <>
                    <br />
                    <br />
                    The complainant was told: &ldquo;{c.resolutionNote}&rdquo;
                  </>
                )}
              </div>
            ) : (
              <>
                <div className={styles.actionField}>
                  <label className="clay-label" htmlFor="target">
                    Move to
                  </label>
                  <select
                    id="target"
                    className="clay-select"
                    value={target}
                    onChange={(e) => setTarget(e.target.value as ComplaintStatus | '')}
                  >
                    <option value="">Choose an action…</option>
                    {transitions.map((t) => (
                      <option key={t.status} value={t.status}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  {target === 'ASSIGNED' && (
                    <span className={styles.actionHint}>
                      This assigns the complaint to you and notifies nobody else.
                    </span>
                  )}
                </div>

                <div className={styles.actionField}>
                  <label className="clay-label" htmlFor="publicNote">
                    Note for the complainant
                    {target && NEEDS_PUBLIC_NOTE.has(target) && (
                      <span className={styles.actionRequired}> — required</span>
                    )}
                  </label>
                  <textarea
                    id="publicNote"
                    className={`clay-input ${styles.actionTextarea}`}
                    value={publicNote}
                    onChange={(e) => setPublicNote(e.target.value)}
                    placeholder="What you did and what the outcome was. This is what they see when they track the complaint."
                  />
                  <span className={styles.actionHint}>
                    Visible to the person who filed it. Leave blank and the standard wording for that
                    status is used instead.
                  </span>
                </div>

                <div className={styles.actionField}>
                  <label className="clay-label" htmlFor="internalNote">
                    Internal note
                  </label>
                  <textarea
                    id="internalNote"
                    className={`clay-input ${styles.actionTextarea}`}
                    value={internalNote}
                    onChange={(e) => setInternalNote(e.target.value)}
                    placeholder="For the file. Never shown to the complainant or the trader."
                  />
                </div>

                <button
                  type="button"
                  className={`clay-btn clay-btn-primary ${styles.fullWidthBtn}`}
                  disabled={!target || saving}
                  onClick={() => void submitTransition()}
                >
                  {saving ? (
                    <>
                      <Loader2 size={16} className={styles.spin} />
                      Saving…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={16} />
                      Record this
                    </>
                  )}
                </button>
              </>
            )}
          </section>

          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>
              <AlertTriangle size={17} />
              Priority
            </h2>
            <select
              className="clay-select"
              value={c.priority}
              disabled={priorityBusy || closed}
              onChange={(e) => void changePriority(e.target.value)}
            >
              {COMPLAINT_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0) + p.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
            <span className={styles.actionHint} style={{ marginTop: 8, display: 'block' }}>
              Changes the queue order. Recorded in the audit log, not in the case history the
              complainant sees.
            </span>
          </section>

          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>
              <MapPin size={17} />
              Handling
            </h2>
            <div className={styles.factGrid}>
              <div className={styles.fact}>
                <span className={styles.factLabel}>Assigned to</span>
                <span className={styles.factValue}>
                  {assignee ? `${assignee.name ?? 'Officer'} (${assignee.role})` : 'Nobody yet'}
                </span>
              </div>
              {c.assignedAt && (
                <div className={styles.fact}>
                  <span className={styles.factLabel}>Assigned on</span>
                  <span className={styles.factValue}>{formatDateTime(c.assignedAt)}</span>
                </div>
              )}
              {c.resolvedAt && (
                <div className={styles.fact}>
                  <span className={styles.factLabel}>Closed on</span>
                  <span className={styles.factValue}>{formatDateTime(c.resolvedAt)}</span>
                </div>
              )}
            </div>

            <button
              type="button"
              className={`clay-btn clay-btn-outline clay-btn-sm ${styles.fullWidthBtn}`}
              style={{ marginTop: 14 }}
              onClick={() => router.push('/dashboard/enforcement')}
            >
              <Gavel size={14} />
              Open an enforcement case
            </button>
            <span className={styles.actionHint} style={{ marginTop: 8, display: 'block' }}>
              Use this when the complaint warrants formal action against a registered instrument.
            </span>
          </section>
        </aside>
      </div>
    </div>
  );
}
