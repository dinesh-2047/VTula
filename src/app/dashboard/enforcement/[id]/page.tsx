'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Gavel,
  IndianRupee,
  Loader2,
  MapPin,
  Megaphone,
  Paperclip,
  RotateCcw,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Upload,
  UserCheck,
  UserX,
  X,
} from 'lucide-react';
import {
  ADMIN_ROLES,
  ENFORCEMENT_CASE_STATUS_LABELS,
  ENFORCEMENT_CASE_TYPE_LABELS,
  ENFORCEMENT_SEVERITIES,
  MAX_UPLOAD_BYTES,
  enforcementStatusBadgeClass,
  riskLevelBadgeClass,
  formatDate,
  formatDateTime,
  formatInr,
  type EnforcementCaseStatus,
  type EnforcementCaseType,
  type EnforcementSeverity,
  type Role,
} from '@/lib/constants';
import OwnerCaseView, { type OwnerCasePayload } from './OwnerCaseView';
import styles from './case.module.css';

/**
 * One enforcement case.
 *
 * The rule this page is built around: **the log is the case.** Every panel here
 * writes an entry rather than mutating a field the officer can later deny setting,
 * and the log is rendered oldest-first, because what a case has to prove is not its
 * current state but the sequence that produced it — notice before hearing, hearing
 * before penalty. Reading it newest-first would be more convenient and would hide
 * exactly the thing a challenge attacks.
 *
 * Two consequences for the interface:
 *
 *  - **Transitions come from the server.** `allowedNextStatuses` is rendered as it
 *    arrives. Nothing here holds a copy of the state machine, so it cannot drift
 *    from `NEXT_STATUS` and offer a step the API will refuse.
 *  - **The cost of each step is written on it.** "Issue notice" tells the officer
 *    the text goes to the business; closing tells them the outcome is permanent and
 *    only an administrator can undo it. A confirm dialog after the fact is not the
 *    same thing.
 */

interface Actor {
  _id?: string;
  name?: string;
  designation?: string;
  officerCode?: string;
}

interface ActionEntry {
  action: string;
  note?: string;
  at: string;
  actorRole?: string;
  actor?: Actor;
}

interface EvidenceFile {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  documentType: string;
  typeLabel: string;
  sha256: string;
  href: string;
  capturedAt?: string;
  gps?: { lat: number; lng: number; accuracyMetres?: number };
  uploadedAt: string;
}

interface PriorCase {
  _id: string;
  caseNo: string;
  caseType: string;
  status: string;
  severity: string;
  createdAt: string;
  closedAt?: string;
  outcome?: string;
  penalty?: { amount?: number };
}

interface CaseData {
  id: string;
  caseNo: string;
  caseType: string;
  status: string;
  severity: string;
  title: string;
  description: string;
  origin: string;
  riskFlagId?: string;
  jurisdiction?: { state?: string; district?: string };
  instrumentId?: string;
  certificateId?: string;
  ownerId?: string;
  assignedTo?: string;
  assignedAt?: string;
  actions: ActionEntry[];
  penalty?: {
    amount?: number;
    currency?: string;
    imposedAt?: string;
    reference?: string;
    paidAt?: string;
  };
  complainant?: { isAnonymous: boolean; name?: string; phone?: string; email?: string };
  outcome?: string;
  closedAt?: string;
  ageDays: number;
  createdAt: string;
}

interface Payload {
  case: CaseData;
  subject: {
    instrument?: {
      _id: string;
      serialNo?: string;
      type?: string;
      brand?: string;
      model?: string;
      capacity?: string;
      status?: string;
      installationState?: string;
      installationDistrict?: string;
      address?: string;
      lastVerifiedDate?: string;
      nextVerificationDue?: string;
      verificationCount?: number;
      failedInspectionCount?: number;
    } | null;
    certificate?: {
      _id: string;
      certNo?: string;
      status?: string;
      issuedDate?: string;
      expiryDate?: string;
      version?: number;
    } | null;
    owner?: {
      _id: string;
      name?: string;
      email?: string;
      phone?: string;
      organizationName?: string;
      state?: string;
      district?: string;
    } | null;
  };
  assignee?: Actor | null;
  evidence: EvidenceFile[];
  priorCases: PriorCase[];
  allowedNextStatuses: string[];
  canClose: boolean;
}

interface OfficerOption {
  id: string;
  name: string;
  officerCode?: string;
  designation?: string;
  district?: string;
  canSignIn: boolean;
}

/** The statutory sequence, for the rail at the top. */
const STAGES: EnforcementCaseStatus[] = [
  'OPEN',
  'INVESTIGATING',
  'NOTICE_ISSUED',
  'HEARING',
  'PENALTY_IMPOSED',
  'CLOSED',
];

/** Every action code any route writes, in words rather than in shouting. */
const ACTION_LABELS: Record<string, string> = {
  FILED: 'Complaint filed',
  OPENED: 'Case opened',
  ASSIGNED: 'Assigned',
  SEVERITY_CHANGED: 'Severity changed',
  EVIDENCE_ADDED: 'Evidence attached',
  OWNER_RESPONSE: 'Response from the business',
  PENALTY_RECORDED: 'Penalty recorded',
  PENALTY_PAID: 'Penalty paid',
  NOTE: 'Note',
  REOPENED: 'Reopened',
  STATUS_OPEN: 'Reset to open',
  STATUS_INVESTIGATING: 'Investigation started',
  STATUS_NOTICE_ISSUED: 'Notice issued',
  STATUS_HEARING: 'Hearing scheduled',
  STATUS_PENALTY_IMPOSED: 'Penalty imposed',
  STATUS_CLOSED: 'Case closed',
  STATUS_DISMISSED: 'Case dismissed',
};

/** The word on the button, and what pressing it commits the officer to. */
const TRANSITION_COPY: Record<string, { label: string; consequence: string }> = {
  INVESTIGATING: {
    label: 'Start investigating',
    consequence: 'Records that the case is being worked. The business is not notified.',
  },
  NOTICE_ISSUED: {
    label: 'Issue notice',
    consequence:
      'The text you write below is sent to the business as the notice. Write what you would put on paper.',
  },
  HEARING: {
    label: 'Set down for hearing',
    consequence: 'The business is told the case has been set down. A penalty becomes available.',
  },
  PENALTY_IMPOSED: {
    label: 'Move to penalty imposed',
    consequence: 'Use this once the penalty has been decided. Record the amount below it.',
  },
  CLOSED: {
    label: 'Close the case',
    consequence:
      'Final. The outcome you record goes on the register and only an administrator can reopen the case.',
  },
  DISMISSED: {
    label: 'Dismiss the case',
    consequence:
      'Final, and means the allegation was not made out. Say why — a dismissal with no reason cannot be reviewed.',
  },
};

/** Where the case came from. */
const ORIGIN_LABELS: Record<string, string> = {
  PUBLIC_COMPLAINT: 'Public complaint',
  RISK_FLAG: 'Confirmed risk finding',
  INSPECTION: 'Field inspection',
  OFFICER: 'Opened by an officer',
  SYSTEM: 'Raised automatically',
};

function statusLabel(s: string): string {
  return ENFORCEMENT_CASE_STATUS_LABELS[s as EnforcementCaseStatus] ?? s;
}

function severityLabel(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function actionLabel(code: string): string {
  return ACTION_LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Statuses at which the Act's penalty provisions can actually be recorded. */
const PENALTY_STATUSES = ['NOTICE_ISSUED', 'HEARING', 'PENALTY_IMPOSED'];

/** Mirrors the server's floors so the form does not have to fail to teach them. */
const NOTE_MIN = 10;
const OUTCOME_MIN = 10;
const REOPEN_REASON_MIN = 15;

export default function EnforcementCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session } = useSession();

  const [data, setData] = useState<Payload | null>(null);
  /*
   * The same URL serves two entirely different documents. An officer gets the
   * working console below; the business the case is against gets a redacted read
   * of it, because both intake paths notify them with a link to this page and a
   * link that 403s is not notice. The server decides which — `viewer: 'OWNER'` —
   * so this page never has to guess from the session what somebody may see.
   */
  const [ownerView, setOwnerView] = useState<OwnerCasePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Console drafts.
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState('');
  const [severityDraft, setSeverityDraft] = useState('');
  const [penaltyAmount, setPenaltyAmount] = useState('');
  const [penaltyReference, setPenaltyReference] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const [showReopen, setShowReopen] = useState(false);

  // Reassignment is only offered to administrators, because /api/users is
  // administrator-only — an LMO has no directory to pick from. They get "take this
  // case" instead, which is the action they actually want.
  const [officers, setOfficers] = useState<OfficerOption[]>([]);
  const [assignTo, setAssignTo] = useState('');

  const [uploading, setUploading] = useState(false);

  const role = (session?.user?.role ?? 'Owner') as Role;
  const isAdmin = ADMIN_ROLES.includes(role);
  const myId = session?.user?.id;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/enforcement/${id}`);
      const body = (await res.json()) as (Payload | OwnerCasePayload) & {
        success: boolean;
        error?: string;
        viewer?: string;
      };
      if (!body.success) {
        setError(body.error || 'This case could not be loaded.');
        setData(null);
        setOwnerView(null);
        return;
      }
      setError(null);
      if (body.viewer === 'OWNER') {
        setOwnerView(body as OwnerCasePayload);
        setData(null);
        return;
      }
      const officer = body as Payload;
      setOwnerView(null);
      setData(officer);
      setSeverityDraft(officer.case.severity);
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

  const loadOfficers = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch('/api/users?role=LMO&approvalStatus=APPROVED&active=true&limit=100');
      if (!res.ok) return;
      const body = (await res.json()) as { success: boolean; users?: OfficerOption[] };
      if (body.success) setOfficers((body.users ?? []).filter((u) => u.canSignIn));
    } catch {
      // A missing directory is not worth an error banner; "assign to me" still works.
    }
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await loadOfficers();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadOfficers]);

  /** Every write on this page goes through one PATCH, so the log stays honest. */
  const patch = useCallback(
    async (body: Record<string, unknown>, success: string) => {
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/enforcement/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = (await res.json()) as { success: boolean; error?: string };
        if (!result.success) {
          setError(result.error || 'That could not be recorded.');
          return false;
        }
        setNotice(success);
        setPendingStatus(null);
        setNote('');
        setOutcome('');
        await load();
        return true;
      } catch {
        setError('Could not reach the server. Nothing was recorded.');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [id, load]
  );

  const c = data?.case;

  const stageIndex = useMemo(() => {
    if (!c) return -1;
    if (c.status === 'DISMISSED') return STAGES.length - 1;
    return STAGES.indexOf(c.status as EnforcementCaseStatus);
  }, [c]);

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading case…</p>
      </div>
    );
  }

  if (error && !data && !ownerView) {
    return (
      <div className={styles.errorWrap}>
        <AlertTriangle size={44} />
        <h2>Case unavailable</h2>
        <p>{error}</p>
        <Link href="/dashboard/enforcement" className="clay-btn clay-btn-outline">
          <ArrowLeft size={16} />
          Back to the register
        </Link>
      </div>
    );
  }

  // The business's own read of the case, served by the same endpoint.
  if (ownerView) return <OwnerCaseView data={ownerView} onReload={load} />;

  if (!data || !c) return null;

  const { subject, assignee, evidence, priorCases, allowedNextStatuses } = data;
  const isTerminal = c.status === 'CLOSED' || c.status === 'DISMISSED';
  const mine = Boolean(myId && c.assignedTo === myId);
  const penaltyRecorded = Boolean(c.penalty?.amount);
  const penaltyUnpaid = penaltyRecorded && !c.penalty?.paidAt;
  const canRecordPenalty = !isTerminal && !penaltyRecorded && PENALTY_STATUSES.includes(c.status);

  const needsOutcome = pendingStatus === 'CLOSED' || pendingStatus === 'DISMISSED';
  const needsNoteText = pendingStatus === 'NOTICE_ISSUED';
  // Surfaced before the button is pressed rather than as a 409 afterwards.
  const closureBlocked = pendingStatus === 'CLOSED' && penaltyUnpaid;

  const transitionReady =
    pendingStatus !== null &&
    (!needsOutcome || outcome.trim().length >= OUTCOME_MIN) &&
    (!needsNoteText || note.trim().length >= NOTE_MIN);

  return (
    <div className={styles.page}>
      <Link href="/dashboard/enforcement" className={styles.backLink}>
        <ArrowLeft size={15} />
        Enforcement register
      </Link>

      <div className={styles.pageHeader}>
        <div className={styles.headMain}>
          <div className={styles.headBadges}>
            <span className={styles.caseNo}>{c.caseNo}</span>
            <span className={`clay-badge ${enforcementStatusBadgeClass(c.status)}`}>
              {statusLabel(c.status)}
            </span>
            <span className={`clay-badge ${riskLevelBadgeClass(c.severity)}`}>
              {severityLabel(c.severity)} severity
            </span>
            {c.origin === 'PUBLIC_COMPLAINT' && (
              <span className={styles.originTag}>
                <Megaphone size={12} />
                Public
              </span>
            )}
            {c.origin === 'RISK_FLAG' && (
              <span className={styles.originTag}>
                <ShieldAlert size={12} />
                Risk finding
              </span>
            )}
          </div>
          <h1>{c.title}</h1>
          <p className={styles.headSub}>
            {ENFORCEMENT_CASE_TYPE_LABELS[c.caseType as EnforcementCaseType] ?? c.caseType} ·{' '}
            {ORIGIN_LABELS[c.origin] ?? c.origin} · opened {formatDate(c.createdAt)}
            {isTerminal && c.closedAt ? ` · concluded ${formatDate(c.closedAt)}` : ''}
            {!isTerminal ? ` · ${c.ageDays} day${c.ageDays === 1 ? '' : 's'} old` : ''}
          </p>
        </div>
      </div>

      {/* The statutory rail. A dismissed case stops rather than completing, so it is
          drawn as a break instead of a filled final step. */}
      <div className={styles.rail}>
        {STAGES.map((s, i) => {
          const reached = stageIndex >= i;
          const isNow = c.status === s;
          return (
            <div
              key={s}
              className={`${styles.railStep} ${reached ? styles.railDone : ''} ${
                isNow ? styles.railNow : ''
              }`}
            >
              <span className={styles.railDot}>{reached ? <CheckCircle2 size={13} /> : i + 1}</span>
              <span className={styles.railLabel}>
                {s === 'CLOSED' && c.status === 'DISMISSED' ? 'Dismissed' : statusLabel(s)}
              </span>
            </div>
          );
        })}
      </div>

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" className={styles.boxDismiss} onClick={() => setError(null)}>
            <X size={15} />
          </button>
        </div>
      )}

      {notice && (
        <div className={styles.noticeBox}>
          <CheckCircle2 size={18} />
          <span>{notice}</span>
          <button type="button" className={styles.boxDismiss} onClick={() => setNotice(null)}>
            <X size={15} />
          </button>
        </div>
      )}

      <div className={styles.layout}>
        <div className={styles.main}>
          {/* ── The allegation ── */}
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>
              <ScrollText size={16} />
              The allegation
            </h2>
            <p className={styles.description}>{c.description}</p>

            {c.complainant && (
              <div className={styles.complainant}>
                {c.complainant.isAnonymous ? (
                  <p>
                    <strong>Filed anonymously.</strong> The complainant asked not to be identified,
                    so their details are not on this record — not withheld from you specifically,
                    but never stored in a readable form. The case has to stand on the evidence.
                  </p>
                ) : (
                  <p>
                    <strong>Complainant:</strong> {c.complainant.name || 'name not given'}
                    {c.complainant.phone ? ` · ${c.complainant.phone}` : ''}
                    {c.complainant.email ? ` · ${c.complainant.email}` : ''}
                  </p>
                )}
              </div>
            )}

            {c.outcome && (
              <div className={styles.outcomeBox}>
                <strong>Recorded outcome</strong>
                <p>{c.outcome}</p>
              </div>
            )}
          </section>

          {/* ── Evidence ── */}
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>
              <Paperclip size={16} />
              Evidence
              {evidence.length > 0 && <span className={styles.countPill}>{evidence.length}</span>}
            </h2>

            {evidence.length === 0 ? (
              <p className={styles.empty}>
                Nothing attached yet. A case that ends in a penalty rests on what is filed here.
              </p>
            ) : (
              <ul className={styles.evidenceList}>
                {evidence.map((f) => (
                  <li key={f.id} className={styles.evidenceRow}>
                    <FileText size={16} />
                    <div className={styles.evidenceMeta}>
                      <a href={f.href} target="_blank" rel="noopener noreferrer">
                        {f.fileName}
                        <ExternalLink size={12} />
                      </a>
                      <span>
                        {f.typeLabel} · {fileSize(f.sizeBytes)} ·{' '}
                        {f.capturedAt
                          ? `captured ${formatDateTime(f.capturedAt)}`
                          : `attached ${formatDate(f.uploadedAt)}`}
                        {f.gps ? ` · ${f.gps.lat.toFixed(5)}, ${f.gps.lng.toFixed(5)}` : ''}
                      </span>
                      {/* The hash is what makes a photograph produced in a hearing
                          provably the one that was filed. */}
                      <code className={styles.hash}>sha256 {f.sha256.slice(0, 16)}…</code>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {!isTerminal && (
              <div className={styles.uploadRow}>
                <label className={`clay-btn clay-btn-outline clay-btn-sm ${styles.uploadBtn}`}>
                  {uploading ? <Loader2 size={15} className={styles.spin} /> : <Upload size={15} />}
                  {uploading ? 'Uploading…' : 'Attach a file'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    disabled={uploading || saving}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      if (file.size > MAX_UPLOAD_BYTES) {
                        setError(
                          `That file is ${fileSize(file.size)}. The limit is ${fileSize(MAX_UPLOAD_BYTES)}.`
                        );
                        return;
                      }
                      setUploading(true);
                      setError(null);
                      setNotice(null);
                      try {
                        /*
                         * Two steps on purpose. /api/documents stores and hashes the
                         * bytes; the case's own PATCH is what puts the id in
                         * `evidenceIds` and writes EVIDENCE_ADDED to the log. Storing
                         * a file is not the same act as filing it as evidence, and
                         * the log should say when the second one happened.
                         */
                        const form = new FormData();
                        form.append('file', file);
                        form.append('documentType', 'INSPECTION_EVIDENCE');
                        form.append('enforcementCaseId', c.id);
                        if (file.lastModified) {
                          form.append('capturedAt', new Date(file.lastModified).toISOString());
                        }
                        const up = await fetch('/api/documents', { method: 'POST', body: form });
                        const upBody = (await up.json()) as {
                          success: boolean;
                          error?: string;
                          document?: { id: string };
                        };
                        if (!upBody.success || !upBody.document) {
                          setError(upBody.error || 'The file could not be stored.');
                          return;
                        }
                        await patch(
                          { evidenceIds: [upBody.document.id] },
                          `${file.name} is on the case record.`
                        );
                      } catch {
                        setError('The upload failed. Nothing was attached.');
                      } finally {
                        setUploading(false);
                      }
                    }}
                  />
                </label>
                <span className={styles.hint}>
                  JPEG, PNG, WebP or PDF, up to {fileSize(MAX_UPLOAD_BYTES)}. Evidence is appended
                  and never removed.
                </span>
              </div>
            )}
          </section>

          {/* ── Console ── */}
          {isTerminal ? (
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>
                <ShieldCheck size={16} />
                This case is {c.status === 'DISMISSED' ? 'dismissed' : 'closed'}
              </h2>
              <p className={styles.empty}>
                Nothing further can be recorded against it. If new information has come to light,
                open a fresh case — that keeps the two findings distinct instead of overwriting the
                first.
              </p>
              {isAdmin && (
                <div className={styles.reopenArea}>
                  {!showReopen ? (
                    <button
                      type="button"
                      className="clay-btn clay-btn-outline clay-btn-sm"
                      onClick={() => setShowReopen(true)}
                    >
                      <RotateCcw size={15} />
                      Reopen the case
                    </button>
                  ) : (
                    <>
                      <label className="clay-label" htmlFor="reopenReason">
                        Why is this being reopened?
                      </label>
                      <textarea
                        id="reopenReason"
                        className="clay-input"
                        rows={3}
                        value={reopenReason}
                        onChange={(e) => setReopenReason(e.target.value)}
                        placeholder="Reopening contradicts a recorded outcome, so this reason becomes part of the case file."
                      />
                      <p className={styles.hint}>
                        At least {REOPEN_REASON_MIN} characters. The previous outcome is kept in the
                        action log rather than erased, and the case returns to “under
                        investigation”.
                      </p>
                      <div className={styles.consoleActions}>
                        <button
                          type="button"
                          className="clay-btn clay-btn-ghost clay-btn-sm"
                          onClick={() => {
                            setShowReopen(false);
                            setReopenReason('');
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="clay-btn clay-btn-primary clay-btn-sm"
                          disabled={saving || reopenReason.trim().length < REOPEN_REASON_MIN}
                          onClick={async () => {
                            setSaving(true);
                            setError(null);
                            try {
                              const res = await fetch(`/api/enforcement/${id}`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ reason: reopenReason.trim() }),
                              });
                              const body = (await res.json()) as {
                                success: boolean;
                                error?: string;
                                message?: string;
                              };
                              if (!body.success) {
                                setError(body.error || 'The case could not be reopened.');
                                return;
                              }
                              setNotice(body.message ?? 'The case has been reopened.');
                              setShowReopen(false);
                              setReopenReason('');
                              await load();
                            } catch {
                              setError('Could not reach the server. Nothing was changed.');
                            } finally {
                              setSaving(false);
                            }
                          }}
                        >
                          {saving ? <Loader2 size={15} className={styles.spin} /> : null}
                          Reopen
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>
          ) : (
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>
                <Gavel size={16} />
                Record an action
              </h2>

              {allowedNextStatuses.length > 0 && (
                <>
                  <p className={styles.consoleLead}>
                    Where the case goes next. These are the only steps permitted from{' '}
                    {statusLabel(c.status).toLowerCase()} — notice precedes a hearing and a hearing
                    precedes a penalty, so the sequence cannot be skipped.
                  </p>
                  <div className={styles.transitionRow}>
                    {allowedNextStatuses.map((s) => {
                      const copy = TRANSITION_COPY[s];
                      return (
                        <button
                          key={s}
                          type="button"
                          className={`${styles.transitionBtn} ${
                            pendingStatus === s ? styles.transitionActive : ''
                          } ${s === 'CLOSED' || s === 'DISMISSED' ? styles.transitionFinal : ''}`}
                          onClick={() => {
                            setPendingStatus(pendingStatus === s ? null : s);
                            setOutcome('');
                          }}
                        >
                          <strong>{copy?.label ?? statusLabel(s)}</strong>
                          <em>{copy?.consequence ?? ''}</em>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {closureBlocked && (
                <div className={styles.warnBox}>
                  <AlertTriangle size={16} />
                  <span>
                    The {formatInr(c.penalty?.amount ?? 0)} penalty on this case is unpaid. Record
                    the payment first, or write an outcome that states the penalty is outstanding —
                    otherwise the register would say the matter is settled when the money has not
                    been collected.
                  </span>
                </div>
              )}

              <div className={styles.field}>
                <label className="clay-label" htmlFor="note">
                  {needsNoteText ? 'What does the notice say?' : 'Note for the record'}
                  {!needsNoteText && <span className={styles.optional}> optional</span>}
                </label>
                <textarea
                  id="note"
                  className="clay-input"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={
                    needsNoteText
                      ? 'This text is sent to the business as the notice. Write what you would put on paper.'
                      : 'What was done, seen or decided. Appended to the log with your name against it.'
                  }
                />
                {needsNoteText && (
                  <p className={note.trim().length < NOTE_MIN ? styles.hintWarn : styles.hint}>
                    At least {NOTE_MIN} characters, and it goes to the business verbatim.
                  </p>
                )}
              </div>

              {needsOutcome && (
                <div className={styles.field}>
                  <label className="clay-label" htmlFor="outcome">
                    Outcome of the case
                  </label>
                  <textarea
                    id="outcome"
                    className="clay-input"
                    rows={3}
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value)}
                    placeholder={
                      pendingStatus === 'DISMISSED'
                        ? 'Why was the allegation not made out?'
                        : 'How did the matter end? This is what the register will show.'
                    }
                  />
                  <p className={outcome.trim().length < OUTCOME_MIN ? styles.hintWarn : styles.hint}>
                    At least {OUTCOME_MIN} characters. This is permanent, and the business is told
                    what it says.
                  </p>
                </div>
              )}

              <div className={styles.consoleActions}>
                {pendingStatus ? (
                  <>
                    <button
                      type="button"
                      className="clay-btn clay-btn-ghost clay-btn-sm"
                      onClick={() => {
                        setPendingStatus(null);
                        setOutcome('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="clay-btn clay-btn-primary clay-btn-sm"
                      disabled={saving || !transitionReady}
                      onClick={() =>
                        void patch(
                          {
                            status: pendingStatus,
                            note: note.trim() || undefined,
                            outcome: needsOutcome ? outcome.trim() : undefined,
                          },
                          `Case moved to ${statusLabel(pendingStatus).toLowerCase()}.`
                        )
                      }
                    >
                      {saving ? <Loader2 size={15} className={styles.spin} /> : null}
                      {TRANSITION_COPY[pendingStatus]?.label ?? 'Record'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="clay-btn clay-btn-secondary clay-btn-sm"
                    disabled={saving || note.trim().length === 0}
                    onClick={() => void patch({ note: note.trim() }, 'Note added to the case log.')}
                  >
                    {saving ? <Loader2 size={15} className={styles.spin} /> : null}
                    Add the note
                  </button>
                )}
              </div>
            </section>
          )}

          {/* ── The log ── */}
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>
              <Clock size={16} />
              Action log
              <span className={styles.countPill}>{c.actions.length}</span>
            </h2>
            <p className={styles.consoleLead}>
              Oldest first, because what a case has to prove is the sequence. Entries are appended;
              nothing here can be edited or removed.
            </p>
            <ol className={styles.timeline}>
              {c.actions.map((a, i) => (
                <li key={`${a.action}-${a.at}-${i}`} className={styles.timelineItem}>
                  <span className={styles.timelineDot} />
                  <div className={styles.timelineBody}>
                    <div className={styles.timelineHead}>
                      <strong>{actionLabel(a.action)}</strong>
                      <span className={styles.timelineAt}>{formatDateTime(a.at)}</span>
                    </div>
                    <span className={styles.timelineActor}>
                      {a.actor?.name
                        ? `${a.actor.name}${a.actor.officerCode ? ` (${a.actor.officerCode})` : ''}${
                            a.actor.designation ? ` · ${a.actor.designation}` : ''
                          }`
                        : a.actorRole
                          ? a.actorRole
                          : 'Filed from the public form'}
                    </span>
                    {a.note && <p className={styles.timelineNote}>{a.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        {/* ══ Side: the facts of the case ══ */}
        <aside className={styles.side}>
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>
              <Scale size={16} />
              Subject
            </h2>

            {subject.instrument ? (
              <Link
                href={`/dashboard/instruments?focus=${subject.instrument._id}`}
                className={styles.subjectCard}
              >
                <span className={styles.subjectKind}>Instrument</span>
                <strong>{subject.instrument.serialNo ?? '—'}</strong>
                <span className={styles.subjectSub}>
                  {[subject.instrument.brand, subject.instrument.model, subject.instrument.type]
                    .filter(Boolean)
                    .join(' · ')}
                  {subject.instrument.capacity ? ` · ${subject.instrument.capacity}` : ''}
                </span>
                <span className={styles.subjectSub}>
                  {subject.instrument.lastVerifiedDate
                    ? `Last verified ${formatDate(subject.instrument.lastVerifiedDate)}`
                    : 'Never verified'}
                  {subject.instrument.nextVerificationDue
                    ? ` · due ${formatDate(subject.instrument.nextVerificationDue)}`
                    : ''}
                </span>
                {(subject.instrument.failedInspectionCount ?? 0) > 0 && (
                  <span className={styles.subjectWarn}>
                    {subject.instrument.failedInspectionCount} failed inspection
                    {subject.instrument.failedInspectionCount === 1 ? '' : 's'} on record
                  </span>
                )}
              </Link>
            ) : (
              <p className={styles.empty}>
                No instrument is linked. A complaint that names no serial number is harder to make
                out, but not impossible — the address and the description may be enough to identify
                it on a visit.
              </p>
            )}

            {subject.certificate && (
              <div className={styles.subjectCard}>
                <span className={styles.subjectKind}>Certificate</span>
                <strong>{subject.certificate.certNo ?? '—'}</strong>
                <span className={styles.subjectSub}>
                  {subject.certificate.status}
                  {subject.certificate.expiryDate
                    ? ` · expires ${formatDate(subject.certificate.expiryDate)}`
                    : ''}
                  {subject.certificate.version ? ` · v${subject.certificate.version}` : ''}
                </span>
              </div>
            )}

            {subject.owner && (
              <div className={styles.subjectCard}>
                <span className={styles.subjectKind}>
                  <Building2 size={11} />
                  Business
                </span>
                <strong>{subject.owner.organizationName || subject.owner.name || '—'}</strong>
                <span className={styles.subjectSub}>
                  {[subject.owner.district, subject.owner.state].filter(Boolean).join(', ')}
                </span>
                <span className={styles.subjectSub}>
                  {[subject.owner.phone, subject.owner.email].filter(Boolean).join(' · ')}
                </span>
              </div>
            )}

            <div className={styles.metaLine}>
              <MapPin size={13} />
              {[c.jurisdiction?.district, c.jurisdiction?.state].filter(Boolean).join(', ') ||
                'Jurisdiction not recorded'}
            </div>
          </section>

          {/* ── Assignment ── */}
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>
              <UserCheck size={16} />
              Assigned to
            </h2>

            {assignee ? (
              <p className={styles.assigneeLine}>
                <strong>{assignee.name}</strong>
                {assignee.officerCode ? ` (${assignee.officerCode})` : ''}
                {assignee.designation ? <span>{assignee.designation}</span> : null}
                {c.assignedAt ? <span>since {formatDate(c.assignedAt)}</span> : null}
              </p>
            ) : (
              <p className={styles.unassigned}>
                <UserX size={15} />
                Nobody has picked this case up.
              </p>
            )}

            {!isTerminal && (
              <div className={styles.assignActions}>
                {!mine && myId && (
                  <button
                    type="button"
                    className="clay-btn clay-btn-primary clay-btn-sm"
                    disabled={saving}
                    onClick={() =>
                      void patch({ assignedTo: myId }, 'The case is assigned to you.')
                    }
                  >
                    {assignee ? 'Take over the case' : 'Take this case'}
                  </button>
                )}
                {mine && (
                  <p className={styles.hint}>
                    This case is yours. Reassigning it is an administrator’s action.
                  </p>
                )}

                {isAdmin && officers.length > 0 && (
                  <div className={styles.field}>
                    <label className="clay-label" htmlFor="assignTo">
                      Assign to an officer
                    </label>
                    <select
                      id="assignTo"
                      className="clay-select"
                      value={assignTo}
                      onChange={(e) => setAssignTo(e.target.value)}
                    >
                      <option value="">Choose an officer…</option>
                      {officers.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                          {o.officerCode ? ` (${o.officerCode})` : ''}
                          {o.district ? ` — ${o.district}` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="clay-btn clay-btn-outline clay-btn-sm"
                      disabled={saving || !assignTo}
                      onClick={async () => {
                        const okDone = await patch(
                          { assignedTo: assignTo },
                          'The case has been reassigned.'
                        );
                        if (okDone) setAssignTo('');
                      }}
                    >
                      Reassign
                    </button>
                    <p className={styles.hint}>
                      Only officers posted in {c.jurisdiction?.state ?? 'this state'} can hold this
                      case — assigning it elsewhere would put it beyond the reach of the office
                      responsible for it.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ── Severity ── */}
          {!isTerminal && (
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>
                <ShieldAlert size={16} />
                Severity
              </h2>
              <p className={styles.hint}>
                Severity orders the register; it does not decide the penalty. Retriaging is logged
                with the old value alongside the new one.
              </p>
              <div className={styles.severityRow}>
                {ENFORCEMENT_SEVERITIES.map((s: EnforcementSeverity) => (
                  <button
                    key={s}
                    type="button"
                    className={`${styles.severityBtn} ${
                      severityDraft === s ? styles.severityActive : ''
                    }`}
                    onClick={() => setSeverityDraft(s)}
                  >
                    {severityLabel(s)}
                  </button>
                ))}
              </div>
              {severityDraft !== c.severity && (
                <button
                  type="button"
                  className="clay-btn clay-btn-outline clay-btn-sm"
                  disabled={saving}
                  onClick={() =>
                    void patch(
                      { severity: severityDraft, note: note.trim() || undefined },
                      `Severity changed to ${severityLabel(severityDraft)}.`
                    )
                  }
                >
                  Record {severityLabel(c.severity)} → {severityLabel(severityDraft)}
                </button>
              )}
            </section>
          )}

          {/* ── Penalty ── */}
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>
              <IndianRupee size={16} />
              Penalty
            </h2>

            {penaltyRecorded ? (
              <>
                <p className={styles.penaltyAmount}>{formatInr(c.penalty?.amount ?? 0)}</p>
                <p className={styles.subjectSub}>
                  Imposed under {c.penalty?.reference ?? 'reference not recorded'}
                  {c.penalty?.imposedAt ? ` on ${formatDate(c.penalty.imposedAt)}` : ''}
                </p>
                {c.penalty?.paidAt ? (
                  <p className={styles.paidLine}>
                    <CheckCircle2 size={14} />
                    Paid {formatDate(c.penalty.paidAt)}
                  </p>
                ) : (
                  <>
                    <p className={styles.unpaidLine}>
                      <AlertTriangle size={14} />
                      Unpaid
                    </p>
                    {!isTerminal && (
                      <button
                        type="button"
                        className="clay-btn clay-btn-secondary clay-btn-sm"
                        disabled={saving}
                        onClick={() =>
                          void patch({ penaltyPaid: true }, 'The payment is on the record.')
                        }
                      >
                        Record payment
                      </button>
                    )}
                  </>
                )}
              </>
            ) : canRecordPenalty ? (
              <>
                <div className={styles.field}>
                  <label className="clay-label" htmlFor="penaltyAmount">
                    Amount in rupees
                  </label>
                  <input
                    id="penaltyAmount"
                    type="number"
                    min={0}
                    step={1}
                    className="clay-input"
                    value={penaltyAmount}
                    onChange={(e) => setPenaltyAmount(e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label className="clay-label" htmlFor="penaltyReference">
                    Section it is imposed under
                  </label>
                  <input
                    id="penaltyReference"
                    className="clay-input"
                    value={penaltyReference}
                    onChange={(e) => setPenaltyReference(e.target.value)}
                    placeholder="e.g. s. 25, Legal Metrology Act 2009"
                  />
                  <p className={styles.hint}>
                    The Act sets the ceilings. Recording the section the penalty is imposed under is
                    what makes the figure defensible if it is challenged.
                  </p>
                </div>
                <button
                  type="button"
                  className="clay-btn clay-btn-primary clay-btn-sm"
                  disabled={
                    saving ||
                    penaltyReference.trim().length === 0 ||
                    !Number.isFinite(Number(penaltyAmount)) ||
                    Number(penaltyAmount) < 0 ||
                    penaltyAmount.trim() === ''
                  }
                  onClick={async () => {
                    const okDone = await patch(
                      {
                        penalty: {
                          amount: Number(penaltyAmount),
                          reference: penaltyReference.trim(),
                        },
                        note: note.trim() || undefined,
                      },
                      'The penalty is on the record and the business has been notified.'
                    );
                    if (okDone) {
                      setPenaltyAmount('');
                      setPenaltyReference('');
                    }
                  }}
                >
                  {saving ? <Loader2 size={15} className={styles.spin} /> : null}
                  Record the penalty
                </button>
              </>
            ) : (
              <p className={styles.empty}>
                {isTerminal
                  ? 'No penalty was imposed on this case.'
                  : 'A penalty can only be recorded once a notice has been issued. Issue the notice first — a penalty with no notice and no hearing is not something this register can represent.'}
              </p>
            )}
          </section>

          {/* ── Prior cases ── */}
          {priorCases.length > 0 && (
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>
                <ShieldAlert size={16} />
                Other cases against this business
                <span className={styles.countPill}>{priorCases.length}</span>
              </h2>
              <p className={styles.hint}>
                Relevant to severity and to penalty, and the reason REPEAT_OFFENDER exists as a case
                type. It is not evidence in this case.
              </p>
              <ul className={styles.priorList}>
                {priorCases.map((p) => (
                  <li key={p._id}>
                    <Link href={`/dashboard/enforcement/${p._id}`}>
                      <span className={styles.priorNo}>{p.caseNo}</span>
                      <span className={`clay-badge ${enforcementStatusBadgeClass(p.status)}`}>
                        {statusLabel(p.status)}
                      </span>
                    </Link>
                    <span className={styles.priorMeta}>
                      {ENFORCEMENT_CASE_TYPE_LABELS[p.caseType as EnforcementCaseType] ?? p.caseType}{' '}
                      · {formatDate(p.createdAt)}
                      {p.penalty?.amount ? ` · ${formatInr(p.penalty.amount)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
