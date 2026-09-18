'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  FileText,
  Plus,
  Search,
  Filter,
  Loader2,
  Calendar,
  IndianRupee,
  AlertTriangle,
  ArrowRight,
  X,
  Clock,
  Flame,
} from 'lucide-react';
import {
  APPLICATION_STATUSES,
  OFFICER_QUEUE_STATUSES,
  OFFICIAL_ROLES,
  OPEN_APPLICATION_STATUSES,
  VERIFICATION_TYPES,
  VERIFICATION_TYPE_LABELS,
  applicationStatusLabel,
  daysUntil,
  formatDate,
  statusBadgeClass,
  type VerificationType,
} from '@/lib/constants';
import styles from './applications.module.css';

/**
 * The applications list — an owner's filings, an officer's queue.
 *
 * Everything wrong here came from the page keeping its own copy of vocabulary
 * that already lives in `@/lib/constants`, and from filtering in the browser:
 *
 *  - The badge map was keyed `Submitted` / `UnderReview` / `Scheduled` while the
 *    database stores `SUBMITTED` / `UNDER_REVIEW` / …, so **every** badge fell
 *    through to the neutral grey default — including `REJECTED`.
 *  - The badge then printed the raw enum, so an applicant read
 *    `APPROVED_FOR_SCHEDULING`.
 *  - The status filter offered those same five legacy values, so picking any one
 *    of them matched nothing at all.
 *  - `applications.filter(...)` ran over the fetched array while the fetch was a
 *    bare `/api/applications` with no parameters, so a search only ever looked at
 *    the first page and silently missed the rest.
 *  - The type cell was `type === 'initial' ? … : 'Re-verification'`. There are
 *    four verification types, so a post-repair and a transfer application both
 *    lied about what they were.
 *  - The fee column showed `feePaid`, which is ₹0 for exactly the applications
 *    whose fee matters — the unpaid ones. It now shows what the fee *is*, with
 *    its payment status next to it.
 *  - Rows linked nowhere, so the list was a dead end: there was no route from
 *    here to the application it was listing.
 *
 * Filtering, searching and paging are now the server's job (`status` as a CSV,
 * `queue`, `assignedToMe`, `type`, `search`, `page`, `limit`), and the status
 * counts come from an aggregate over the caller's whole scope rather than the
 * page on screen.
 */

interface PopulatedInstrument {
  _id?: string;
  type?: string;
  brand?: string;
  model?: string;
  serialNo?: string;
  installationDistrict?: string;
  installationState?: string;
}

interface PopulatedUser {
  _id?: string;
  name?: string;
  organizationName?: string;
  role?: string;
  designation?: string;
}

interface ApplicationItem {
  _id: string;
  applicationNo: string;
  type: string;
  status: string;
  feeAmount: number;
  feePaid: number;
  feeStatus: string;
  submittedDate?: string;
  scheduledDate?: string;
  dueDate?: string;
  createdAt: string;
  priorityScore?: number;
  instrumentId?: PopulatedInstrument | string | null;
  assignedTo?: PopulatedUser | string | null;
  ownerId?: PopulatedUser | string | null;
}

const PAGE_SIZE = 25;

/** `'queue'` is deliberately a sentinel, not a status list written out again. */
const QUEUE = 'queue';
/** The two statuses where the ball is in the applicant's court. */
const OWNER_ACTION = 'DRAFT,QUERY_RAISED';

function asPopulated<T extends object>(value: T | string | null | undefined): T | null {
  return value && typeof value === 'object' ? value : null;
}

function ApplicationsView() {
  const { data: session, status: sessionStatus } = useSession();
  const role = session?.user?.role;
  const official = !!role && OFFICIAL_ROLES.includes(role);
  const urlParams = useSearchParams();

  const [applications, setApplications] = useState<ApplicationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [countsByStatus, setCountsByStatus] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /*
   * Seeded from the URL so the topbar search can land here with a term already
   * applied. Without this the search box in the dashboard shell would navigate
   * correctly and then be ignored, which is worse than not searching at all.
   */
  const [searchInput, setSearchInput] = useState(urlParams.get('search') ?? '');
  const [search, setSearch] = useState(urlParams.get('search') ?? '');
  // `null` means "the caller has not chosen", which lets an officer land on their
  // own queue and an owner on everything without setting state from an effect
  // once the session resolves.
  const [statusChoice, setStatusChoice] = useState<string | null>(null);
  const [type, setType] = useState('all');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);

  const status = statusChoice ?? (official ? QUEUE : 'all');

  // Typing shouldn't fire a request per keystroke; the committed `search` is what
  // the fetch depends on.
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const fetchApplications = useCallback(async () => {
    // Wait for the session: the default filter and the visible columns both
    // depend on the role, and fetching twice would show an officer their queue
    // only after briefly showing them everything.
    if (sessionStatus === 'loading') return;

    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (status === QUEUE) params.set('queue', 'officer');
    else if (status !== 'all') params.set('status', status);
    if (type !== 'all') params.set('type', type);
    if (search) params.set('search', search);
    if (mine) params.set('assignedToMe', 'true');

    try {
      const res = await fetch(`/api/applications?${params.toString()}`);
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        applications?: ApplicationItem[];
        total?: number;
        countsByStatus?: Record<string, number>;
      };

      if (!data.success) {
        setError(data.error || 'Applications could not be loaded.');
        return;
      }

      setError(null);
      setApplications(data.applications ?? []);
      setTotal(data.total ?? 0);
      setCountsByStatus(data.countsByStatus ?? {});
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [sessionStatus, page, status, type, search, mine]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchApplications();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchApplications]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = status !== 'all' || type !== 'all' || !!search || mine;

  /** A chip key may be a single status, a CSV of them, or the queue sentinel. */
  function countFor(key: string): number {
    const wanted = key === QUEUE ? OFFICER_QUEUE_STATUSES : key.split(',');
    return wanted.reduce((n, s) => n + (countsByStatus[s] ?? 0), 0);
  }

  function pick(key: string) {
    setStatusChoice(key);
    setPage(1);
  }

  function clearFilters() {
    setStatusChoice('all');
    setType('all');
    setSearchInput('');
    setSearch('');
    setMine(false);
    setPage(1);
  }

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading applications…</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>{official ? 'Verification Applications' : 'My Applications'}</h1>
          <p>
            {total} application{total === 1 ? '' : 's'}
            {hasFilters ? ' matching these filters' : ''}
          </p>
        </div>
        {!official && (
          <Link href="/dashboard/applications/new" className="clay-btn clay-btn-primary">
            <Plus size={18} />
            New Application
          </Link>
        )}
      </div>

      {/*
        * The counts come from the API's aggregate over the caller's scope, so a
        * chip states how many applications sit in that status — not how many are
        * on the page currently loaded.
        */}
      <div className={styles.statusChips}>
        {official && (
          <button
            type="button"
            className={`${styles.chip} ${status === QUEUE ? styles.chipActive : ''}`}
            onClick={() => pick(QUEUE)}
          >
            <Clock size={14} />
            Open queue
            <span className={styles.chipCount}>{countFor(QUEUE)}</span>
          </button>
        )}
        {!official && countFor(OWNER_ACTION) > 0 && (
          <button
            type="button"
            className={`${styles.chip} ${status === OWNER_ACTION ? styles.chipActive : ''}`}
            onClick={() => pick(OWNER_ACTION)}
          >
            <AlertTriangle size={14} />
            Needs your action
            <span className={styles.chipCount}>{countFor(OWNER_ACTION)}</span>
          </button>
        )}
        <button
          type="button"
          className={`${styles.chip} ${status === 'all' ? styles.chipActive : ''}`}
          onClick={() => pick('all')}
        >
          All
        </button>
        {APPLICATION_STATUSES.filter((s) => (countsByStatus[s] ?? 0) > 0).map((s) => (
          <button
            key={s}
            type="button"
            className={`${styles.chip} ${status === s ? styles.chipActive : ''}`}
            onClick={() => pick(s)}
          >
            {applicationStatusLabel(s)}
            <span className={styles.chipCount}>{countsByStatus[s]}</span>
          </button>
        ))}
      </div>

      <div className={styles.filters}>
        <div className={styles.searchBar}>
          <Search size={18} />
          <input
            type="text"
            /* Application number only — the API deliberately refuses to search
               owner names, so promising more here would be a lie. */
            placeholder="Search by application number…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button
              type="button"
              className={styles.clearSearch}
              onClick={() => setSearchInput('')}
              aria-label="Clear search"
            >
              <X size={15} />
            </button>
          )}
        </div>
        <div className={styles.filterGroup}>
          <Filter size={16} />
          <select
            className="clay-input clay-select"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPage(1);
            }}
            style={{ padding: '10px 38px 10px 14px', fontSize: '0.85rem' }}
            aria-label="Filter by verification type"
          >
            <option value="all">All verification types</option>
            {VERIFICATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {VERIFICATION_TYPE_LABELS[t as VerificationType]}
              </option>
            ))}
          </select>
        </div>
        {official && (
          <label className={styles.mineToggle}>
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => {
                setMine(e.target.checked);
                setPage(1);
              }}
            />
            Assigned to me
          </label>
        )}
      </div>

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      )}

      {applications.length === 0 ? (
        <div className={styles.emptyState}>
          <FileText size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>No applications found</h3>
          <p>
            {hasFilters
              ? 'Nothing matches these filters. Clear them to see everything in your scope.'
              : official
                ? 'Nothing is waiting on your office right now.'
                : 'Submit your first verification application to start.'}
          </p>
          {hasFilters ? (
            <button type="button" className="clay-btn clay-btn-outline" onClick={clearFilters}>
              Clear filters
            </button>
          ) : (
            !official && (
              <Link href="/dashboard/applications/new" className="clay-btn clay-btn-primary">
                <Plus size={18} />
                Submit First Application
              </Link>
            )
          )}
        </div>
      ) : (
        <>
          <div className="clay-table-wrapper">
            <table className="clay-table">
              <thead>
                <tr>
                  <th>Application</th>
                  <th>Instrument</th>
                  <th>Verification</th>
                  <th>Filed</th>
                  <th>Fee</th>
                  <th>Status</th>
                  {official && <th>Applicant</th>}
                  {official && <th>Assigned to</th>}
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((app) => {
                  const inst = asPopulated<PopulatedInstrument>(app.instrumentId);
                  const owner = asPopulated<PopulatedUser>(app.ownerId);
                  const assignee = asPopulated<PopulatedUser>(app.assignedTo);
                  const open = (OPEN_APPLICATION_STATUSES as readonly string[]).includes(app.status);
                  const slaDays = open ? daysUntil(app.dueDate) : null;
                  const overdue = slaDays !== null && slaDays < 0;
                  const href = `/dashboard/applications/${app._id}`;

                  return (
                    <tr key={app._id}>
                      <td>
                        <Link href={href} className={styles.appLink}>
                          {app.applicationNo}
                        </Link>
                        {overdue && (
                          <div className={styles.rowFlag}>
                            <Flame size={12} />
                            {Math.abs(slaDays)}d past its target date
                          </div>
                        )}
                        {!overdue && app.scheduledDate && (
                          <div className={styles.rowSub}>
                            <Calendar size={12} />
                            Visit {formatDate(app.scheduledDate)}
                          </div>
                        )}
                      </td>
                      <td>
                        {inst ? (
                          <>
                            <div className={styles.cellStrong}>{inst.type}</div>
                            <div className={styles.cellSub}>
                              {[inst.serialNo, inst.installationDistrict]
                                .filter(Boolean)
                                .join(' · ') || 'Serial not recorded'}
                            </div>
                          </>
                        ) : (
                          <span className={styles.muted}>Instrument removed</span>
                        )}
                      </td>
                      <td>{VERIFICATION_TYPE_LABELS[app.type as VerificationType] ?? app.type}</td>
                      <td>
                        {app.submittedDate ? (
                          <div className={styles.rowSub}>
                            <Calendar size={13} />
                            {formatDate(app.submittedDate)}
                          </div>
                        ) : (
                          <span className={styles.muted}>Not filed yet</span>
                        )}
                      </td>
                      <td>
                        <div className={styles.fee}>
                          <IndianRupee size={13} />
                          {app.feeAmount.toLocaleString('en-IN')}
                        </div>
                        <span className={`clay-badge ${statusBadgeClass(app.feeStatus)}`}>
                          {app.feeStatus}
                        </span>
                      </td>
                      <td>
                        <span className={`clay-badge ${statusBadgeClass(app.status)}`}>
                          {applicationStatusLabel(app.status)}
                        </span>
                      </td>
                      {official && (
                        <td>
                          {owner ? (
                            <>
                              <div className={styles.cellStrong}>
                                {owner.organizationName || owner.name || 'Unnamed'}
                              </div>
                              {owner.organizationName && owner.name && (
                                <div className={styles.cellSub}>{owner.name}</div>
                              )}
                            </>
                          ) : (
                            <span className={styles.muted}>—</span>
                          )}
                        </td>
                      )}
                      {official && (
                        <td>
                          {assignee ? (
                            <>
                              <div className={styles.cellStrong}>{assignee.name}</div>
                              <div className={styles.cellSub}>
                                {assignee.designation || assignee.role}
                              </div>
                            </>
                          ) : (
                            <span className={styles.muted}>Unassigned</span>
                          )}
                        </td>
                      )}
                      <td>
                        <Link
                          href={href}
                          className={styles.openLink}
                          aria-label={`Open ${app.applicationNo}`}
                        >
                          <ArrowRight size={16} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
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
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                className="clay-btn clay-btn-sm clay-btn-outline"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * `useSearchParams` client-side renders the tree up to the nearest Suspense
 * boundary when the route is prerendered, so the boundary has to exist.
 */
export default function ApplicationsPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.loadingWrap}>
          <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
          <p>Loading applications…</p>
        </div>
      }
    >
      <ApplicationsView />
    </Suspense>
  );
}
