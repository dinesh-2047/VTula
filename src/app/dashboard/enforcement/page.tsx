'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Gavel,
  Loader2,
  AlertTriangle,
  X,
  Plus,
  Scale,
  MapPin,
  Clock,
  UserX,
  ChevronRight,
  Megaphone,
  Search,
  ShieldAlert,
} from 'lucide-react';
import {
  ENFORCEMENT_CASE_STATUSES,
  ENFORCEMENT_CASE_STATUS_LABELS,
  ENFORCEMENT_CASE_TYPE_LABELS,
  ENFORCEMENT_SEVERITIES,
  enforcementStatusBadgeClass,
  riskLevelBadgeClass,
  formatDate,
  formatInr,
  type EnforcementCaseStatus,
  type EnforcementCaseType,
} from '@/lib/constants';
import styles from './enforcement.module.css';

/**
 * The enforcement register.
 *
 * The half of the problem statement that had no interface at all. The model and both
 * API routes existed, so the system could detect a cloned seal and had nowhere to
 * record what was done about it — and the public complaint path, which is where the
 * spec's QR story ends, wrote cases into a collection nothing displayed.
 *
 * The queue is ordered by severity and then by age, matching the API, because a HIGH
 * case must not sit behind a pile of newer LOW ones. Two things are surfaced on the
 * register rather than left to the detail view:
 *
 *  - **Unassigned cases.** Only public complaints arrive unassigned — an officer who
 *    opens a case owns it — so an unassigned pile is exactly the set of reports from
 *    members of the public that nobody has picked up. That is the one queue in this
 *    product where the delay is felt by someone outside the department.
 *  - **Age in days.** A case at NOTICE_ISSUED for ninety days is a different problem
 *    from one opened this morning, and the status alone does not say which is which.
 */

interface CaseRow {
  id: string;
  caseNo: string;
  caseType: string;
  status: string;
  severity: string;
  title: string;
  origin: string;
  jurisdiction?: { state?: string; district?: string };
  assignedTo?: { _id: string; name?: string; officerCode?: string; designation?: string } | null;
  instrumentId?: {
    _id: string;
    serialNo?: string;
    type?: string;
    brand?: string;
    installationDistrict?: string;
  } | null;
  penalty?: { amount?: number; paidAt?: string; reference?: string };
  outcome?: string;
  actionCount: number;
  lastAction?: { action: string; note?: string; at: string };
  complainant?: { isAnonymous: boolean; hasContact: boolean };
  ageDays: number;
  createdAt: string;
  closedAt?: string;
}

interface Summary {
  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
  unassigned: number;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

const TABS = [
  { value: 'open', label: 'Open cases' },
  { value: 'closed', label: 'Concluded' },
  { value: 'all', label: 'Everything' },
];

/** Statuses that mean the case is still live, in process order. */
const LIVE_STATUSES: EnforcementCaseStatus[] = [
  'OPEN',
  'INVESTIGATING',
  'NOTICE_ISSUED',
  'HEARING',
  'PENALTY_IMPOSED',
];

function caseTypeLabel(t: string): string {
  return ENFORCEMENT_CASE_TYPE_LABELS[t as EnforcementCaseType] ?? t;
}

function statusLabel(s: string): string {
  return ENFORCEMENT_CASE_STATUS_LABELS[s as EnforcementCaseStatus] ?? s;
}

/** Where a case came from, said in one word an officer can weigh. */
const ORIGIN_LABELS: Record<string, string> = {
  PUBLIC_COMPLAINT: 'Public complaint',
  RISK_FLAG: 'Confirmed risk finding',
  INSPECTION: 'Field inspection',
  OFFICER: 'Officer',
  SYSTEM: 'Automated',
};

export default function EnforcementPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.loadingWrap}>
          <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
          <p>Loading enforcement cases…</p>
        </div>
      }
    >
      <EnforcementView />
    </Suspense>
  );
}

function EnforcementView() {
  /*
   * `?search=` is read once, at mount. It is how a pasted case number arrives from
   * the topbar search — and how an officer taking a call can find the case a
   * complainant is quoting at them, which was previously impossible.
   */
  const sp = useSearchParams();
  const initialSearch = sp.get('search') ?? '';

  const [cases, setCases] = useState<CaseRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Committed separately from the box, so a half-typed case number does not fire a
  // request per keystroke against an anchored regex.
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [search, setSearch] = useState(initialSearch);
  const [status, setStatus] = useState(initialSearch ? 'all' : 'open');
  const [caseType, setCaseType] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [mine, setMine] = useState(false);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [page, setPage] = useState(1);

  const fetchCases = useCallback(async () => {
    const params = new URLSearchParams({ status, page: String(page), limit: '25' });
    if (search) params.set('search', search);
    if (caseType !== 'all') params.set('caseType', caseType);
    if (severity !== 'all') params.set('severity', severity);
    if (mine) params.set('mine', 'true');
    if (unassignedOnly) params.set('unassigned', 'true');

    try {
      const res = await fetch(`/api/enforcement?${params.toString()}`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        cases?: CaseRow[];
        summary?: Summary;
        pagination?: Pagination;
      };
      if (!data.success) {
        setError(data.error || 'Cases could not be loaded.');
        return;
      }
      setForbidden(false);
      setError(null);
      setCases(data.cases ?? []);
      setSummary(data.summary ?? null);
      setPagination(data.pagination ?? null);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [status, caseType, severity, mine, unassignedOnly, page, search]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchCases();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchCases]);

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading enforcement cases…</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className={styles.gate}>
        <Gavel size={44} style={{ color: 'var(--color-secondary)' }} />
        <h2>Enforcement cases are handled by Legal Metrology staff</h2>
        <p>
          A case can end in a penalty under the Legal Metrology Act, so the register is
          limited to officers and administrators. If a case has been opened concerning one of
          your instruments you will have been notified, and the case will be visible from that
          notification.
        </p>
        <p>
          If you want to report a suspect weighing or measuring instrument, anyone can do so —
          no account needed.
        </p>
        <div className={styles.gateActions}>
          <Link href="/dashboard" className="clay-btn clay-btn-outline">
            Back to dashboard
          </Link>
          <Link href="/report" className="clay-btn clay-btn-primary">
            Report an instrument
          </Link>
        </div>
      </div>
    );
  }

  const openLive = LIVE_STATUSES.reduce((n, s) => n + (summary?.byStatus?.[s] ?? 0), 0);

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Enforcement</h1>
          <p>
            Cases opened against instruments and the businesses that operate them — from
            confirmed risk findings, from field inspections, and from members of the public.
            Notice precedes a hearing and a hearing precedes a penalty; the register enforces
            that order, and every action taken on a case is appended to its log rather than
            replacing what was there.
          </p>
        </div>
        <Link href="/dashboard/enforcement/new" className="clay-btn clay-btn-primary">
          <Plus size={18} />
          Open a case
        </Link>
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

      {/*
        * Unassigned first, and highlighted, because that pile is almost entirely
        * public complaints — an officer who opens a case is assigned it on creation.
        * A complaint sitting in nobody's queue is the one failure a member of the
        * public actually experiences.
        */}
      {(summary?.unassigned ?? 0) > 0 && (
        <button
          type="button"
          className={styles.unassignedBanner}
          onClick={() => {
            setUnassignedOnly(true);
            setMine(false);
            setStatus('open');
            setPage(1);
          }}
        >
          <UserX size={20} />
          <div>
            <strong>
              {summary?.unassigned} case{summary?.unassigned === 1 ? '' : 's'} nobody has picked
              up
            </strong>
            <span>
              These are mostly reports from members of the public. Nobody is working them until
              somebody takes them.
            </span>
          </div>
          <ChevronRight size={18} />
        </button>
      )}

      <div className={styles.metricsGrid}>
        <div className={styles.metricCard}>
          <span className={styles.metricLabel}>Live cases</span>
          <span className={styles.metricVal}>{openLive}</span>
          <span className={styles.metricSub}>in your jurisdiction</span>
        </div>
        {ENFORCEMENT_SEVERITIES.slice()
          .reverse()
          .map((s) => (
            <button
              key={s}
              type="button"
              className={`${styles.metricCard} ${styles.metricBtn} ${
                severity === s ? styles.metricActive : ''
              } ${styles[`metric${s}`] ?? ''}`}
              onClick={() => {
                setSeverity(severity === s ? 'all' : s);
                setPage(1);
              }}
            >
              <span className={styles.metricLabel}>{s.charAt(0) + s.slice(1).toLowerCase()}</span>
              <span className={styles.metricVal}>{summary?.bySeverity?.[s] ?? 0}</span>
              <span className={styles.metricSub}>open</span>
            </button>
          ))}
        <div className={styles.metricCard}>
          <span className={styles.metricLabel}>Penalty imposed</span>
          <span className={styles.metricVal}>{summary?.byStatus?.PENALTY_IMPOSED ?? 0}</span>
          <span className={styles.metricSub}>awaiting closure</span>
        </div>
      </div>

      {/* The statutory sequence, as a filter strip. Only stages that have cases in
          them are offered — an empty stage is not a queue. */}
      <div className={styles.stageStrip}>
        {LIVE_STATUSES.filter((s) => (summary?.byStatus?.[s] ?? 0) > 0).map((s) => (
          <button
            key={s}
            type="button"
            className={`${styles.stageChip} ${status === s ? styles.stageActive : ''}`}
            onClick={() => {
              setStatus(status === s ? 'open' : s);
              setPage(1);
            }}
          >
            {statusLabel(s)}
            <span className={styles.stageCount}>{summary?.byStatus?.[s]}</span>
          </button>
        ))}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.tabs}>
          {TABS.map((t) => (
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

        <div className={styles.filterRow}>
          {/*
            * Case-number lookup. Committing it widens the status scope to
            * everything, and the tab moves to match — somebody who types a number
            * wants that case whether or not it is still open, and a silent change
            * of scope would be worse than a visible one.
            */}
          <form
            className={styles.searchForm}
            onSubmit={(e) => {
              e.preventDefault();
              const next = searchInput.trim();
              setSearch(next);
              if (next) setStatus('all');
              setPage(1);
            }}
          >
            <Search size={15} />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Case number"
              aria-label="Find a case by its number"
              autoComplete="off"
              spellCheck={false}
            />
            {(searchInput || search) && (
              <button
                type="button"
                className={styles.searchClear}
                aria-label="Clear the case-number search"
                onClick={() => {
                  setSearchInput('');
                  setSearch('');
                  setPage(1);
                }}
              >
                <X size={14} />
              </button>
            )}
          </form>

          <select
            className="clay-select"
            value={caseType}
            onChange={(e) => {
              setCaseType(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by case type"
          >
            <option value="all">All case types</option>
            {Object.keys(ENFORCEMENT_CASE_TYPE_LABELS).map((t) => (
              <option key={t} value={t}>
                {caseTypeLabel(t)}
              </option>
            ))}
          </select>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => {
                setMine(e.target.checked);
                if (e.target.checked) setUnassignedOnly(false);
                setPage(1);
              }}
            />
            Assigned to me
          </label>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={unassignedOnly}
              onChange={(e) => {
                setUnassignedOnly(e.target.checked);
                if (e.target.checked) setMine(false);
                setPage(1);
              }}
            />
            Unassigned
          </label>
        </div>
      </div>

      {cases.length === 0 ? (
        <div className={styles.emptyState}>
          <Gavel size={44} style={{ color: 'var(--text-muted)' }} />
          <h3>{search ? `No case matches “${search}”` : 'No cases match these filters'}</h3>
          <p>
            {search
              ? 'Case numbers look like VT-ENF-2026-000123, and the search matches from the start of the number. A case outside your jurisdiction will not appear here even with the right number.'
              : status === 'open' &&
                  caseType === 'all' &&
                  severity === 'all' &&
                  !mine &&
                  !unassignedOnly
                ? 'Nothing is under enforcement in your jurisdiction. Cases arrive from confirmed risk findings, from inspections, and from public reports.'
                : 'Try a broader status, or clear the filters.'}
          </p>
        </div>
      ) : (
        <div className={styles.caseList}>
          {cases.map((c) => (
            <Link key={c.id} href={`/dashboard/enforcement/${c.id}`} className={styles.caseCard}>
              <div className={styles.caseTop}>
                <div className={styles.caseHead}>
                  <span className={styles.caseNo}>{c.caseNo}</span>
                  <span className={`clay-badge ${enforcementStatusBadgeClass(c.status)}`}>
                    {statusLabel(c.status)}
                  </span>
                  {/* Severity reuses the risk-level palette: the two scales mean the
                      same thing to an officer reading a queue. */}
                  <span className={`clay-badge ${riskLevelBadgeClass(c.severity)}`}>
                    {c.severity.charAt(0) + c.severity.slice(1).toLowerCase()}
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
                <ChevronRight size={18} className={styles.caseArrow} />
              </div>

              <h3>{c.title}</h3>
              <p className={styles.caseType}>{caseTypeLabel(c.caseType)}</p>

              <div className={styles.caseMeta}>
                {c.instrumentId?.serialNo && (
                  <span className={styles.metaItem}>
                    <Scale size={14} />
                    {c.instrumentId.serialNo}
                    {c.instrumentId.type ? ` · ${c.instrumentId.type}` : ''}
                  </span>
                )}
                {(c.jurisdiction?.district || c.jurisdiction?.state) && (
                  <span className={styles.metaItem}>
                    <MapPin size={14} />
                    {[c.jurisdiction.district, c.jurisdiction.state].filter(Boolean).join(', ')}
                  </span>
                )}
                <span className={styles.metaItem}>
                  <Clock size={14} />
                  {c.closedAt
                    ? `Concluded ${formatDate(c.closedAt)}`
                    : `Open ${c.ageDays} day${c.ageDays === 1 ? '' : 's'}`}
                </span>
                {c.assignedTo ? (
                  <span className={styles.metaItem}>
                    {c.assignedTo.name}
                    {c.assignedTo.officerCode ? ` (${c.assignedTo.officerCode})` : ''}
                  </span>
                ) : (
                  <span className={`${styles.metaItem} ${styles.metaUnassigned}`}>
                    <UserX size={14} />
                    Unassigned
                  </span>
                )}
              </div>

              {c.penalty?.amount ? (
                <p className={styles.penaltyLine}>
                  Penalty {formatInr(c.penalty.amount)}
                  {c.penalty.reference ? ` under ${c.penalty.reference}` : ''} —{' '}
                  {c.penalty.paidAt ? `paid ${formatDate(c.penalty.paidAt)}` : 'unpaid'}
                </p>
              ) : null}

              {c.outcome && <p className={styles.outcomeLine}>Outcome: {c.outcome}</p>}

              {/* The last action rather than a count. "3 actions" says nothing; "Notice
                  issued 12 August" tells an officer where the case stands. */}
              {c.lastAction && !c.outcome && (
                <p className={styles.lastAction}>
                  Last: {c.lastAction.action.replace(/^STATUS_/, '').replace(/_/g, ' ').toLowerCase()}{' '}
                  · {formatDate(c.lastAction.at)}
                  {c.actionCount > 1 ? ` · ${c.actionCount} actions on record` : ''}
                </p>
              )}

              <p className={styles.originLine}>
                Origin: {ORIGIN_LABELS[c.origin] ?? c.origin}
                {c.complainant &&
                  (c.complainant.isAnonymous
                    ? ' · complainant anonymous'
                    : c.complainant.hasContact
                      ? ' · complainant contactable'
                      : '')}
              </p>
            </Link>
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
            Page {pagination.page} of {pagination.pages} · {pagination.total} case
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
        Cases are never deleted, and their action logs are append-only — a case that ends in a
        penalty has to withstand a challenge, and an officer who could edit away an earlier note
        would be destroying the evidence that the process was followed. A concluded case can only
        be reopened by an administrator, with a reason that goes on the record.
        {status !== 'all' && ENFORCEMENT_CASE_STATUSES.length > LIVE_STATUSES.length
          ? ' Concluded cases are under “Concluded”.'
          : ''}
      </p>
    </div>
  );
}
