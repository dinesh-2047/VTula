'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  Award,
  Search,
  X,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  PauseCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import {
  CERTIFICATE_STATUSES,
  CERTIFICATE_VALID_STATUSES,
  EXPIRING_SOON_WINDOW_DAYS,
  certificateStatusLabel,
  statusBadgeClass,
  formatDate,
  type Role,
} from '@/lib/constants';
import CertificateDrawer from './CertificateDrawer';
import styles from './certificates.module.css';

/**
 * The certificate register.
 *
 * What this page used to do, and no longer does:
 *
 *  - Every card built an `<img src="https://api.qrserver.com/…">`. Loading the
 *    page therefore sent the certificate number of every instrument in the
 *    district to a third-party image host, and produced blank squares on any
 *    machine without internet access — in a product whose own landing page
 *    advertises offline use. `qrcode` is already a dependency and
 *    `GET /api/certificates/[id]` already returns a locally rendered
 *    `qrDataUrl`, so the QR now comes from the department's own server, in the
 *    drawer where it can actually be scanned or printed.
 *
 *  - Every badge was a green tick with `cert.status` printed raw. Since the
 *    enum is SCREAMING_SNAKE, a withdrawn certificate rendered as a green tick
 *    reading "REVOKED". Badges now come from `effectiveStatus` through
 *    `statusBadgeClass`/`certificateStatusLabel`, so a revoked certificate is
 *    red and says "Revoked".
 *
 *  - Search was `certificates.filter(...)` over whatever the first fifty rows
 *    happened to be, so a holder with sixty certificates could not find the
 *    last ten by typing their numbers. Filtering, searching and paging are now
 *    the server's, which is also the only place the whole set exists.
 *
 *  - "Verify" linked to `/verify?certNo=…`; the public route is
 *    `/verify/[certNo]`, so the button led to a 404.
 *
 * `effectiveStatus` and `daysToExpiry` were already being returned by the API
 * and thrown away. Both are used here.
 */

const PAGE_SIZE = 24;

/** `expiring` is not a status — it is a question about the expiry date. */
type Filter = 'all' | 'expiring' | (typeof CERTIFICATE_STATUSES)[number];

interface CertificateItem {
  _id: string;
  certNo: string;
  issuedDate: string;
  expiryDate: string;
  status: string;
  effectiveStatus: string;
  daysToExpiry: number;
  version?: number;
  issuedByRole?: string;
  instrumentId?: string;
  supersededById?: string;
  instrumentSnapshot: {
    type?: string;
    brand?: string;
    model?: string;
    serialNo?: string;
    capacity?: string;
    installationDistrict?: string;
    installationState?: string;
  };
  ownerSnapshot: {
    name?: string;
    email?: string;
    phone?: string;
    organizationName?: string;
  };
  suspension?: { reason: string; at: string; until?: string };
  revocation?: { reason: string; at: string };
}

function statusIcon(status: string) {
  switch (status) {
    case 'REVOKED':
      return ShieldOff;
    case 'SUSPENDED':
      return PauseCircle;
    case 'EXPIRED':
      return ShieldAlert;
    case 'EXPIRING_SOON':
      return Clock;
    case 'SUPERSEDED':
      return FileText;
    default:
      return ShieldCheck;
  }
}

function CertificatesView() {
  const params = useSearchParams();
  const { data: session } = useSession();
  const role: Role = session?.user?.role ?? 'Owner';
  const isOwner = role === 'Owner';

  const [certificates, setCertificates] = useState<CertificateItem[]>([]);
  const [total, setTotal] = useState(0);
  const [countsByStatus, setCountsByStatus] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * Seeded from the URL so the dashboard's "Renewals due" tile and its
   * per-certificate links land on the right view. A route change remounts this
   * component, which is the only way those links are ever followed.
   */
  const [searchInput, setSearchInput] = useState(params.get('search') ?? '');
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [filter, setFilter] = useState<Filter>(() => {
    if (params.get('expiring') === 'true') return 'expiring';
    const s = params.get('status');
    return s && (CERTIFICATE_STATUSES as readonly string[]).includes(s) ? (s as Filter) : 'all';
  });
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  // Typing shouldn't fire a request per keystroke. The committed `search` is what
  // the fetch depends on.
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const fetchCertificates = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (filter === 'expiring') qs.set('expiring', 'true');
    else if (filter !== 'all') qs.set('status', filter);
    if (search) qs.set('search', search);

    try {
      const res = await fetch(`/api/certificates?${qs.toString()}`);
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        certificates?: CertificateItem[];
        total?: number;
        countsByStatus?: Record<string, number>;
      };

      if (!data.success) {
        setError(data.error || 'Certificates could not be loaded.');
        return;
      }

      setError(null);
      setCertificates(data.certificates ?? []);
      setTotal(data.total ?? 0);
      setCountsByStatus(data.countsByStatus ?? {});
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [page, filter, search]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchCertificates();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchCertificates]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = filter !== 'all' || !!search;
  const inForce = (CERTIFICATE_VALID_STATUSES as readonly string[]).reduce(
    (sum, s) => sum + (countsByStatus[s] ?? 0),
    0
  );

  function clearFilters() {
    setFilter('all');
    setSearchInput('');
    setSearch('');
    setPage(1);
  }

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading certificates…</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>{isOwner ? 'My Certificates' : 'Certificates Issued'}</h1>
          <p>
            {total} certificate{total === 1 ? '' : 's'}
            {hasFilters ? ' matching these filters' : ''}
            {!hasFilters && inForce > 0 && ` · ${inForce} currently in force`}
          </p>
        </div>
      </div>

      {/*
        * The counts come from the API's aggregate over the caller's whole scope,
        * not from the rows on screen, so they describe the register rather than
        * the page. "Expiring soon" has no count because it is a date window, not
        * a stored status.
        */}
      <div className={styles.statusChips}>
        <button
          type="button"
          className={`${styles.chip} ${filter === 'all' ? styles.chipActive : ''}`}
          onClick={() => {
            setFilter('all');
            setPage(1);
          }}
        >
          All
        </button>
        <button
          type="button"
          className={`${styles.chip} ${filter === 'expiring' ? styles.chipActive : ''}`}
          onClick={() => {
            setFilter('expiring');
            setPage(1);
          }}
        >
          <Clock size={13} />
          Due within {EXPIRING_SOON_WINDOW_DAYS} days
        </button>
        {CERTIFICATE_STATUSES.filter((s) => (countsByStatus[s] ?? 0) > 0).map((s) => (
          <button
            key={s}
            type="button"
            className={`${styles.chip} ${filter === s ? styles.chipActive : ''}`}
            onClick={() => {
              setFilter(s);
              setPage(1);
            }}
          >
            {certificateStatusLabel(s)}
            <span className={styles.chipCount}>{countsByStatus[s]}</span>
          </button>
        ))}
      </div>

      <div className={styles.filters}>
        <div className={styles.searchBar}>
          <Search size={18} />
          <input
            type="text"
            placeholder="Search by certificate number or instrument serial…"
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
      </div>

      {notice && (
        <div className={styles.noticeOk}>
          <CheckCircle2 size={17} />
          <span>{notice}</span>
        </div>
      )}

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      )}

      {certificates.length === 0 ? (
        <div className={styles.emptyState}>
          <Award size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>No certificates found</h3>
          <p>
            {hasFilters
              ? 'Nothing matches these filters. Clear them to see every certificate on record.'
              : isOwner
                ? 'A certificate is issued once an officer has inspected the instrument and approved your application. Nothing has reached that stage yet.'
                : 'No certificate has been issued in your jurisdiction yet.'}
          </p>
          {hasFilters ? (
            <button type="button" className="clay-btn clay-btn-outline" onClick={clearFilters}>
              Clear filters
            </button>
          ) : (
            isOwner && (
              <Link href="/dashboard/applications/new" className="clay-btn clay-btn-primary">
                Apply for verification
              </Link>
            )
          )}
        </div>
      ) : (
        <>
          <div className={styles.grid}>
            {certificates.map((cert) => {
              const shown = cert.effectiveStatus || cert.status;
              const Icon = statusIcon(shown);
              const lapsed = cert.daysToExpiry <= 0;
              const dueSoon = !lapsed && cert.daysToExpiry <= EXPIRING_SOON_WINDOW_DAYS;
              const valid = (CERTIFICATE_VALID_STATUSES as readonly string[]).includes(shown);
              const holder =
                cert.ownerSnapshot?.organizationName ?? cert.ownerSnapshot?.name ?? '—';

              return (
                <div key={cert._id} className={styles.certCard}>
                  <div className={styles.certTop}>
                    <div className={`${styles.certIcon} ${valid ? '' : styles.certIconMuted}`}>
                      <Icon size={26} />
                    </div>
                    <div>
                      <span className={`clay-badge ${statusBadgeClass(shown)}`}>
                        {certificateStatusLabel(shown)}
                      </span>
                      <div className={styles.certNo}>{cert.certNo}</div>
                      {(cert.version ?? 1) > 1 && (
                        <div className={styles.certRevision}>Revision {cert.version}</div>
                      )}
                    </div>
                  </div>

                  <div className={styles.certBody}>
                    <h4>{cert.instrumentSnapshot?.type || 'Instrument'}</h4>
                    <p className={styles.certDetailText}>
                      {[cert.instrumentSnapshot?.brand, cert.instrumentSnapshot?.model]
                        .filter(Boolean)
                        .join(' ') || 'Make and model not recorded'}
                    </p>

                    {/* Why this certificate is not simply valid, when it is not. */}
                    {cert.revocation && (
                      <p className={styles.certAlert}>
                        Revoked {formatDate(cert.revocation.at)} — {cert.revocation.reason}
                      </p>
                    )}
                    {!cert.revocation && cert.status === 'SUSPENDED' && cert.suspension && (
                      <p className={styles.certWarn}>
                        Suspended {formatDate(cert.suspension.at)} — {cert.suspension.reason}
                      </p>
                    )}
                    {!cert.revocation && cert.supersededById && (
                      <p className={styles.certMuted}>Replaced by a later certificate.</p>
                    )}

                    <div className={styles.certRows}>
                      <div className={styles.certRow}>
                        <span>{isOwner ? 'Issued to' : 'Holder'}</span>
                        <strong>{holder}</strong>
                      </div>
                      <div className={styles.certRow}>
                        <span>Serial number</span>
                        <strong>{cert.instrumentSnapshot?.serialNo || '—'}</strong>
                      </div>
                      <div className={styles.certRow}>
                        <span>Issued</span>
                        <span>{formatDate(cert.issuedDate)}</span>
                      </div>
                      <div className={styles.certRow}>
                        <span>Valid until</span>
                        <span
                          className={
                            lapsed ? styles.dateLapsed : dueSoon ? styles.dateSoon : styles.dateOk
                          }
                        >
                          {formatDate(cert.expiryDate)}
                        </span>
                      </div>
                    </div>

                    {/* Days, spelled out — a date alone makes the reader do the arithmetic. */}
                    {valid && dueSoon && (
                      <p className={styles.certWarn}>
                        Renew within {cert.daysToExpiry} day{cert.daysToExpiry === 1 ? '' : 's'} to
                        stay in force.
                      </p>
                    )}
                    {shown === 'EXPIRED' && (
                      <p className={styles.certAlert}>
                        Lapsed {Math.abs(cert.daysToExpiry)} day
                        {Math.abs(cert.daysToExpiry) === 1 ? '' : 's'} ago. Using the instrument in
                        trade without a current certificate is an offence.
                      </p>
                    )}
                  </div>

                  <div className={styles.certFooter}>
                    <Link
                      href={`/verify/${encodeURIComponent(cert.certNo)}`}
                      target="_blank"
                      className="clay-btn clay-btn-sm clay-btn-ghost"
                    >
                      <ExternalLink size={14} />
                      Verify
                    </Link>
                    <div className={styles.footerRight}>
                      {isOwner && cert.instrumentId && (lapsed || dueSoon) && (
                        <Link
                          href={`/dashboard/applications/new?instrumentId=${cert.instrumentId}`}
                          className="clay-btn clay-btn-sm clay-btn-secondary"
                        >
                          <RefreshCw size={14} />
                          Renew
                        </Link>
                      )}
                      <button
                        type="button"
                        className="clay-btn clay-btn-sm clay-btn-primary"
                        onClick={() => setOpenId(cert._id)}
                      >
                        Open
                      </button>
                    </div>
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

      {openId && (
        <CertificateDrawer
          certificateId={openId}
          role={role}
          onClose={() => setOpenId(null)}
          onChanged={(message) => {
            setNotice(message);
            void fetchCertificates();
          }}
        />
      )}
    </div>
  );
}

/**
 * `useSearchParams` client-side renders the tree up to the nearest Suspense
 * boundary when the route is prerendered, so the boundary has to exist.
 */
export default function CertificatesPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.loadingWrap}>
          <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
          <p>Loading certificates…</p>
        </div>
      }
    >
      <CertificatesView />
    </Suspense>
  );
}
