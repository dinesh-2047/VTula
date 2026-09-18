'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  Loader2,
  MapPin,
  Megaphone,
  Paperclip,
  Phone,
  Search,
  Store,
} from 'lucide-react';
import {
  COMPLAINT_STATUSES,
  COMPLAINT_STATUS_LABELS,
  COMPLAINT_TYPES,
  COMPLAINT_TYPE_LABELS,
  COMPLAINT_PRIORITIES,
  formatDateTime,
  type ComplaintStatus,
  type ComplaintType,
} from '@/lib/constants';
import styles from './complaints.module.css';

/**
 * The officer's public-complaint queue.
 *
 * Everything on this page comes from `GET /api/complaints`, which scopes rows by
 * the *premises* jurisdiction — a complaint about a shop in Shimla belongs to the
 * Shimla office regardless of where the complainant lives. The tab counts come
 * from the same query as the rows, in the same response, so a badge can never
 * disagree with the list beneath it.
 *
 * Sorted by the server on `priority` then recency. A tampered seal arriving an
 * hour ago outranks a display complaint from yesterday, and that ordering is not
 * something this page is allowed to re-decide.
 */

interface ComplaintRow {
  _id: string;
  complaintNo: string;
  status: ComplaintStatus;
  priority: string;
  complaintType: string;
  description: string;
  createdAt: string;
  evidenceCount: number;
  complainant: { name: string; phone: string; isAnonymousToTrader?: boolean };
  against: { businessName: string; district: string; state: string; address: string };
  assignedTo?: string;
}

interface Counts {
  byStatus: Record<string, number>;
  open: number;
  total: number;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

/** Tabs, in the order a complaint actually travels. */
const TABS: { key: string; label: string }[] = [
  { key: 'open', label: 'Open' },
  ...COMPLAINT_STATUSES.map((s) => ({ key: s, label: COMPLAINT_STATUS_LABELS[s] })),
];

function priorityBadgeClass(priority: string): string {
  if (priority === 'URGENT') return 'clay-badge clay-badge-error';
  if (priority === 'HIGH') return 'clay-badge clay-badge-warning';
  if (priority === 'LOW') return 'clay-badge';
  return 'clay-badge clay-badge-info';
}

function statusBadgeClass(status: ComplaintStatus): string {
  if (status === 'RESOLVED') return 'clay-badge clay-badge-success';
  if (status === 'REJECTED' || status === 'WITHDRAWN') return 'clay-badge';
  if (status === 'SUBMITTED') return 'clay-badge clay-badge-warning';
  return 'clay-badge clay-badge-info';
}

export default function ComplaintsPage() {
  const [rows, setRows] = useState<ComplaintRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState('open');
  const [type, setType] = useState('all');
  const [priority, setPriority] = useState('all');
  // Committed separately from the box: the server search is an anchored regex over
  // four fields, and firing it per keystroke is a scan per keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const fetchComplaints = useCallback(async () => {
    const params = new URLSearchParams({ status, page: String(page), limit: '24' });
    if (type !== 'all') params.set('type', type);
    if (priority !== 'all') params.set('priority', priority);
    if (search) params.set('q', search);

    try {
      const res = await fetch(`/api/complaints?${params.toString()}`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        complaints?: ComplaintRow[];
        counts?: Counts;
        pagination?: Pagination;
      };
      if (!data.success) {
        setError(data.error || 'Complaints could not be loaded.');
        return;
      }
      setForbidden(false);
      setError(null);
      setRows(data.complaints ?? []);
      setCounts(data.counts ?? null);
      setPagination(data.pagination ?? null);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [status, type, priority, search, page]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchComplaints();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchComplaints]);

  const urgentCount = useMemo(
    () => rows.filter((r) => r.priority === 'HIGH' || r.priority === 'URGENT').length,
    [rows]
  );

  const resolvedCount = counts?.byStatus.RESOLVED ?? 0;

  if (forbidden) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <AlertTriangle size={30} />
          </div>
          <div className={styles.emptyTitle}>Not available for your role</div>
          <p className={styles.emptyText}>
            Public complaints are handled by Legal Metrology officers and administrators.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.loading}>
        <Loader2 size={30} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        Loading complaints…
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Public complaints</h1>
          <p>
            Complaints filed by consumers through the public portal, routed to this office by the
            district of the premises. Each one names a real person waiting for an answer.
          </p>
        </div>
        <div className={styles.headerMeta}>
          <Link href="/complaint" className="clay-btn clay-btn-outline clay-btn-sm" target="_blank">
            <Megaphone size={15} />
            View the public form
          </Link>
        </div>
      </div>

      <div className={styles.statRow}>
        <div className={styles.stat}>
          <span className={`${styles.statIcon} ${styles.statIconOpen}`}>
            <Inbox size={20} />
          </span>
          <div>
            <div className={styles.statValue}>{counts?.open ?? 0}</div>
            <div className={styles.statLabel}>Open in your jurisdiction</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statIcon} ${styles.statIconUrgent}`}>
            <AlertTriangle size={20} />
          </span>
          <div>
            <div className={styles.statValue}>{urgentCount}</div>
            <div className={styles.statLabel}>High priority on this page</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statIcon} ${styles.statIconDone}`}>
            <CheckCircle2 size={20} />
          </span>
          <div>
            <div className={styles.statValue}>{resolvedCount}</div>
            <div className={styles.statLabel}>Resolved</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statIcon} ${styles.statIconTotal}`}>
            <Megaphone size={20} />
          </span>
          <div>
            <div className={styles.statValue}>{counts?.total ?? 0}</div>
            <div className={styles.statLabel}>Total received</div>
          </div>
        </div>
      </div>

      <div className={styles.tabs}>
        {TABS.map((tab) => {
          const n =
            tab.key === 'open'
              ? (counts?.open ?? 0)
              : (counts?.byStatus[tab.key] ?? 0);
          return (
            <button
              key={tab.key}
              type="button"
              className={`${styles.tab} ${status === tab.key ? styles.tabActive : ''}`}
              onClick={() => {
                setStatus(tab.key);
                setPage(1);
              }}
            >
              {tab.label}
              <span className={styles.tabCount}>{n}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.controlsBar}>
        <form
          className={styles.searchWrap}
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(searchInput.trim());
            setPage(1);
          }}
        >
          <Search size={16} className={styles.searchIcon} />
          <input
            className={`clay-input ${styles.searchInput}`}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Reference, business, complainant name or phone"
          />
        </form>

        <select
          className={`clay-select ${styles.filterSelect}`}
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">All complaint types</option>
          {COMPLAINT_TYPES.map((t) => (
            <option key={t} value={t}>
              {COMPLAINT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>

        <select
          className={`clay-select ${styles.filterSelect}`}
          value={priority}
          onChange={(e) => {
            setPriority(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">Any priority</option>
          {COMPLAINT_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p.charAt(0) + p.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className={styles.error}>
          <AlertCircle size={17} />
          <span>{error}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <CheckCircle2 size={30} />
          </div>
          <div className={styles.emptyTitle}>
            {status === 'open' && !search ? 'No open complaints' : 'Nothing matches'}
          </div>
          <p className={styles.emptyText}>
            {status === 'open' && !search
              ? 'Every complaint in your jurisdiction has been dealt with. New ones arrive here the moment a consumer files them, and you will be notified.'
              : 'Try a different tab, or clear the search and filters.'}
          </p>
        </div>
      ) : (
        <div className={styles.grid}>
          {rows.map((c) => {
            const urgent = c.priority === 'HIGH' || c.priority === 'URGENT';
            return (
              <Link
                key={c._id}
                href={`/dashboard/complaints/${c._id}`}
                className={`${styles.card} ${urgent ? styles.cardUrgent : ''}`}
              >
                <div className={styles.cardTop}>
                  <div>
                    <div className={styles.cardRef}>{c.complaintNo}</div>
                    <div className={styles.cardBusiness}>{c.against.businessName}</div>
                  </div>
                  <div className={styles.cardBadges}>
                    <span className={priorityBadgeClass(c.priority)}>{c.priority}</span>
                    <span className={statusBadgeClass(c.status)}>
                      {COMPLAINT_STATUS_LABELS[c.status]}
                    </span>
                  </div>
                </div>

                <span className={styles.cardType}>
                  <AlertTriangle size={14} />
                  {COMPLAINT_TYPE_LABELS[c.complaintType as ComplaintType] ?? c.complaintType}
                </span>

                <p className={styles.cardDescription}>{c.description}</p>

                <div className={styles.cardFacts}>
                  <span className={styles.cardFact}>
                    <MapPin size={14} />
                    {c.against.district}, {c.against.state}
                  </span>
                  <span className={styles.cardFact}>
                    <Store size={14} />
                    {c.against.address}
                  </span>
                  <span className={styles.cardFact}>
                    <Phone size={14} />
                    {c.complainant.name} · {c.complainant.phone}
                  </span>
                </div>

                <div className={styles.cardFoot}>
                  <span>
                    <Clock size={12} /> {formatDateTime(c.createdAt)}
                  </span>
                  {c.evidenceCount > 0 && (
                    <span>
                      <Paperclip size={12} /> {c.evidenceCount}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {pagination && pagination.pages > 1 && (
        <div className={styles.pagination}>
          <button
            type="button"
            className="clay-btn clay-btn-outline clay-btn-sm"
            disabled={pagination.page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span>
            Page {pagination.page} of {pagination.pages} · {pagination.total} complaints
          </span>
          <button
            type="button"
            className="clay-btn clay-btn-outline clay-btn-sm"
            disabled={pagination.page >= pagination.pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
