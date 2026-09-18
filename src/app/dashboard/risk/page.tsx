'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ShieldAlert,
  Loader2,
  AlertTriangle,
  X,
  Info,
  ChevronRight,
  MapPin,
  Scale,
  FileText,
  Award,
  Check,
  Eye,
  Gavel,
  CircleSlash,
  Clock,
} from 'lucide-react';
import {
  RISK_FLAG_TYPE_LABELS,
  RISK_FLAG_TYPE_DESCRIPTIONS,
  RISK_FLAG_STATUS_LABELS,
  RISK_LEVEL_LABELS,
  riskFlagStatusBadgeClass,
  riskLevelBadgeClass,
  formatDate,
  formatDateTime,
  instrumentStatusLabel,
  statusBadgeClass,
  type RiskFlagType,
  type RiskFlagStatus,
  type RiskLevel,
} from '@/lib/constants';
import styles from './risk.module.css';

/**
 * Risk flag triage.
 *
 * The detectors in `src/lib/risk.ts` have been running on the nightly sweep and
 * writing flags that nothing could display. A detector whose output is never read
 * is worse than no detector at all, because the system looks like it is watching
 * for fraud and is not.
 *
 * Three things this screen is careful about, all of them because the spec insists
 * risk scoring is decision *support*:
 *
 *  - **The reasons come before the score.** A flag's `reasons` array is rendered on
 *    the row itself, not hidden behind the detail view, because an officer should
 *    be acting on "these two instruments share serial 4471" and not on "87". The
 *    score only sets the order of the queue.
 *  - **Nothing resolves without a written reason.** The API refuses a dismissal or
 *    a confirmation with a note under ten characters, so the form says so up front
 *    rather than letting an officer type nothing and be rejected afterwards.
 *  - **Confirming records a finding; it does not punish anybody.** The API is
 *    explicit that suspension, revocation and prosecution are separate deliberate
 *    acts, so the confirm panel offers a link to open an enforcement case and
 *    stops there.
 */

interface FlagInstrument {
  id: string;
  serialNo: string;
  type: string;
  brand?: string;
  model?: string;
  state?: string;
  district?: string;
}

interface Flag {
  id: string;
  flagType: string;
  level: string;
  score: number;
  title: string;
  reasons: string[];
  recommendedAction: string;
  evidence?: Record<string, unknown>;
  status: string;
  instrument: FlagInstrument | null;
  applicationId?: string;
  certificateId?: string;
  ownerId?: string;
  reviewedAt?: string;
  reviewNote?: string;
  detectedAt: string;
  ageDays: number;
}

interface Summary {
  openTotal: number;
  byLevel: Record<string, number>;
  byType: { flagType: string; count: number }[];
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

/* The detail view's extra records. Every one is optional — a flag targets
   whichever records its detector had to hand. */
interface DetailSubject {
  instrument?: {
    _id: string;
    serialNo: string;
    type: string;
    brand?: string;
    model?: string;
    capacity?: string;
    accuracyClass?: string;
    status: string;
    installationState?: string;
    installationDistrict?: string;
    address?: string;
    lastVerifiedDate?: string;
    nextVerificationDue?: string;
    verificationCount?: number;
  } | null;
  application?: {
    _id: string;
    applicationNo: string;
    type: string;
    status: string;
    submittedDate?: string;
    dueDate?: string;
    feeStatus?: string;
  } | null;
  certificate?: {
    _id: string;
    certNo: string;
    status: string;
    issuedDate?: string;
    expiryDate?: string;
    version?: number;
  } | null;
  owner?: {
    name?: string;
    email?: string;
    phone?: string;
    organizationName?: string;
    state?: string;
    district?: string;
  } | null;
}

interface RelatedFlag {
  id: string;
  flagType: string;
  level: string;
  score: number;
  title: string;
  status: string;
  detectedAt: string;
}

interface Detail {
  flag: Flag & {
    dedupeKey?: string;
    review: {
      at: string;
      note?: string;
      by?: { name?: string; designation?: string; officerCode?: string; role?: string };
    } | null;
  };
  subject: DetailSubject;
  relatedFlags: RelatedFlag[];
  resolutions: string[];
}

const STATUS_TABS: { value: string; label: string }[] = [
  { value: 'open', label: 'Needs triage' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'Everything' },
];

const LEVELS: RiskLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function flagTypeLabel(t: string): string {
  return RISK_FLAG_TYPE_LABELS[t as RiskFlagType] ?? t;
}

/**
 * Renders the detector's machine-readable evidence.
 *
 * `evidence` is `Schema.Types.Mixed`, so its keys differ per detector and cannot be
 * enumerated ahead of time. Showing it raw is still worth doing: the serial numbers,
 * distances and reading values in there are what an officer checks the claim
 * against, and hiding them would leave only the detector's word for it.
 */
function EvidenceValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className={styles.notSet}>—</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number' || typeof value === 'string') return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    return (
      <span>
        {value.length === 0 ? (
          <span className={styles.notSet}>none</span>
        ) : (
          value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')
        )}
      </span>
    );
  }
  return <code className={styles.evidenceCode}>{JSON.stringify(value)}</code>;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

export default function RiskPage() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [status, setStatus] = useState('open');
  const [level, setLevel] = useState('all');
  const [flagType, setFlagType] = useState('all');
  const [page, setPage] = useState(1);

  const [openId, setOpenId] = useState<string | null>(null);

  const fetchFlags = useCallback(async () => {
    const params = new URLSearchParams({ status, page: String(page), limit: '25' });
    if (level !== 'all') params.set('level', level);
    if (flagType !== 'all') params.set('flagType', flagType);

    try {
      const res = await fetch(`/api/risk?${params.toString()}`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        flags?: Flag[];
        summary?: Summary;
        pagination?: Pagination;
      };
      if (!data.success) {
        setError(data.error || 'Risk flags could not be loaded.');
        return;
      }
      setForbidden(false);
      setError(null);
      setFlags(data.flags ?? []);
      setSummary(data.summary ?? null);
      setPagination(data.pagination ?? null);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [status, level, flagType, page]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchFlags();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchFlags]);

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading risk flags…</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className={styles.gate}>
        <ShieldAlert size={44} style={{ color: 'var(--color-secondary)' }} />
        <h2>Risk flags are an internal working queue</h2>
        <p>
          A flag is an unproven suspicion raised by an automated check. Showing one to a
          business before an officer has looked at it would be an accusation the department
          has not made — so this queue is limited to Legal Metrology staff.
        </p>
        <p>
          If you have a concern about an instrument, report it and an officer will
          investigate.
        </p>
        <div className={styles.gateActions}>
          <Link href="/dashboard" className="clay-btn clay-btn-outline">
            Back to dashboard
          </Link>
          <Link href="/verify" className="clay-btn clay-btn-primary">
            Verify a certificate
          </Link>
        </div>
      </div>
    );
  }

  const openByLevel = summary?.byLevel ?? {};

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Risk &amp; Anomalies</h1>
          <p>
            Automated checks run nightly across the register and raise a flag when
            something does not add up. Every flag carries the reasons that produced it, and
            every flag waits for an officer — nothing here rejects an application, suspends
            a certificate, or contacts a business on its own.
          </p>
        </div>
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
          <Info size={18} />
          <span>{notice}</span>
          <button type="button" className={styles.boxDismiss} onClick={() => setNotice(null)}>
            <X size={15} />
          </button>
        </div>
      )}

      {/*
        * Counts are of what is still open, across the officer's whole jurisdiction —
        * not of the page on screen. A queue metric that changes when you turn the
        * page is not a metric.
        */}
      <div className={styles.metricsGrid}>
        <button
          type="button"
          className={`${styles.metricCard} ${level === 'all' ? styles.metricActive : ''}`}
          onClick={() => {
            setLevel('all');
            setStatus('open');
            setPage(1);
          }}
        >
          <span className={styles.metricLabel}>Awaiting an officer</span>
          <span className={styles.metricVal}>{summary?.openTotal ?? 0}</span>
          <span className={styles.metricSub}>across your jurisdiction</span>
        </button>
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            className={`${styles.metricCard} ${level === l ? styles.metricActive : ''} ${
              styles[`metric${l}`] ?? ''
            }`}
            onClick={() => {
              setLevel(level === l ? 'all' : l);
              setPage(1);
            }}
          >
            <span className={styles.metricLabel}>{RISK_LEVEL_LABELS[l]}</span>
            <span className={styles.metricVal}>{openByLevel[l] ?? 0}</span>
            <span className={styles.metricSub}>
              {(openByLevel[l] ?? 0) === 0 ? 'nothing open' : 'open'}
            </span>
          </button>
        ))}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.tabs}>
          {STATUS_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`${styles.tab} ${status === t.value ? styles.tabActive : ''}`}
              onClick={() => {
                setStatus(t.value);
                setPage(1);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          className="clay-select"
          value={flagType}
          onChange={(e) => {
            setFlagType(e.target.value);
            setPage(1);
          }}
          aria-label="Filter by what was detected"
        >
          <option value="all">Everything detected</option>
          {/*
            * Only the types that actually have open flags, with their counts. Listing
            * all nine when six have never fired reads as a menu of things to look for
            * rather than a description of the queue.
            */}
          {(summary?.byType ?? []).map((t) => (
            <option key={t.flagType} value={t.flagType}>
              {flagTypeLabel(t.flagType)} ({t.count})
            </option>
          ))}
          {flagType !== 'all' && !(summary?.byType ?? []).some((t) => t.flagType === flagType) && (
            <option value={flagType}>{flagTypeLabel(flagType)} (0)</option>
          )}
        </select>
      </div>

      {flagType !== 'all' && (
        <p className={styles.typeNote}>
          <Info size={15} />
          {RISK_FLAG_TYPE_DESCRIPTIONS[flagType as RiskFlagType] ?? flagTypeLabel(flagType)}
        </p>
      )}

      {flags.length === 0 ? (
        <div className={styles.emptyState}>
          <Check size={44} style={{ color: 'var(--status-success)' }} />
          <h3>
            {status === 'open'
              ? 'Nothing is waiting on you'
              : 'No flags match these filters'}
          </h3>
          <p>
            {status === 'open'
              ? 'No open risk flags in your jurisdiction. The detectors run nightly, so this will fill again if something changes.'
              : 'Try a different status or clear the category filter.'}
          </p>
        </div>
      ) : (
        <div className={styles.flagList}>
          {flags.map((flag) => (
            <article key={flag.id} className={styles.flagCard}>
              <div className={styles.flagTop}>
                <div className={styles.flagHead}>
                  <span className={`clay-badge ${riskLevelBadgeClass(flag.level)}`}>
                    {RISK_LEVEL_LABELS[flag.level as RiskLevel] ?? flag.level}
                  </span>
                  <span className={styles.flagType}>{flagTypeLabel(flag.flagType)}</span>
                  <span className={`clay-badge ${riskFlagStatusBadgeClass(flag.status)}`}>
                    {RISK_FLAG_STATUS_LABELS[flag.status as RiskFlagStatus] ?? flag.status}
                  </span>
                </div>
                {/*
                  * The score is deliberately small and grey. It exists to order the
                  * queue; it is not the finding, and an officer who acts on the number
                  * instead of the reasons is doing the thing the spec forbids.
                  */}
                <span className={styles.score} title="Priority score — sets queue order only">
                  {flag.score}
                </span>
              </div>

              <h3>{flag.title}</h3>

              {flag.reasons.length > 0 && (
                <ul className={styles.reasons}>
                  {flag.reasons.map((r, i) => (
                    <li key={`${flag.id}-r${i}`}>{r}</li>
                  ))}
                </ul>
              )}

              <div className={styles.flagMeta}>
                {flag.instrument && (
                  <span className={styles.metaItem}>
                    <Scale size={14} />
                    {flag.instrument.serialNo} · {flag.instrument.type}
                  </span>
                )}
                {flag.instrument?.district && (
                  <span className={styles.metaItem}>
                    <MapPin size={14} />
                    {[flag.instrument.district, flag.instrument.state].filter(Boolean).join(', ')}
                  </span>
                )}
                <span className={styles.metaItem}>
                  <Clock size={14} />
                  Detected {formatDate(flag.detectedAt)}
                  {flag.ageDays > 0 && ` · ${flag.ageDays}d ago`}
                </span>
              </div>

              {flag.recommendedAction && (
                <p className={styles.recommended}>
                  <strong>Recommended:</strong> {flag.recommendedAction}
                </p>
              )}

              {flag.reviewNote && (
                <p className={styles.resolvedNote}>
                  <strong>
                    {flag.status === 'CONFIRMED' ? 'Finding' : 'Dismissed'}
                    {flag.reviewedAt ? ` ${formatDate(flag.reviewedAt)}` : ''}:
                  </strong>{' '}
                  {flag.reviewNote}
                </p>
              )}

              <div className={styles.flagActions}>
                <button
                  type="button"
                  className="clay-btn clay-btn-sm clay-btn-outline"
                  onClick={() => setOpenId(flag.id)}
                >
                  Open the case
                  <ChevronRight size={15} />
                </button>
                {flag.instrument && (
                  <Link
                    href={`/dashboard/instruments/${flag.instrument.id}`}
                    className={styles.plainLink}
                  >
                    View the instrument
                  </Link>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {pagination && pagination.pages > 1 && (
        <div className={styles.pager}>
          <button
            type="button"
            className="clay-btn clay-btn-sm clay-btn-outline"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </button>
          <span className={styles.pagerInfo}>
            Page {pagination.page} of {pagination.pages} · {pagination.total} flag
            {pagination.total === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            className="clay-btn clay-btn-sm clay-btn-outline"
            onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
            disabled={page >= pagination.pages}
          >
            Next
          </button>
        </div>
      )}

      <p className={styles.footNote}>
        Risk flags are advisory. They order attention and never decide an application. A
        confirmed flag records a finding; suspending a certificate or pursuing a penalty is a
        separate, deliberate step taken through an enforcement case.
      </p>

      {openId && (
        <FlagDrawer
          flagId={openId}
          onClose={() => setOpenId(null)}
          onResolved={(message) => {
            setOpenId(null);
            setNotice(message);
            void fetchFlags();
          }}
        />
      )}
    </div>
  );
}

/* ── Detail drawer ──────────────────────────────────────────────────────── */

function FlagDrawer({
  flagId,
  onClose,
  onResolved,
}: {
  flagId: string;
  onClose: () => void;
  onResolved: (message: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [resolution, setResolution] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  /* Set after a confirmation, so the enforcement hand-off is offered exactly once
     and only when the API said so via `nextStep`. */
  const [confirmedId, setConfirmedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/risk/${flagId}`);
      const data = (await res.json()) as { success: boolean; error?: string } & Partial<Detail>;
      if (!data.success || !data.flag) {
        setError(data.error || 'This flag could not be loaded.');
        return;
      }
      setDetail({
        flag: data.flag,
        subject: data.subject ?? {},
        relatedFlags: data.relatedFlags ?? [],
        resolutions: data.resolutions ?? [],
      });
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [flagId]);

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

  async function submit(next: string) {
    // Mirrors the server's own floor. It refuses under ten characters, so telling
    // the officer here beats a round trip that reads like a bug.
    if (next !== 'REVIEWING' && note.trim().length < 10) {
      setError(
        next === 'DISMISSED'
          ? 'Say why this is not a concern, in at least a few words. A dismissal with no reason cannot be reviewed later.'
          : 'Record what you found, in at least a few words. A confirmed finding has to stand on its own in an enforcement case.'
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/risk/${flagId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next, note: note.trim() }),
      });
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        message?: string;
        nextStep?: string | null;
      };
      if (!data.success) {
        setError(data.error || 'The flag could not be updated.');
        return;
      }
      if (data.nextStep === 'enforcement') {
        // Stay open: the officer has a decision to make about a case, and closing
        // the drawer would bury the offer.
        setConfirmedId(flagId);
        await load();
        return;
      }
      onResolved(data.message ?? 'Flag updated.');
    } catch {
      setError('Could not reach the server. Nothing was saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="clay-modal-overlay" onClick={onClose}>
      <div
        className={`clay-modal ${styles.drawer}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {loading ? (
          <div className={styles.drawerLoading}>
            <Loader2 size={30} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
            <p>Loading the case…</p>
          </div>
        ) : !detail ? (
          <>
            <div className={styles.modalHeader}>
              <h3>Flag unavailable</h3>
              <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className={styles.errorBox}>
              <AlertTriangle size={17} />
              <span>{error ?? 'This flag could not be loaded.'}</span>
            </div>
          </>
        ) : (
          <>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.flagHead}>
                  <span className={`clay-badge ${riskLevelBadgeClass(detail.flag.level)}`}>
                    {RISK_LEVEL_LABELS[detail.flag.level as RiskLevel] ?? detail.flag.level}
                  </span>
                  <span className={`clay-badge ${riskFlagStatusBadgeClass(detail.flag.status)}`}>
                    {RISK_FLAG_STATUS_LABELS[detail.flag.status as RiskFlagStatus] ??
                      detail.flag.status}
                  </span>
                </div>
                <h3>{detail.flag.title}</h3>
                <p>
                  {flagTypeLabel(detail.flag.flagType)} · detected{' '}
                  {formatDateTime(detail.flag.detectedAt)}
                </p>
              </div>
              <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <p className={styles.detectorNote}>
              {RISK_FLAG_TYPE_DESCRIPTIONS[detail.flag.flagType as RiskFlagType] ??
                'A check on the register raised this flag.'}
            </p>

            {error && (
              <div className={styles.errorBox}>
                <AlertTriangle size={17} />
                <span>{error}</span>
              </div>
            )}

            <h4 className={styles.sectionTitle}>Why this was flagged</h4>
            {detail.flag.reasons.length === 0 ? (
              <p className={styles.notSet}>
                No reasons were recorded, which makes this flag unusable — dismiss it and
                report the detector.
              </p>
            ) : (
              <ul className={styles.reasons}>
                {detail.flag.reasons.map((r, i) => (
                  <li key={`dr${i}`}>{r}</li>
                ))}
              </ul>
            )}

            {detail.flag.recommendedAction && (
              <p className={styles.recommended}>
                <strong>Recommended:</strong> {detail.flag.recommendedAction}
              </p>
            )}

            {detail.flag.evidence && Object.keys(detail.flag.evidence).length > 0 && (
              <>
                <h4 className={styles.sectionTitle}>What the detector measured</h4>
                <dl className={styles.evidenceList}>
                  {Object.entries(detail.flag.evidence).map(([k, v]) => (
                    <div key={k} className={styles.evidenceRow}>
                      <dt>{humanizeKey(k)}</dt>
                      <dd>
                        <EvidenceValue value={v} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}

            <h4 className={styles.sectionTitle}>The records this concerns</h4>
            <div className={styles.subjectGrid}>
              {detail.subject.instrument ? (
                <Link
                  href={`/dashboard/instruments/${detail.subject.instrument._id}`}
                  className={styles.subjectCard}
                >
                  <span className={styles.subjectHead}>
                    <Scale size={15} />
                    Instrument
                  </span>
                  <strong>{detail.subject.instrument.serialNo}</strong>
                  <span className={styles.subjectSub}>
                    {detail.subject.instrument.type}
                    {detail.subject.instrument.brand
                      ? ` · ${detail.subject.instrument.brand}`
                      : ''}
                  </span>
                  <span className={`clay-badge ${statusBadgeClass(detail.subject.instrument.status)}`}>
                    {instrumentStatusLabel(detail.subject.instrument.status)}
                  </span>
                  <span className={styles.subjectSub}>
                    {[
                      detail.subject.instrument.installationDistrict,
                      detail.subject.instrument.installationState,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </span>
                  {detail.subject.instrument.nextVerificationDue && (
                    <span className={styles.subjectSub}>
                      Next due {formatDate(detail.subject.instrument.nextVerificationDue)}
                    </span>
                  )}
                </Link>
              ) : null}

              {detail.subject.application ? (
                <Link
                  href={`/dashboard/applications/${detail.subject.application._id}`}
                  className={styles.subjectCard}
                >
                  <span className={styles.subjectHead}>
                    <FileText size={15} />
                    Application
                  </span>
                  <strong>{detail.subject.application.applicationNo}</strong>
                  <span className={styles.subjectSub}>{detail.subject.application.type}</span>
                  <span className={`clay-badge ${statusBadgeClass(detail.subject.application.status)}`}>
                    {detail.subject.application.status}
                  </span>
                  {detail.subject.application.submittedDate && (
                    <span className={styles.subjectSub}>
                      Submitted {formatDate(detail.subject.application.submittedDate)}
                    </span>
                  )}
                </Link>
              ) : null}

              {detail.subject.certificate ? (
                <div className={styles.subjectCard}>
                  <span className={styles.subjectHead}>
                    <Award size={15} />
                    Certificate
                  </span>
                  <strong>{detail.subject.certificate.certNo}</strong>
                  <span className={`clay-badge ${statusBadgeClass(detail.subject.certificate.status)}`}>
                    {detail.subject.certificate.status}
                  </span>
                  {detail.subject.certificate.expiryDate && (
                    <span className={styles.subjectSub}>
                      Expires {formatDate(detail.subject.certificate.expiryDate)}
                    </span>
                  )}
                </div>
              ) : null}

              {detail.subject.owner ? (
                <div className={styles.subjectCard}>
                  <span className={styles.subjectHead}>Business</span>
                  <strong>
                    {detail.subject.owner.organizationName || detail.subject.owner.name}
                  </strong>
                  {detail.subject.owner.organizationName && detail.subject.owner.name && (
                    <span className={styles.subjectSub}>{detail.subject.owner.name}</span>
                  )}
                  {detail.subject.owner.phone && (
                    <span className={styles.subjectSub}>{detail.subject.owner.phone}</span>
                  )}
                  <span className={styles.subjectSub}>
                    {[detail.subject.owner.district, detail.subject.owner.state]
                      .filter(Boolean)
                      .join(', ')}
                  </span>
                </div>
              ) : null}
            </div>

            {/*
              * Other live flags on the same instrument. One borderline reading is
              * noise; three findings on one instrument is a pattern, and that
              * distinction is the officer's to draw.
              */}
            {detail.relatedFlags.length > 0 && (
              <>
                <h4 className={styles.sectionTitle}>
                  Other flags on this instrument ({detail.relatedFlags.length})
                </h4>
                <ul className={styles.relatedList}>
                  {detail.relatedFlags.map((r) => (
                    <li key={r.id}>
                      <span className={`clay-badge ${riskLevelBadgeClass(r.level)}`}>
                        {RISK_LEVEL_LABELS[r.level as RiskLevel] ?? r.level}
                      </span>
                      <span className={styles.relatedTitle}>{r.title}</span>
                      <span className={styles.relatedMeta}>
                        {RISK_FLAG_STATUS_LABELS[r.status as RiskFlagStatus] ?? r.status} ·{' '}
                        {formatDate(r.detectedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {detail.flag.review && (
              <>
                <h4 className={styles.sectionTitle}>Officer decision</h4>
                <div className={styles.reviewBox}>
                  <p>
                    <strong>
                      {RISK_FLAG_STATUS_LABELS[detail.flag.status as RiskFlagStatus] ??
                        detail.flag.status}
                    </strong>{' '}
                    on {formatDateTime(detail.flag.review.at)}
                    {detail.flag.review.by?.name && (
                      <>
                        {' '}
                        by {detail.flag.review.by.name}
                        {detail.flag.review.by.officerCode
                          ? ` (${detail.flag.review.by.officerCode})`
                          : ''}
                      </>
                    )}
                  </p>
                  {detail.flag.review.note && <p>{detail.flag.review.note}</p>}
                </div>
              </>
            )}

            {/* ── The hand-off after a confirmation ── */}
            {confirmedId ? (
              <div className={styles.handoff}>
                <Gavel size={20} />
                <div>
                  <strong>Finding recorded.</strong>
                  <p>
                    This does not suspend the certificate or penalise the business. If action
                    against the business is warranted, open an enforcement case — the
                    finding and its reasons are carried across.
                  </p>
                </div>
                <div className={styles.handoffActions}>
                  <Link
                    href={`/dashboard/enforcement/new?riskFlagId=${confirmedId}`}
                    className="clay-btn clay-btn-primary clay-btn-sm"
                  >
                    Open an enforcement case
                  </Link>
                  <button
                    type="button"
                    className="clay-btn clay-btn-outline clay-btn-sm"
                    onClick={() => onResolved('Finding recorded on the risk flag.')}
                  >
                    Not yet
                  </button>
                </div>
              </div>
            ) : detail.flag.status === 'DISMISSED' || detail.flag.status === 'CONFIRMED' ? (
              <p className={styles.footNote}>
                This flag has been resolved and cannot be reopened. If new information has come
                to light, raise an enforcement case rather than reworking the flag.
              </p>
            ) : (
              <>
                <h4 className={styles.sectionTitle}>Your decision</h4>
                <div className={styles.resolutionRow}>
                  {detail.flag.status !== 'REVIEWING' && (
                    <button
                      type="button"
                      className={`${styles.resolutionBtn} ${
                        resolution === 'REVIEWING' ? styles.resolutionActive : ''
                      }`}
                      onClick={() => setResolution('REVIEWING')}
                    >
                      <Eye size={17} />
                      <span>
                        <strong>I&apos;m looking into it</strong>
                        <em>Claims the flag so a colleague does not duplicate the work.</em>
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles.resolutionBtn} ${
                      resolution === 'DISMISSED' ? styles.resolutionActive : ''
                    }`}
                    onClick={() => setResolution('DISMISSED')}
                  >
                    <CircleSlash size={17} />
                    <span>
                      <strong>Not a concern</strong>
                      <em>The detector was right about the data and wrong about the meaning.</em>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.resolutionBtn} ${
                      resolution === 'CONFIRMED' ? styles.resolutionActive : ''
                    }`}
                    onClick={() => setResolution('CONFIRMED')}
                  >
                    <AlertTriangle size={17} />
                    <span>
                      <strong>Confirmed</strong>
                      <em>Records the finding. Enforcement is a separate step.</em>
                    </span>
                  </button>
                </div>

                {resolution && (
                  <div className={styles.noteField}>
                    <label className="clay-label" htmlFor="risk-note">
                      {resolution === 'REVIEWING'
                        ? 'Note (optional)'
                        : resolution === 'DISMISSED'
                          ? 'Why is this not a concern?'
                          : 'What did you find?'}
                    </label>
                    <textarea
                      id="risk-note"
                      className="clay-input"
                      rows={3}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder={
                        resolution === 'REVIEWING'
                          ? 'Optional — anything a colleague should know.'
                          : resolution === 'DISMISSED'
                            ? 'e.g. Both records are the same weighbridge; the duplicate was a data-entry error corrected on 14 August.'
                            : 'e.g. Seal on the dispenser is cut and the serial plate has been over-stamped. Photographs taken; instrument taken out of use.'
                      }
                    />
                    <p className={styles.hint}>
                      {resolution === 'REVIEWING'
                        ? 'The flag stays open. It moves out of the untouched pile so two officers do not work it at once.'
                        : 'Recorded against the flag and in the audit trail, permanently. A resolution cannot be undone.'}
                    </p>
                    <div className={styles.modalActions}>
                      <button
                        type="button"
                        className="clay-btn clay-btn-outline"
                        onClick={() => {
                          setResolution(null);
                          setNote('');
                          setError(null);
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="clay-btn clay-btn-primary"
                        disabled={saving}
                        onClick={() => void submit(resolution)}
                      >
                        {saving ? (
                          <>
                            <Loader2 size={16} className={styles.spin} />
                            Recording…
                          </>
                        ) : resolution === 'REVIEWING' ? (
                          'Mark as under review'
                        ) : resolution === 'DISMISSED' ? (
                          'Dismiss the flag'
                        ) : (
                          'Record the finding'
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
