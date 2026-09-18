'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Plus,
  Search,
  Scale,
  MapPin,
  Calendar,
  Loader2,
  Filter,
  ArrowRight,
  ShieldCheck,
  AlertTriangle,
  X,
} from 'lucide-react';
import {
  INSTRUMENT_STATUSES,
  INSTRUMENT_TYPES,
  formatDate,
  instrumentStatusLabel,
  statusBadgeClass,
} from '@/lib/constants';
import styles from './instruments.module.css';

/**
 * The owner's (or officer's) instrument register.
 *
 * Three things were wrong here and all three came from the page keeping its own
 * copy of vocabulary that lives in `@/lib/constants`:
 *
 *  - The badge map was keyed on the pre-migration statuses (`Active`,
 *    `PendingVerification`, …) while the database stores `REGISTERED`,
 *    `PENDING_VERIFICATION` and so on, so **every** badge fell through to the
 *    neutral grey default.
 *  - The label was produced by `status.replace(/([A-Z])/g, ' $1')`, which turned
 *    `PENDING_VERIFICATION` into `P E N D I N G _ V E R I F I C A T I O N`.
 *  - The status filter offered those same legacy values, so choosing one matched
 *    nothing at all.
 *
 * Filtering and search now go to the server, which supports `status`, `type`,
 * `search`, `includeDecommissioned` and paging. Filtering the fetched array
 * instead meant a search only ever looked at the first page of results and
 * silently missed the rest of the register.
 *
 * The card links to the instrument's digital passport rather than opening a
 * specs modal: the passport is the full record — certificates, inspections,
 * moves, owners, timeline — and it is where decommissioning lives. (The old
 * "Delete Instrument" menu item called `DELETE /api/instruments?id=`, which now
 * refuses by design: an instrument with certificates and inspections against it
 * is a legal history and is retired, not erased.)
 */

interface CertificateRef {
  certNo: string;
  expiryDate: string;
  status: string;
}

interface InstrumentItem {
  _id: string;
  type: string;
  brand: string;
  model: string;
  serialNo: string;
  capacity?: string;
  accuracyClass?: string;
  installationState: string;
  installationDistrict: string;
  address?: string;
  status: string;
  nextVerificationDue?: string;
  lastVerifiedDate?: string;
  daysToDue: number | null;
  isDecommissioned?: boolean;
  duplicateReviewPending?: boolean;
  currentCertificateId?: CertificateRef | string | null;
  ownerId?: { name?: string; organizationName?: string } | string;
  createdAt: string;
}

const PAGE_SIZE = 24;

function InstrumentsView() {
  const urlParams = useSearchParams();
  const [instruments, setInstruments] = useState<InstrumentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [countsByStatus, setCountsByStatus] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /*
   * Seeded from the URL. This is where the dashboard shell's search box sends free
   * text, because the instruments query is the only one on the API that matches
   * serial number, brand and model rather than an exact identifier.
   */
  const [searchInput, setSearchInput] = useState(urlParams.get('search') ?? '');
  const [search, setSearch] = useState(urlParams.get('search') ?? '');
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [page, setPage] = useState(1);

  // Typing shouldn't fire a request per keystroke. The committed `search` is what
  // the fetch depends on.
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const fetchInstruments = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (status !== 'all') params.set('status', status);
    if (type !== 'all') params.set('type', type);
    if (search) params.set('search', search);
    if (includeRetired) params.set('includeDecommissioned', 'true');

    try {
      const res = await fetch(`/api/instruments?${params.toString()}`);
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        instruments?: InstrumentItem[];
        total?: number;
        countsByStatus?: Record<string, number>;
      };

      if (!data.success) {
        setError(data.error || 'Instruments could not be loaded.');
        return;
      }

      setError(null);
      setInstruments(data.instruments ?? []);
      setTotal(data.total ?? 0);
      setCountsByStatus(data.countsByStatus ?? {});
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [page, status, type, search, includeRetired]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchInstruments();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchInstruments]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = status !== 'all' || type !== 'all' || !!search || includeRetired;

  function clearFilters() {
    setStatus('all');
    setType('all');
    setSearchInput('');
    setSearch('');
    setIncludeRetired(false);
    setPage(1);
  }

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading instruments…</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>My Instruments</h1>
          <p>
            {total} registered instrument{total === 1 ? '' : 's'}
            {hasFilters ? ' matching these filters' : ''}
          </p>
        </div>
        <Link href="/dashboard/instruments/new" className="clay-btn clay-btn-primary">
          <Plus size={18} />
          Add Instrument
        </Link>
      </div>

      {/*
        * Status counts double as filters. They come from the API's aggregate over
        * the caller's whole scope, not from the page currently loaded, so the
        * numbers are the register's and not the screen's.
        */}
      <div className={styles.statusChips}>
        <button
          type="button"
          className={`${styles.chip} ${status === 'all' ? styles.chipActive : ''}`}
          onClick={() => {
            setStatus('all');
            setPage(1);
          }}
        >
          All
        </button>
        {INSTRUMENT_STATUSES.filter((s) => (countsByStatus[s] ?? 0) > 0).map((s) => (
          <button
            key={s}
            type="button"
            className={`${styles.chip} ${status === s ? styles.chipActive : ''}`}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
          >
            {instrumentStatusLabel(s)}
            <span className={styles.chipCount}>{countsByStatus[s]}</span>
          </button>
        ))}
      </div>

      <div className={styles.filters}>
        <div className={styles.searchBar}>
          <Search size={18} />
          <input
            type="text"
            placeholder="Search by serial number, brand or model…"
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
            aria-label="Filter by instrument category"
          >
            <option value="all">All categories</option>
            {INSTRUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <label className={styles.retiredToggle}>
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(e) => {
              setIncludeRetired(e.target.checked);
              setPage(1);
            }}
          />
          Show decommissioned
        </label>
      </div>

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      )}

      {instruments.length === 0 ? (
        <div className={styles.emptyState}>
          <Scale size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>No instruments found</h3>
          <p>
            {hasFilters
              ? 'Nothing matches these filters. Clear them to see the whole register.'
              : 'Start by adding your first instrument to the registry.'}
          </p>
          {hasFilters ? (
            <button type="button" className="clay-btn clay-btn-outline" onClick={clearFilters}>
              Clear filters
            </button>
          ) : (
            <Link href="/dashboard/instruments/new" className="clay-btn clay-btn-primary">
              <Plus size={18} />
              Add First Instrument
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className={styles.grid}>
            {instruments.map((inst) => {
              const cert =
                typeof inst.currentCertificateId === 'object' && inst.currentCertificateId
                  ? inst.currentCertificateId
                  : null;
              const overdue = inst.daysToDue !== null && inst.daysToDue < 0;
              const dueSoon =
                inst.daysToDue !== null && inst.daysToDue >= 0 && inst.daysToDue <= 60;

              return (
                <div key={inst._id} className={styles.card}>
                  <div className={styles.cardTop}>
                    <div className={styles.cardIcon}>
                      <Scale size={22} />
                    </div>
                    <span className={`clay-badge ${statusBadgeClass(inst.status)}`}>
                      {instrumentStatusLabel(inst.status)}
                    </span>
                  </div>

                  <h4>{inst.type}</h4>
                  <p className={styles.cardModel}>
                    {[inst.brand, inst.model].filter(Boolean).join(' — ') || 'Make not recorded'}
                  </p>

                  <div className={styles.cardDetails}>
                    <div className={styles.detailRow}>
                      <span>Serial No.</span>
                      <strong>{inst.serialNo}</strong>
                    </div>
                    <div className={styles.detailRow}>
                      <span>Capacity</span>
                      <strong>{inst.capacity || 'Not recorded'}</strong>
                    </div>
                    <div className={styles.detailRow}>
                      <MapPin size={14} />
                      <span>Location</span>
                      <strong>
                        {[inst.installationDistrict, inst.installationState]
                          .filter(Boolean)
                          .join(', ')}
                      </strong>
                    </div>
                    {cert && (
                      <div className={styles.detailRow}>
                        <ShieldCheck size={14} />
                        <span>Certificate</span>
                        <strong>{cert.certNo}</strong>
                      </div>
                    )}
                    {inst.nextVerificationDue && (
                      <div
                        className={`${styles.detailRow} ${
                          overdue ? styles.dueOverdue : dueSoon ? styles.dueSoon : ''
                        }`}
                      >
                        <Calendar size={14} />
                        <span>{overdue ? 'Overdue' : 'Next due'}</span>
                        <strong>
                          {formatDate(inst.nextVerificationDue)}
                          {inst.daysToDue !== null &&
                            (overdue
                              ? ` · ${Math.abs(inst.daysToDue)}d ago`
                              : ` · in ${inst.daysToDue}d`)}
                        </strong>
                      </div>
                    )}
                  </div>

                  {inst.duplicateReviewPending && (
                    <p className={styles.cardWarn}>
                      <AlertTriangle size={13} />
                      Under duplicate review
                    </p>
                  )}

                  <div className={styles.cardActions}>
                    <Link href={`/dashboard/instruments/${inst._id}`} className={styles.passportLink}>
                      Open record
                      <ArrowRight size={15} />
                    </Link>
                    {!inst.isDecommissioned && (
                      <Link
                        href={`/dashboard/applications/new?instrumentId=${inst._id}`}
                        className="clay-btn clay-btn-sm clay-btn-outline"
                      >
                        Apply
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
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
export default function InstrumentsPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.loadingWrap}>
          <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
          <p>Loading instruments…</p>
        </div>
      }
    >
      <InstrumentsView />
    </Suspense>
  );
}
