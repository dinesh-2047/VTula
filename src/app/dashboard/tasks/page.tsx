'use client';

import { useState, useEffect, useCallback, useMemo, type ChangeEvent } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import {
  ClipboardCheck,
  CheckCircle,
  XCircle,
  Search,
  MapPin,
  Calendar,
  ShieldCheck,
  Loader2,
  Camera,
  Scale,
  Award,
  Crosshair,
  Clock,
  FileSearch,
  Gavel,
  Layers,
  AlertTriangle,
  Trash2,
  ExternalLink,
  Paperclip,
  CalendarClock,
  Info,
  TriangleAlert,
} from 'lucide-react';
import {
  APPLICATION_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  MAX_UPLOAD_BYTES,
  VERIFICATION_TYPE_LABELS,
  applicationStatusLabel,
  daysUntil,
  formatDate,
  formatDateTime,
  type ApplicationStatus,
} from '@/lib/constants';
import styles from './tasks.module.css';

/**
 * The officer / inspector work console.
 *
 * What this replaces, in the words of what it actually did:
 *
 *  - It rendered a "Digital Signature: HMAC-SHA256-<mongo id>" line on a
 *    certificate shown to users. That is a template string, not a signature. The
 *    real one is produced by `signCertificateData()` server-side and is never
 *    reconstructible in a browser.
 *  - When an approved application had no certificate, it *invented* one —
 *    `LMO-CERT-<app no>`, issued today, expiring in exactly one year, sealed with
 *    `LMO-SEAL-VERIFIED` — and offered it for print. A printed certificate with a
 *    fabricated number is a forged government document.
 *  - Calibration readings were one free-text box, pre-filled with
 *    "Tolerance Class III — ±0.1g compliance verified" before the instrument had
 *    been touched, and the inspector chose PASS or FAIL by clicking a button.
 *  - The seal number was `LMO-STAMP-${Math.random()}`, generated in the browser.
 *  - When the device refused location access it silently substituted Delhi
 *    (28.6139, 77.209) and recorded that as the inspection's GPS evidence.
 *  - Photographs were read into base64 data-URLs and posted inside the JSON body.
 *  - The QR code was fetched from `api.qrserver.com`, so verifying a certificate
 *    depended on a third party and leaked every certificate number to it.
 *
 * Everything here now goes through the endpoints that own each concern and audit
 * it: `/api/inspections` computes pass/fail from the rule's tolerance table,
 * `/api/documents` stores evidence with a SHA-256, `/api/schedules` books the
 * visit and picks the inspector, and `/api/applications/[id]/transition` is the
 * only way a status moves. The buttons this page offers come from the server's own
 * `availableTransitions`, so it cannot present an action the server would refuse.
 */

/* ------------------------------------------------------------------ *
 * API shapes
 * ------------------------------------------------------------------ */

interface Populated {
  _id: string;
  name?: string;
  role?: string;
  designation?: string;
}

interface QueueTask {
  _id: string;
  applicationNo: string;
  type: string;
  status: ApplicationStatus;
  submittedDate?: string;
  dueDate?: string;
  feeAmount?: number;
  feePaid?: number;
  feeStatus?: string;
  priorityScore?: number;
  priorityReasons?: string[];
  jurisdiction?: { state?: string; district?: string };
  instrumentId?: {
    _id: string;
    type: string;
    brand: string;
    model: string;
    serialNo: string;
    capacity?: string;
    accuracyClass?: string;
    address?: string;
    installationDistrict?: string;
    installationState?: string;
    gpsCoordinates?: { lat: number; lng: number };
  };
  ownerId?: {
    _id: string;
    name?: string;
    organizationName?: string;
    phone?: string;
    email?: string;
  };
  assignedTo?: Populated;
  inspection?: {
    _id: string;
    inspectionNo: string;
    version: number;
    result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    isSubmitted: boolean;
    inspectedAt?: string;
    gpsDriftMetres?: number;
    readings?: { label: string; reference: number; observed: number; errorPercent: number; withinTolerance: boolean }[];
  } | null;
  schedule?: {
    _id: string;
    scheduledDate?: string;
    slotStart?: string;
    slotEnd?: string;
    status?: string;
    assignedTo?: Populated;
    assignmentRationale?: string[];
  } | null;
  riskFlags?: {
    _id: string;
    flagType: string;
    level: string;
    score: number;
    title: string;
    reasons?: string[];
    recommendedAction?: string;
  }[];
  availableTransitions?: ApplicationStatus[];
}

interface TemplateReading {
  label: string;
  reference: number;
  observed: null;
  unit: string;
  maxErrorPercent: number;
}

interface InspectionTemplate {
  applicationNo: string;
  instrument: {
    id: string;
    label: string;
    type: string;
    capacity?: string;
    address?: string;
    district?: string;
    state?: string;
    registeredGps?: { lat: number; lng: number };
  };
  readings: TemplateReading[];
  conformityChecks: { code: string; label: string; result: 'PASS' | 'FAIL' | 'NA' }[];
  requirements: {
    minEvidencePhotos: number;
    requireGpsEvidence: boolean;
    gpsToleranceMetres: number;
    legalReference?: string;
  };
  appliedRule: { name: string; matchedScope: string };
}

interface UploadedEvidence {
  id: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  href: string;
}

interface IssuedCertificate {
  id: string;
  certNo: string;
  expiryDate: string;
  qrDataUrl: string;
}

/* ------------------------------------------------------------------ *
 * Queue stages
 * ------------------------------------------------------------------ */

const STAGES = [
  {
    key: 'review',
    label: 'Review',
    icon: FileSearch,
    statuses: ['SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED'] as ApplicationStatus[],
  },
  {
    key: 'scheduling',
    label: 'Scheduling',
    icon: CalendarClock,
    statuses: ['APPROVED_FOR_SCHEDULING', 'SCHEDULED'] as ApplicationStatus[],
  },
  {
    key: 'inspection',
    label: 'Inspection',
    icon: ClipboardCheck,
    statuses: ['INSPECTION_IN_PROGRESS', 'INSPECTION_SUBMITTED'] as ApplicationStatus[],
  },
  {
    key: 'decision',
    label: 'Decision',
    icon: Gavel,
    statuses: ['UNDER_DECISION'] as ApplicationStatus[],
  },
  {
    key: 'certificate',
    label: 'Certificate',
    icon: Award,
    statuses: ['APPROVED'] as ApplicationStatus[],
  },
  { key: 'all', label: 'All open', icon: Layers, statuses: [] as ApplicationStatus[] },
] as const;

type StageKey = (typeof STAGES)[number]['key'];

/**
 * What each transition asks of the officer.
 *
 * `requires` is not cosmetic: the server refuses `QUERY_RAISED` without a message
 * and `APPROVED`/`REJECTED` without a written justification, so a form that did
 * not collect them would produce a confusing 400 rather than a clear prompt.
 */
const TRANSITIONS: Record<
  string,
  {
    label: string;
    heading: string;
    help: string;
    requires: 'justification' | 'reason' | 'none';
    tone: 'primary' | 'secondary' | 'ghost';
    icon: typeof CheckCircle;
  }
> = {
  UNDER_REVIEW: {
    label: 'Begin review',
    heading: 'Take this application under review',
    help: 'Records that this file is now with you. The applicant sees that it has been picked up.',
    requires: 'none',
    tone: 'primary',
    icon: FileSearch,
  },
  QUERY_RAISED: {
    label: 'Raise a query',
    heading: 'Ask the applicant for something',
    help: 'The applicant is notified and the file waits with them. Say plainly what they must provide.',
    requires: 'reason',
    tone: 'secondary',
    icon: Info,
  },
  APPROVED_FOR_SCHEDULING: {
    label: 'Clear for scheduling',
    heading: 'Clear the paperwork and send this for scheduling',
    help: 'The documents are in order. The file becomes bookable for a field visit.',
    requires: 'none',
    tone: 'primary',
    icon: CheckCircle,
  },
  INSPECTION_IN_PROGRESS: {
    label: 'Mark visit started',
    heading: 'Record that the inspection visit has begun',
    help: 'Use this when the inspector has reached the site.',
    requires: 'none',
    tone: 'ghost',
    icon: Clock,
  },
  UNDER_DECISION: {
    label: 'Take for decision',
    heading: 'Take the inspection report for decision',
    help: 'Moves the report onto your desk for approval or rejection.',
    requires: 'none',
    tone: 'primary',
    icon: Gavel,
  },
  APPROVED: {
    label: 'Approve',
    heading: 'Approve this application',
    help: 'Only possible on a submitted inspection that passed. Your justification is recorded against the decision and is visible to the applicant.',
    requires: 'justification',
    tone: 'primary',
    icon: CheckCircle,
  },
  REJECTED: {
    label: 'Reject',
    heading: 'Reject this application',
    help: 'The instrument is marked unverified and the failure is counted against the business. State the grounds — the applicant is entitled to know them.',
    requires: 'justification',
    tone: 'secondary',
    icon: XCircle,
  },
  CERTIFICATE_GENERATED: {
    label: 'Issue certificate',
    heading: 'Issue the verification certificate',
    help: 'Signs and registers the certificate, supersedes any earlier one for this instrument, and notifies the business. Validity comes from the applicable rule, not from a fixed one year.',
    requires: 'none',
    tone: 'primary',
    icon: Award,
  },
  CANCELLED: {
    label: 'Cancel',
    heading: 'Cancel this application',
    help: 'Closes the file with no verification. Say why.',
    requires: 'reason',
    tone: 'ghost',
    icon: Trash2,
  },
};

/** Handled by `/api/schedules`, not by the transition endpoint. */
const SCHEDULE_TRANSITION = 'SCHEDULED';

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function TasksPage() {
  const { data: session } = useSession();

  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [scope, setScope] = useState<{ role: string; state: string | null; district: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [stage, setStage] = useState<StageKey>('review');
  const [search, setSearch] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);

  const [detailTask, setDetailTask] = useState<QueueTask | null>(null);
  const [issued, setIssued] = useState<IssuedCertificate | null>(null);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  /* Bumped to re-run the queue query — after an action, or when the officer
   * retries a failed load. */
  const [reloadKey, setReloadKey] = useState(0);

  // `session.user.role` is typed by the augmentation in `src/types/next-auth.d.ts`,
  // so no cast is needed. `scope.role` is the server's own answer and is the
  // fallback while the session is still resolving.
  const userRole = session?.user?.role ?? scope?.role ?? '';

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ limit: '100' });
        if (onlyMine) params.set('assignedToMe', 'true');
        const res = await fetch(`/api/tasks?${params.toString()}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.success) {
          setLoadError(data.error ?? 'The work queue could not be loaded.');
          return;
        }
        setTasks(data.tasks ?? []);
        setCounts(data.countsByStatus ?? {});
        setScope(data.scope ?? null);
        setLoadError(null);
      } catch {
        if (!cancelled) {
          setLoadError('The work queue could not be reached. Check your connection and try again.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onlyMine, reloadKey]);

  /* Search and stage filtering happen client-side over the fetched page; the
   * counts in the tabs come from the server's aggregate over the whole scope, so
   * a tab never claims a number the query did not produce. */
  const visible = useMemo(() => {
    const stageDef = STAGES.find((s) => s.key === stage);
    const q = search.trim().toLowerCase();

    return tasks.filter((t) => {
      if (stageDef && stageDef.statuses.length > 0 && !stageDef.statuses.includes(t.status)) {
        return false;
      }
      if (!q) return true;
      return [
        t.applicationNo,
        t.ownerId?.name,
        t.ownerId?.organizationName,
        t.instrumentId?.serialNo,
        t.instrumentId?.type,
        t.instrumentId?.brand,
        t.jurisdiction?.district,
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  }, [tasks, stage, search]);

  const stageCount = useCallback(
    (statuses: readonly ApplicationStatus[]) =>
      statuses.length === 0
        ? Object.values(counts).reduce((sum, n) => sum + n, 0)
        : statuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0),
    [counts]
  );

  const afterAction = useCallback(
    (message: string, certificate?: IssuedCertificate) => {
      setBanner({ tone: 'ok', text: message });
      if (certificate) setIssued(certificate);
      setDetailTask(null);
      reload();
    },
    [reload]
  );

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading your work queue…</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Verification Console</h1>
          <p>
            Applications awaiting action from you
            {scope?.district ? ` in ${scope.district}, ${scope.state}` : scope?.state ? ` in ${scope.state}` : ''}
            . Ordered by advisory priority — every score is explained on the card.
          </p>
        </div>

        {scope && (
          <div className={styles.scopeChip}>
            <ShieldCheck size={16} />
            <div>
              <strong>{scope.role}</strong>
              <span>
                {scope.district
                  ? `${scope.district}, ${scope.state}`
                  : scope.state ?? 'All jurisdictions'}
              </span>
            </div>
          </div>
        )}
      </div>

      {banner && (
        <div className={banner.tone === 'ok' ? styles.bannerOk : styles.bannerBad}>
          {banner.tone === 'ok' ? <CheckCircle size={17} /> : <TriangleAlert size={17} />}
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {loadError && (
        <div className={styles.bannerBad}>
          <TriangleAlert size={17} />
          <span>{loadError}</span>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      )}

      <div className={styles.controlsBar}>
        <div className="clay-tabs" style={{ display: 'flex', flexWrap: 'wrap', width: 'auto', margin: 0 }}>
          {STAGES.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.key}
                className={`clay-tab ${stage === s.key ? 'active' : ''}`}
                onClick={() => setStage(s.key)}
              >
                <Icon size={15} style={{ display: 'inline', marginRight: 6 }} />
                {s.label} ({stageCount(s.statuses)})
              </button>
            );
          })}
        </div>

        <div className={styles.searchWrap}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} className={styles.searchIcon} />
            <input
              type="text"
              className={`clay-input ${styles.searchInput}`}
              placeholder="Application no, business, serial no, district…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label className={styles.mineToggle}>
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
            Assigned to me
          </label>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="clay-card" style={{ textAlign: 'center', padding: '44px 20px' }}>
          <ClipboardCheck size={46} style={{ color: 'var(--text-muted)', marginBottom: 12 }} />
          <h3>Nothing waiting here</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: 460, margin: '6px auto 0' }}>
            {search
              ? 'No application in this stage matched your search.'
              : `No application is currently at the ${STAGES.find((s) => s.key === stage)?.label.toLowerCase()} stage in your jurisdiction.`}
          </p>
        </div>
      ) : (
        <div className={styles.grid}>
          {visible.map((task) => (
            <TaskCard key={task._id} task={task} onOpen={() => setDetailTask(task)} />
          ))}
        </div>
      )}

      {detailTask && (
        <TaskDetail
          task={detailTask}
          role={userRole}
          onClose={() => setDetailTask(null)}
          onDone={afterAction}
          onError={(text) => setBanner({ tone: 'bad', text })}
        />
      )}

      {issued && <CertificateIssued certificate={issued} onClose={() => setIssued(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Queue card
 * ------------------------------------------------------------------ */

function TaskCard({ task, onOpen }: { task: QueueTask; onOpen: () => void }) {
  // `daysUntil` is negative once the date has passed. The SLA clock is the whole
  // reason this queue exists, so an overdue file says so on its face.
  const dueIn = daysUntil(task.dueDate);
  const overdueDays = dueIn !== null && dueIn < 0 ? -dueIn : null;
  const flags = task.riskFlags ?? [];

  return (
    <div className={styles.taskCard}>
      <div className={styles.cardHeader}>
        <div className={styles.taskIcon}>
          <ClipboardCheck size={22} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={styles.appNo}>{task.applicationNo}</div>
          <div className={styles.ownerName}>
            {task.ownerId?.organizationName || task.ownerId?.name || 'Business not recorded'}
          </div>
        </div>
        <span className={`clay-badge ${badgeFor(task.status)}`}>{applicationStatusLabel(task.status)}</span>
      </div>

      <div style={{ flex: 1 }}>
        <div className={styles.instTitle}>{task.instrumentId?.type ?? 'Instrument not recorded'}</div>
        <div className={styles.instSub}>
          {task.instrumentId?.brand} {task.instrumentId?.model}
          {task.instrumentId?.capacity ? ` · ${task.instrumentId.capacity}` : ''}
        </div>

        <div className={styles.infoRow}>
          <Scale size={14} />
          <span>Serial</span>
          <strong style={{ fontFamily: 'var(--font-mono, monospace)' }}>
            {task.instrumentId?.serialNo ?? '—'}
          </strong>
        </div>

        {task.instrumentId?.address && (
          <div className={styles.infoRow}>
            <MapPin size={14} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {task.instrumentId.address}
              {task.instrumentId.installationDistrict ? `, ${task.instrumentId.installationDistrict}` : ''}
            </span>
          </div>
        )}

        <div className={styles.infoRow}>
          <Calendar size={14} />
          <span>Filed {formatDate(task.submittedDate)}</span>
          <span className="clay-badge clay-badge-info" style={{ marginLeft: 'auto' }}>
            {VERIFICATION_TYPE_LABELS[task.type as keyof typeof VERIFICATION_TYPE_LABELS] ?? task.type}
          </span>
        </div>

        {task.dueDate && (
          <div className={styles.infoRow}>
            <Clock size={14} />
            {overdueDays !== null && overdueDays > 0 ? (
              <strong style={{ color: 'var(--color-danger, #c0392b)' }}>
                {overdueDays} day{overdueDays === 1 ? '' : 's'} past its due date
              </strong>
            ) : (
              <span>Due {formatDate(task.dueDate)}</span>
            )}
          </div>
        )}

        {task.schedule?.scheduledDate && (
          <div className={styles.infoRow}>
            <CalendarClock size={14} />
            <span>
              Visit {formatDate(task.schedule.scheduledDate)}
              {task.schedule.slotStart ? `, ${task.schedule.slotStart}` : ''}
              {task.schedule.assignedTo?.name ? ` — ${task.schedule.assignedTo.name}` : ''}
            </span>
          </div>
        )}

        {task.inspection && (
          <div className={styles.infoRow}>
            <ShieldCheck size={14} />
            <span>
              {task.inspection.inspectionNo}
              {task.inspection.version > 1 ? ` (v${task.inspection.version})` : ''}
            </span>
            <span
              className={`clay-badge ${
                task.inspection.result === 'PASS'
                  ? 'clay-badge-success'
                  : task.inspection.result === 'FAIL'
                    ? 'clay-badge-error'
                    : 'clay-badge-warning'
              }`}
              style={{ marginLeft: 'auto' }}
            >
              {task.inspection.isSubmitted ? task.inspection.result : 'Draft'}
            </span>
          </div>
        )}

        {(task.priorityReasons?.length ?? 0) > 0 && (
          <details className={styles.priorityBox}>
            <summary>
              Priority {task.priorityScore ?? 0}
              <span> · why?</span>
            </summary>
            <ul>
              {task.priorityReasons!.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </details>
        )}

        {flags.length > 0 && (
          <div className={styles.flagStrip}>
            <AlertTriangle size={14} />
            <span>
              {flags.length} risk signal{flags.length === 1 ? '' : 's'} — advisory only
            </span>
          </div>
        )}
      </div>

      <div className={styles.cardFooter}>
        <button className="clay-btn clay-btn-primary clay-btn-sm" style={{ width: '100%' }} onClick={onOpen}>
          Open file
        </button>
      </div>
    </div>
  );
}

function badgeFor(status: string): string {
  switch (status) {
    case 'APPROVED':
    case 'CERTIFICATE_GENERATED':
    case 'ACTIVE':
      return 'clay-badge-success';
    case 'REJECTED':
    case 'CANCELLED':
      return 'clay-badge-error';
    case 'QUERY_RAISED':
      return 'clay-badge-warning';
    default:
      return 'clay-badge-info';
  }
}

/* ------------------------------------------------------------------ *
 * File detail + actions
 * ------------------------------------------------------------------ */

function TaskDetail({
  task,
  role,
  onClose,
  onDone,
  onError,
}: {
  task: QueueTask;
  role: string;
  onClose: () => void;
  onDone: (message: string, certificate?: IssuedCertificate) => void;
  onError: (text: string) => void;
}) {
  const [mode, setMode] = useState<'file' | 'inspect' | 'schedule' | ApplicationStatus>('file');

  const transitions = (task.availableTransitions ?? []).filter((t) => TRANSITIONS[t] || t === SCHEDULE_TRANSITION);
  const canInspect = ['SCHEDULED', 'INSPECTION_IN_PROGRESS', 'INSPECTION_SUBMITTED'].includes(task.status);

  if (mode === 'inspect') {
    return (
      <InspectionForm
        task={task}
        onCancel={() => setMode('file')}
        onDone={onDone}
        onError={onError}
      />
    );
  }

  if (mode === 'schedule') {
    return <ScheduleForm task={task} onCancel={() => setMode('file')} onDone={onDone} onError={onError} />;
  }

  if (mode !== 'file') {
    return (
      <TransitionForm
        task={task}
        target={mode}
        onCancel={() => setMode('file')}
        onDone={onDone}
        onError={onError}
      />
    );
  }

  return (
    <div className="clay-modal-overlay">
      <div className="clay-modal" style={{ maxWidth: 700, maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="clay-modal-header">
          <div>
            <h3 className="clay-modal-title">{task.applicationNo}</h3>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
              {applicationStatusLabel(task.status)} ·{' '}
              {VERIFICATION_TYPE_LABELS[task.type as keyof typeof VERIFICATION_TYPE_LABELS] ?? task.type}
            </p>
          </div>
          <button className="clay-btn clay-btn-sm clay-btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section className={styles.modalInfoBox}>
            <h4>Business</h4>
            <div>
              <strong>{task.ownerId?.organizationName || task.ownerId?.name || 'Not recorded'}</strong>
              {task.ownerId?.organizationName && task.ownerId?.name ? ` — ${task.ownerId.name}` : ''}
            </div>
            {task.ownerId?.phone && <div>{task.ownerId.phone}</div>}
            {task.ownerId?.email && <div>{task.ownerId.email}</div>}
          </section>

          <section className={styles.modalInfoBox}>
            <h4>Instrument</h4>
            <div>
              {task.instrumentId?.type} — {task.instrumentId?.brand} {task.instrumentId?.model}
            </div>
            <div>
              Serial <strong style={{ fontFamily: 'var(--font-mono, monospace)' }}>{task.instrumentId?.serialNo}</strong>
              {task.instrumentId?.capacity ? ` · Capacity ${task.instrumentId.capacity}` : ''}
              {task.instrumentId?.accuracyClass ? ` · Class ${task.instrumentId.accuracyClass}` : ''}
            </div>
            <div>
              {task.instrumentId?.address}
              {task.instrumentId?.installationDistrict ? `, ${task.instrumentId.installationDistrict}` : ''}
              {task.instrumentId?.installationState ? `, ${task.instrumentId.installationState}` : ''}
            </div>
            {task.instrumentId?._id && (
              <Link href={`/dashboard/instruments/${task.instrumentId._id}`} className={styles.inlineLink}>
                Open the instrument&apos;s full history <ExternalLink size={12} />
              </Link>
            )}
          </section>

          <section className={styles.modalInfoBox}>
            <h4>Fee</h4>
            <div>
              Assessed ₹{(task.feeAmount ?? 0).toLocaleString('en-IN')} · Received ₹
              {(task.feePaid ?? 0).toLocaleString('en-IN')} ·{' '}
              <span className={`clay-badge ${task.feeStatus === 'Paid' ? 'clay-badge-success' : 'clay-badge-warning'}`}>
                {task.feeStatus ?? 'Unpaid'}
              </span>
            </div>
            {task.feeStatus !== 'Paid' && task.feeStatus !== 'Waived' && (
              <p className={styles.note}>
                A certificate cannot be issued until the statutory fee is paid or formally waived.
              </p>
            )}
          </section>

          {task.inspection && (
            <section className={styles.modalInfoBox}>
              <h4>Inspection on file</h4>
              <div>
                {task.inspection.inspectionNo} (v{task.inspection.version}) —{' '}
                <strong>{task.inspection.isSubmitted ? task.inspection.result : 'unsubmitted draft'}</strong>
                {task.inspection.inspectedAt ? ` · ${formatDateTime(task.inspection.inspectedAt)}` : ''}
              </div>
              {task.inspection.gpsDriftMetres != null && (
                <div>Captured {task.inspection.gpsDriftMetres} m from the registered site.</div>
              )}
              {(task.inspection.readings?.length ?? 0) > 0 && (
                <table className={styles.readingTable}>
                  <thead>
                    <tr>
                      <th>Test point</th>
                      <th>Reference</th>
                      <th>Observed</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {task.inspection.readings!.map((r, i) => (
                      <tr key={i} className={r.withinTolerance ? undefined : styles.rowFail}>
                        <td>{r.label}</td>
                        <td>{r.reference}</td>
                        <td>{r.observed}</td>
                        <td>{r.errorPercent?.toFixed(3)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {(task.riskFlags?.length ?? 0) > 0 && (
            <section className={styles.riskBox}>
              <h4>
                <AlertTriangle size={15} /> Risk signals
              </h4>
              <p className={styles.note}>
                Advisory only. These order your attention and decide nothing — the decision is yours.
              </p>
              {task.riskFlags!.map((f) => (
                <div key={f._id} className={styles.riskItem}>
                  <div>
                    <strong>{f.title}</strong>
                    <span className="clay-badge clay-badge-warning" style={{ marginLeft: 8 }}>
                      {f.level} · {f.score}
                    </span>
                  </div>
                  {(f.reasons?.length ?? 0) > 0 && (
                    <ul>
                      {f.reasons!.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {f.recommendedAction && <p className={styles.note}>Suggested: {f.recommendedAction}</p>}
                </div>
              ))}
            </section>
          )}

          {task.schedule && (
            <section className={styles.modalInfoBox}>
              <h4>Inspection slot</h4>
              <div>
                {formatDate(task.schedule.scheduledDate)}
                {task.schedule.slotStart ? ` · ${task.schedule.slotStart}–${task.schedule.slotEnd ?? ''}` : ''} ·{' '}
                {task.schedule.status}
              </div>
              {task.schedule.assignedTo?.name && (
                <div>
                  Assigned to {task.schedule.assignedTo.name}
                  {task.schedule.assignedTo.designation ? `, ${task.schedule.assignedTo.designation}` : ''}
                </div>
              )}
              {(task.schedule.assignmentRationale?.length ?? 0) > 0 && (
                <ul className={styles.rationale}>
                  {task.schedule.assignmentRationale!.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* Actions, taken from the server's own list of legal next steps. */}
          <section>
            <h4 style={{ fontSize: '0.9rem', marginBottom: 10 }}>What you can do now</h4>

            {canInspect && (
              <button
                className="clay-btn clay-btn-primary"
                style={{ width: '100%', marginBottom: 10 }}
                onClick={() => setMode('inspect')}
              >
                <ClipboardCheck size={16} />
                {task.inspection?.isSubmitted ? 'File a corrected inspection report' : 'Record the inspection'}
              </button>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {transitions.map((t) => {
                if (t === SCHEDULE_TRANSITION) {
                  return (
                    <button
                      key={t}
                      className="clay-btn clay-btn-primary clay-btn-sm"
                      onClick={() => setMode('schedule')}
                    >
                      <CalendarClock size={15} /> Book the inspection
                    </button>
                  );
                }
                const copy = TRANSITIONS[t];
                const Icon = copy.icon;
                return (
                  <button
                    key={t}
                    className={`clay-btn clay-btn-${copy.tone} clay-btn-sm`}
                    onClick={() => setMode(t)}
                  >
                    <Icon size={15} /> {copy.label}
                  </button>
                );
              })}
            </div>

            {transitions.length === 0 && !canInspect && (
              <p className={styles.note}>
                No action is available to a {role || 'user'} at this stage. This file is waiting on someone else —
                the applicant, an inspector, or a deciding officer.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Transition
 * ------------------------------------------------------------------ */

function TransitionForm({
  task,
  target,
  onCancel,
  onDone,
  onError,
}: {
  task: QueueTask;
  target: ApplicationStatus;
  onCancel: () => void;
  onDone: (message: string, certificate?: IssuedCertificate) => void;
  onError: (text: string) => void;
}) {
  const copy = TRANSITIONS[target];
  const [text, setText] = useState('');
  const [legalReference, setLegalReference] = useState('');
  const [queryDueDays, setQueryDueDays] = useState(14);
  const [requested, setRequested] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsText = copy.requires !== 'none';

  const submit = async () => {
    if (needsText && text.trim().length < 10) {
      setError(
        copy.requires === 'justification'
          ? 'A decision needs a written justification. It is recorded against the file and shown to the applicant.'
          : 'Say what you need, in at least a few words.'
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${task._id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: target,
          ...(copy.requires === 'justification'
            ? { justification: text.trim(), legalReference: legalReference.trim() || undefined }
            : {}),
          ...(copy.requires === 'reason' ? { reason: text.trim() } : {}),
          ...(target === 'QUERY_RAISED'
            ? { requestedDocuments: requested, queryDueDays }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? 'The action could not be completed.');
        return;
      }

      onDone(
        target === 'CERTIFICATE_GENERATED'
          ? `Certificate ${data.certificate?.certNo ?? ''} issued for ${task.applicationNo}.`
          : `${task.applicationNo} is now ${APPLICATION_STATUS_LABELS[target] ?? target}.`,
        data.certificate
      );
    } catch {
      onError('The request could not be sent. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="clay-modal-overlay">
      <div className="clay-modal" style={{ maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="clay-modal-header">
          <h3 className="clay-modal-title">{copy.heading}</h3>
          <button className="clay-btn clay-btn-sm clay-btn-ghost" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p className={styles.note}>{copy.help}</p>

          <div className={styles.modalInfoBox}>
            <div>
              <strong>{task.applicationNo}</strong> — {task.instrumentId?.type}, serial{' '}
              {task.instrumentId?.serialNo}
            </div>
            <div>{task.ownerId?.organizationName || task.ownerId?.name}</div>
          </div>

          {needsText && (
            <div className="clay-input-group">
              <label className="clay-label">
                {copy.requires === 'justification' ? 'Written justification' : 'Message to the applicant'}
              </label>
              <textarea
                className="clay-input"
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  copy.requires === 'justification'
                    ? 'State the grounds for this decision, referring to the readings or the documents.'
                    : 'e.g. The purchase invoice is illegible. Please upload a clear copy showing the serial number.'
                }
              />
            </div>
          )}

          {target === 'QUERY_RAISED' && (
            <>
              <div className="clay-input-group">
                <label className="clay-label">Documents you need (optional)</label>
                <div className={styles.checkGrid}>
                  {(Object.keys(DOCUMENT_TYPE_LABELS) as (keyof typeof DOCUMENT_TYPE_LABELS)[])
                    .filter((k) => k !== 'INSPECTION_EVIDENCE')
                    .map((k) => (
                      <label key={k} className={styles.checkItem}>
                        <input
                          type="checkbox"
                          checked={requested.includes(k)}
                          onChange={(e) =>
                            setRequested((prev) =>
                              e.target.checked ? [...prev, k] : prev.filter((x) => x !== k)
                            )
                          }
                        />
                        {DOCUMENT_TYPE_LABELS[k]}
                      </label>
                    ))}
                </div>
              </div>
              <div className="clay-input-group">
                <label className="clay-label">Days allowed to respond</label>
                <input
                  type="number"
                  min={1}
                  max={90}
                  className="clay-input"
                  value={queryDueDays}
                  onChange={(e) => setQueryDueDays(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            </>
          )}

          {copy.requires === 'justification' && (
            <div className="clay-input-group">
              <label className="clay-label">Legal reference (optional)</label>
              <input
                type="text"
                className="clay-input"
                value={legalReference}
                onChange={(e) => setLegalReference(e.target.value)}
                placeholder="e.g. Legal Metrology Act 2009, s.24"
              />
            </div>
          )}

          {target === 'CERTIFICATE_GENERATED' && (
            <p className={styles.note}>
              The certificate number, validity period and digital signature are all produced by the server. Nothing
              on this screen can influence them.
            </p>
          )}

          {error && (
            <div className={styles.bannerBad}>
              <TriangleAlert size={16} />
              <span>{error}</span>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button className="clay-btn clay-btn-ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className={`clay-btn clay-btn-${copy.tone}`} onClick={submit} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 size={16} className={styles.spin} /> Working…
                </>
              ) : (
                copy.label
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

function ScheduleForm({
  task,
  onCancel,
  onDone,
  onError,
}: {
  task: QueueTask;
  onCancel: () => void;
  onDone: (message: string) => void;
  onError: (text: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [slotStart, setSlotStart] = useState('10:00');
  const [slotEnd, setSlotEnd] = useState('12:00');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    assignee: { name: string; role: string; designation?: string };
    rationale: string[];
    alternatives: { id: string; name: string; score: number; loadOnDate: number }[];
    scheduledDate: string;
  } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: task._id,
          scheduledDate: date,
          slotStart,
          slotEnd,
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? 'The slot could not be booked.');
        return;
      }
      setResult({
        assignee: data.assignee,
        rationale: data.rationale ?? [],
        alternatives: data.alternatives ?? [],
        scheduledDate: data.schedule?.scheduledDate,
      });
    } catch {
      onError('The request could not be sent. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="clay-modal-overlay">
      <div className="clay-modal" style={{ maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="clay-modal-header">
          <h3 className="clay-modal-title">Book the inspection visit</h3>
          <button className="clay-btn clay-btn-sm clay-btn-ghost" onClick={onCancel}>
            ✕
          </button>
        </div>

        {result ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className={styles.bannerOk}>
              <CheckCircle size={17} />
              <span>
                Booked for {formatDate(result.scheduledDate)} with {result.assignee.name}.
              </span>
            </div>

            <section className={styles.modalInfoBox}>
              <h4>Why this inspector</h4>
              <ul className={styles.rationale}>
                {result.rationale.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </section>

            {result.alternatives.length > 0 && (
              <section className={styles.modalInfoBox}>
                <h4>Others considered</h4>
                <ul className={styles.rationale}>
                  {result.alternatives.map((a) => (
                    <li key={a.id}>
                      {a.name} — ranking {a.score}, {a.loadOnDate} visit(s) already that day
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="clay-btn clay-btn-primary"
                onClick={() => onDone(`${task.applicationNo} is scheduled for ${formatDate(result.scheduledDate)}.`)}
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p className={styles.note}>
              Pick a date. The inspector is chosen by the department&apos;s own ranking — jurisdiction, category
              approval and current load — and the reasoning is shown to you and kept on the record.
            </p>

            <div className={styles.modalInfoBox}>
              <div>
                <strong>{task.applicationNo}</strong> — {task.instrumentId?.type}, serial {task.instrumentId?.serialNo}
              </div>
              <div>
                {task.instrumentId?.address}
                {task.instrumentId?.installationDistrict ? `, ${task.instrumentId.installationDistrict}` : ''}
              </div>
            </div>

            <div className="clay-input-group">
              <label className="clay-label">Date of visit</label>
              <input
                type="date"
                className="clay-input"
                min={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div className="clay-input-group" style={{ flex: 1 }}>
                <label className="clay-label">From</label>
                <input type="time" className="clay-input" value={slotStart} onChange={(e) => setSlotStart(e.target.value)} />
              </div>
              <div className="clay-input-group" style={{ flex: 1 }}>
                <label className="clay-label">To</label>
                <input type="time" className="clay-input" value={slotEnd} onChange={(e) => setSlotEnd(e.target.value)} />
              </div>
            </div>

            <div className="clay-input-group">
              <label className="clay-label">Note (optional)</label>
              <input
                type="text"
                className="clay-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Owner asked for a morning slot"
              />
            </div>

            {error && (
              <div className={styles.bannerBad}>
                <TriangleAlert size={16} />
                <span>{error}</span>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button className="clay-btn clay-btn-ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button className="clay-btn clay-btn-primary" onClick={submit} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 size={16} className={styles.spin} /> Booking…
                  </>
                ) : (
                  'Book and assign'
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Inspection
 * ------------------------------------------------------------------ */

function InspectionForm({
  task,
  onCancel,
  onDone,
  onError,
}: {
  task: QueueTask;
  onCancel: () => void;
  onDone: (message: string) => void;
  onError: (text: string) => void;
}) {
  const [template, setTemplate] = useState<InspectionTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [observed, setObserved] = useState<Record<number, string>>({});
  const [checks, setChecks] = useState<Record<string, 'PASS' | 'FAIL' | 'NA'>>({});
  const [standards, setStandards] = useState<{ name: string; identifier: string; validUntil: string }[]>([
    { name: '', identifier: '', validUntil: '' },
  ]);
  const [evidence, setEvidence] = useState<UploadedEvidence[]>([]);
  const [uploading, setUploading] = useState(false);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracyMetres?: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [capturingGps, setCapturingGps] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{
    inspectionNo: string;
    result: string;
    note: string;
    sealNo?: string;
    gpsDriftMetres?: number;
    outOfTolerance: string[];
    failedChecks: { code: string; label: string }[];
  } | null>(null);

  const isCorrection = Boolean(task.inspection?.isSubmitted);

  /* GPS: a refusal is reported as a refusal. The old page substituted Delhi's
   * coordinates when the device said no, which put a false location on the
   * evidence record for an inspection that may have happened anywhere. */
  const captureGps = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setGpsError('This device cannot provide a location. Record the inspection from a device that can.');
      return;
    }
    setCapturingGps(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyMetres: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : undefined,
        });
        setCapturingGps(false);
      },
      (err) => {
        setGps(null);
        setGpsError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was refused. The inspection location cannot be recorded without it.'
            : `The location could not be read (${err.message}). Move to open sky and try again.`
        );
        setCapturingGps(false);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/inspections?templateFor=${task._id}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.success) {
          setError(data.error ?? 'The test-point table could not be loaded.');
          return;
        }
        setTemplate(data);
        setChecks(
          Object.fromEntries(
            (data.conformityChecks ?? []).map((c: { code: string }) => [c.code, 'NA' as const])
          )
        );
        // Asked for as soon as we know the rule requires it, so the inspector deals
        // with the permission prompt while reading the form rather than at submit.
        if (data.requirements?.requireGpsEvidence) captureGps();
      } catch {
        if (!cancelled) setError('The test-point table could not be reached.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task._id, captureGps]);

  const uploadEvidence = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    setUploading(true);
    setError(null);

    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`${file.name} is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB and was not uploaded.`);
        continue;
      }
      const form = new FormData();
      form.set('file', file);
      form.set('documentType', 'INSPECTION_EVIDENCE');
      form.set('applicationId', task._id);
      if (task.instrumentId?._id) form.set('instrumentId', task.instrumentId._id);
      form.set('capturedAt', new Date().toISOString());
      if (gps) {
        form.set('lat', String(gps.lat));
        form.set('lng', String(gps.lng));
        if (gps.accuracyMetres != null) form.set('accuracyMetres', String(gps.accuracyMetres));
      }

      try {
        const res = await fetch('/api/documents', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data.error ?? `${file.name} could not be stored.`);
          continue;
        }
        setEvidence((prev) => [...prev, data.document]);
      } catch {
        setError(`${file.name} could not be uploaded.`);
      }
    }

    setUploading(false);
  };

  const submit = async (submitFinal: boolean) => {
    if (!template) return;

    if (submitFinal) {
      const missing = template.readings.findIndex((_, i) => !observed[i]?.trim());
      if (missing !== -1) {
        setError(`Enter what the instrument showed at ${template.readings[missing].label}.`);
        return;
      }
      if (evidence.length < template.requirements.minEvidencePhotos) {
        setError(
          `${template.requirements.minEvidencePhotos} photographs are required; ${evidence.length} attached.`
        );
        return;
      }
      if (template.requirements.requireGpsEvidence && !gps) {
        setError('This verification requires the inspection location. Capture it before submitting.');
        return;
      }
      if (isCorrection && correctionReason.trim().length < 10) {
        setError('A correction must say what was wrong with the previous report.');
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/inspections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: task._id,
          submit: submitFinal,
          readings: template.readings.map((r, i) => ({
            label: r.label,
            reference: r.reference,
            observed: observed[i]?.trim() === '' ? undefined : Number(observed[i]),
            unit: r.unit,
            maxErrorPercent: r.maxErrorPercent,
          })),
          conformityChecks: template.conformityChecks.map((c) => ({
            code: c.code,
            label: c.label,
            result: checks[c.code] ?? 'NA',
          })),
          referenceStandards: standards
            .filter((s) => s.name.trim())
            .map((s) => ({
              name: s.name.trim(),
              identifier: s.identifier.trim() || undefined,
              calibrationValidUntil: s.validUntil || undefined,
            })),
          evidenceIds: evidence.map((d) => d.id),
          location: { gps: gps ?? undefined },
          remarks: remarks.trim() || undefined,
          ...(isCorrection
            ? { supersedesId: task.inspection?._id, correctionReason: correctionReason.trim() }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? 'The report could not be filed.');
        return;
      }

      if (!submitFinal) {
        onDone(`Draft saved for ${task.applicationNo}. Submit it when the visit is complete.`);
        return;
      }

      setOutcome({
        inspectionNo: data.inspection.inspectionNo,
        result: data.inspection.result,
        note: data.evaluation.note,
        sealNo: data.inspection.sealNo,
        gpsDriftMetres: data.inspection.gpsDriftMetres,
        outOfTolerance: data.evaluation.outOfTolerance ?? [],
        failedChecks: data.evaluation.failedChecks ?? [],
      });
    } catch {
      onError('The report could not be sent. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  /* Shown live so the inspector sees the tolerance being applied as they type —
   * but the verdict that counts is the server's, computed from the same rule. */
  const errorFor = (i: number, reference: number) => {
    const value = Number(observed[i]);
    if (!observed[i]?.trim() || !Number.isFinite(value) || reference === 0) return null;
    return ((value - reference) / reference) * 100;
  };

  return (
    <div className="clay-modal-overlay">
      <div className="clay-modal" style={{ maxWidth: 760, maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="clay-modal-header">
          <div>
            <h3 className="clay-modal-title">
              {isCorrection ? 'Corrected inspection report' : 'Field inspection report'}
            </h3>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
              {task.applicationNo} · {task.instrumentId?.type}, serial {task.instrumentId?.serialNo}
            </p>
          </div>
          <button className="clay-btn clay-btn-sm clay-btn-ghost" onClick={onCancel}>
            ✕
          </button>
        </div>

        {loading ? (
          <div className={styles.loadingWrap}>
            <Loader2 size={28} className={styles.spin} />
            <p>Loading the test-point table for this instrument…</p>
          </div>
        ) : outcome ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
              className={
                outcome.result === 'PASS'
                  ? styles.bannerOk
                  : outcome.result === 'FAIL'
                    ? styles.bannerBad
                    : styles.bannerWarn
              }
            >
              {outcome.result === 'PASS' ? <CheckCircle size={18} /> : <TriangleAlert size={18} />}
              <span>
                <strong>{outcome.result}</strong> — {outcome.inspectionNo}
              </span>
            </div>

            <p className={styles.note}>{outcome.note}</p>

            <section className={styles.modalInfoBox}>
              <h4>How this was decided</h4>
              <p className={styles.note}>
                The result was computed from the rule&apos;s permissible error limits, not entered by hand.
              </p>
              {outcome.outOfTolerance.length > 0 && (
                <div>Outside tolerance: {outcome.outOfTolerance.join(', ')}</div>
              )}
              {outcome.failedChecks.length > 0 && (
                <div>Failed checks: {outcome.failedChecks.map((c) => c.label).join(', ')}</div>
              )}
              {outcome.sealNo && (
                <div>
                  Seal number <strong style={{ fontFamily: 'var(--font-mono, monospace)' }}>{outcome.sealNo}</strong>{' '}
                  — issued by the department&apos;s own sequence.
                </div>
              )}
              {outcome.gpsDriftMetres != null && (
                <div>Captured {outcome.gpsDriftMetres} m from the registered installation.</div>
              )}
            </section>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="clay-btn clay-btn-primary"
                onClick={() =>
                  onDone(
                    `${outcome.inspectionNo} filed for ${task.applicationNo}: ${outcome.result}. It is now with the deciding officer.`
                  )
                }
              >
                Done
              </button>
            </div>
          </div>
        ) : !template ? (
          <div className={styles.bannerBad}>
            <TriangleAlert size={17} />
            <span>{error ?? 'The test-point table is unavailable.'}</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <section className={styles.modalInfoBox}>
              <h4>Applied rule</h4>
              <div>
                {template.appliedRule.name} ({template.appliedRule.matchedScope})
              </div>
              <div>
                {template.requirements.minEvidencePhotos} photograph(s) required ·{' '}
                {template.requirements.requireGpsEvidence ? 'location mandatory' : 'location optional'} · drift
                tolerance {template.requirements.gpsToleranceMetres} m
              </div>
              {template.requirements.legalReference && (
                <div className={styles.note}>{template.requirements.legalReference}</div>
              )}
            </section>

            {isCorrection && (
              <div className="clay-input-group">
                <label className="clay-label">
                  What was wrong with {task.inspection?.inspectionNo}?
                </label>
                <textarea
                  className="clay-input"
                  rows={2}
                  value={correctionReason}
                  onChange={(e) => setCorrectionReason(e.target.value)}
                  placeholder="The earlier version stays on the record beside this one, with your reason."
                />
              </div>
            )}

            <section>
              <h4 style={{ fontSize: '0.9rem', marginBottom: 6 }}>Test points</h4>
              <p className={styles.note}>
                Enter what the instrument displayed at each reference load. The error and the verdict are computed —
                you do not choose pass or fail.
              </p>
              <table className={styles.readingTable}>
                <thead>
                  <tr>
                    <th>Test point</th>
                    <th>Reference</th>
                    <th>Observed</th>
                    <th>Error</th>
                    <th>Limit</th>
                  </tr>
                </thead>
                <tbody>
                  {template.readings.map((r, i) => {
                    const err = errorFor(i, r.reference);
                    const over = err !== null && Math.abs(err) > r.maxErrorPercent;
                    return (
                      <tr key={r.label} className={over ? styles.rowFail : undefined}>
                        <td>{r.label}</td>
                        <td>
                          {r.reference} {r.unit}
                        </td>
                        <td>
                          <input
                            type="number"
                            step="any"
                            className={`clay-input ${styles.readingInput}`}
                            value={observed[i] ?? ''}
                            onChange={(e) => setObserved((prev) => ({ ...prev, [i]: e.target.value }))}
                            placeholder="—"
                            aria-label={`Observed value at ${r.label}`}
                          />
                        </td>
                        <td>{err === null ? '—' : `${err.toFixed(3)}%`}</td>
                        <td>±{r.maxErrorPercent}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section>
              <h4 style={{ fontSize: '0.9rem', marginBottom: 6 }}>Conformity checks</h4>
              {template.conformityChecks.map((c) => (
                <div key={c.code} className={styles.checkRow}>
                  <span>{c.label}</span>
                  <div className={styles.checkButtons}>
                    {(['PASS', 'FAIL', 'NA'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        className={`clay-btn clay-btn-sm ${
                          checks[c.code] === v ? (v === 'FAIL' ? 'clay-btn-secondary' : 'clay-btn-primary') : 'clay-btn-ghost'
                        }`}
                        onClick={() => setChecks((prev) => ({ ...prev, [c.code]: v }))}
                      >
                        {v === 'NA' ? 'N/A' : v}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>

            <section className={styles.modalInfoBox}>
              <h4>
                <Crosshair size={15} /> Inspection location
              </h4>
              {gps ? (
                <div style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                  {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
                  {gps.accuracyMetres != null ? ` (±${gps.accuracyMetres} m)` : ''}
                </div>
              ) : (
                <div className={styles.note}>{gpsError ?? 'Not captured yet.'}</div>
              )}
              {template.instrument.registeredGps && (
                <div className={styles.note}>
                  Registered site: {template.instrument.registeredGps.lat.toFixed(6)},{' '}
                  {template.instrument.registeredGps.lng.toFixed(6)}. Any difference is measured and recorded, not
                  judged — a relocated instrument is a transfer to file, not a failure.
                </div>
              )}
              <button
                type="button"
                className="clay-btn clay-btn-ghost clay-btn-sm"
                onClick={captureGps}
                disabled={capturingGps}
                style={{ alignSelf: 'flex-start', marginTop: 6 }}
              >
                {capturingGps ? (
                  <>
                    <Loader2 size={14} className={styles.spin} /> Reading location…
                  </>
                ) : (
                  <>
                    <Crosshair size={14} /> {gps ? 'Re-capture' : 'Capture location'}
                  </>
                )}
              </button>
            </section>

            <section>
              <h4 style={{ fontSize: '0.9rem', marginBottom: 6 }}>
                Evidence photographs ({evidence.length}/{template.requirements.minEvidencePhotos} required)
              </h4>
              <p className={styles.note}>
                Each file is stored with a SHA-256 fingerprint, so it can be shown later to be the same image.
              </p>
              <label className="clay-btn clay-btn-secondary clay-btn-sm" style={{ cursor: 'pointer' }}>
                {uploading ? <Loader2 size={16} className={styles.spin} /> : <Camera size={16} />}
                {uploading ? 'Uploading…' : 'Add photographs'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  multiple
                  onChange={uploadEvidence}
                  style={{ display: 'none' }}
                  disabled={uploading}
                />
              </label>

              {evidence.length > 0 && (
                <ul className={styles.evidenceList}>
                  {evidence.map((d) => (
                    <li key={d.id}>
                      <Paperclip size={13} />
                      <a href={d.href} target="_blank" rel="noreferrer">
                        {d.fileName}
                      </a>
                      <code>{d.sha256.slice(0, 10)}…</code>
                      <button
                        type="button"
                        onClick={() => setEvidence((prev) => prev.filter((x) => x.id !== d.id))}
                        aria-label={`Remove ${d.fileName} from this report`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h4 style={{ fontSize: '0.9rem', marginBottom: 6 }}>Reference standards used</h4>
              {standards.map((s, i) => (
                <div key={i} className={styles.standardRow}>
                  <input
                    className="clay-input"
                    placeholder="e.g. F1 class 20 kg test weight"
                    value={s.name}
                    onChange={(e) =>
                      setStandards((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                    }
                  />
                  <input
                    className="clay-input"
                    placeholder="Identifier"
                    value={s.identifier}
                    onChange={(e) =>
                      setStandards((prev) => prev.map((x, j) => (j === i ? { ...x, identifier: e.target.value } : x)))
                    }
                  />
                  <input
                    type="date"
                    className="clay-input"
                    value={s.validUntil}
                    onChange={(e) =>
                      setStandards((prev) => prev.map((x, j) => (j === i ? { ...x, validUntil: e.target.value } : x)))
                    }
                  />
                </div>
              ))}
              <button
                type="button"
                className="clay-btn clay-btn-ghost clay-btn-sm"
                onClick={() => setStandards((prev) => [...prev, { name: '', identifier: '', validUntil: '' }])}
              >
                Add another standard
              </button>
            </section>

            <div className="clay-input-group">
              <label className="clay-label">Remarks</label>
              <textarea
                className="clay-input"
                rows={2}
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Anything an officer reading this report later would need to know."
              />
            </div>

            {error && (
              <div className={styles.bannerBad}>
                <TriangleAlert size={16} />
                <span>{error}</span>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <button className="clay-btn clay-btn-ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              {!isCorrection && (
                <button className="clay-btn clay-btn-secondary" onClick={() => void submit(false)} disabled={busy}>
                  Save draft
                </button>
              )}
              <button className="clay-btn clay-btn-primary" onClick={() => void submit(true)} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 size={16} className={styles.spin} /> Filing…
                  </>
                ) : (
                  'File the report'
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Certificate issued
 * ------------------------------------------------------------------ */

/**
 * Shown after issuance. It reports what the server actually created and links to
 * the certificate register — it does not render a certificate document, because a
 * printable certificate assembled in a browser from whatever the page happens to
 * hold is how the fabricated `LMO-CERT-…` forgeries got printed in the first
 * place. The QR is the server's own, generated locally by `qrcode`.
 */
function CertificateIssued({
  certificate,
  onClose,
}: {
  certificate: IssuedCertificate;
  onClose: () => void;
}) {
  return (
    <div className="clay-modal-overlay">
      <div className="clay-modal" style={{ maxWidth: 480 }}>
        <div className="clay-modal-header">
          <h3 className="clay-modal-title">Certificate issued</h3>
          <button className="clay-btn clay-btn-sm clay-btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', textAlign: 'center' }}>
          <Award size={38} style={{ color: 'var(--color-primary)' }} />
          <div>
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '1.15rem', fontWeight: 800 }}>
              {certificate.certNo}
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Valid until {formatDate(certificate.expiryDate)}
            </div>
          </div>

          {/* eslint-disable-next-line @next/next/no-img-element -- a server-generated data URL, not a remote asset */}
          <img
            src={certificate.qrDataUrl}
            alt={`QR code linking to the public verification page for ${certificate.certNo}`}
            width={180}
            height={180}
            style={{ borderRadius: 'var(--radius-md)' }}
          />
          <p className={styles.note}>
            Anyone can scan this to check the certificate against the register — no account needed.
          </p>

          <div style={{ display: 'flex', gap: 10 }}>
            <Link href={`/verify/${encodeURIComponent(certificate.certNo)}`} className="clay-btn clay-btn-ghost clay-btn-sm">
              Open the public page
            </Link>
            <Link href="/dashboard/certificates" className="clay-btn clay-btn-primary clay-btn-sm">
              Certificate register
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
