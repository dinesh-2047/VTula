'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FlaskConical,
  Loader2,
  Search,
  ShieldAlert,
  UserCheck,
  X,
} from 'lucide-react';
import {
  EXPIRING_SOON_WINDOW_DAYS,
  formatDate,
  formatDateTime,
  type Role,
} from '@/lib/constants';
import styles from './gatc.module.css';

/**
 * Government Approved Test Centre administration.
 *
 * The previous page was titled the same and did something else entirely, on top
 * of three faults that each made it useless on its own.
 *
 * It read `data.applications` from `GET /api/tasks`, which returns `tasks`. The
 * key had never existed, so `tests` was always `[]` and the page rendered its
 * empty state no matter how much work was queued.
 *
 * Its one button — "Perform Lab Test & Certify" — posted to `POST /api/tasks`,
 * a handler that no longer exists (the route is read-only; acting on a task goes
 * through `/api/inspections`, `/api/schedules` or the transition endpoint). Had
 * it existed, the request it sent was worse than a dead one: it hardcoded
 * `verdict: 'Approve'`, the remark "GATC Calibration test passed within ISO/IEC
 * 17025 tolerances", and a stamp number from `Math.random()` — a pass certificate
 * for an instrument nobody had measured. Recording an actual calibration, with
 * readings checked against the rule's tolerance table and traceable standards, is
 * what the lab queue at `/dashboard/tasks` is for.
 *
 * And it compared `t.status === 'Approved'` against an enum whose values are
 * SCREAMING_SNAKE, so no card could ever leave the pending state.
 *
 * What an administrator actually needs from a page called GATC Management is the
 * accreditation register: which centres and technicians exist, whether their
 * ISO/IEC 17025 accreditation is still valid, and which are waiting on approval
 * before they can sign in. All of that is on the `User` record and editable
 * through `PATCH /api/users/[id]`, so that is what this page now is.
 */

const GATC_ROLES: Role[] = ['GATC', 'GATCTechnician'];

/** One page of 100 × ten pages. Stated in the UI if it is ever reached. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

type AccreditationState = 'VALID' | 'DUE' | 'LAPSED' | 'MISSING';

const ACCREDITATION_LABEL: Record<AccreditationState, { text: string; badge: string }> = {
  VALID: { text: 'Accredited', badge: 'clay-badge-success' },
  DUE: { text: 'Renewal due', badge: 'clay-badge-warning' },
  LAPSED: { text: 'Lapsed', badge: 'clay-badge-error' },
  MISSING: { text: 'Not recorded', badge: 'clay-badge-charcoal' },
};

interface ApiUser {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: Role;
  roleLabel: string;
  state?: string;
  district?: string;
  additionalDistricts?: string[];
  officerCode?: string;
  designation?: string;
  accreditationNo?: string;
  accreditationValidUntil?: string;
  categoriesApproved?: string[];
  isActive: boolean;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  canSignIn: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

/** An `ApiUser` with its accreditation state resolved against the load time. */
interface Centre extends ApiUser {
  accreditation: AccreditationState;
  daysLeft: number | null;
}

interface Summary {
  centres: number;
  technicians: number;
  valid: number;
  due: number;
  lapsed: number;
  missing: number;
  pending: number;
  inactive: number;
}

interface View {
  rows: Centre[];
  summary: Summary;
  scope: string;
  truncated: boolean;
}

type Filter = 'all' | 'centres' | 'technicians' | 'pending' | 'due' | 'lapsed' | 'inactive';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'centres', label: 'Centres' },
  { value: 'technicians', label: 'Technicians' },
  { value: 'pending', label: 'Awaiting approval' },
  { value: 'due', label: 'Renewal due' },
  { value: 'lapsed', label: 'Lapsed' },
  { value: 'inactive', label: 'Deactivated' },
];

/*
 * Derived once, when the data arrives, rather than during render: reading the
 * clock while rendering makes the same state produce different output on a
 * re-render, and React's compiler rejects it.
 */
function classify(u: ApiUser, now: number): { accreditation: AccreditationState; daysLeft: number | null } {
  if (!u.accreditationValidUntil) return { accreditation: 'MISSING', daysLeft: null };
  const until = new Date(u.accreditationValidUntil).getTime();
  if (Number.isNaN(until)) return { accreditation: 'MISSING', daysLeft: null };
  const daysLeft = Math.ceil((until - now) / 86_400_000);
  if (daysLeft < 0) return { accreditation: 'LAPSED', daysLeft };
  if (daysLeft <= EXPIRING_SOON_WINDOW_DAYS) return { accreditation: 'DUE', daysLeft };
  return { accreditation: 'VALID', daysLeft };
}

export default function GatcManagementPage() {
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Centre | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  /*
   * `/api/users` filters by a single role, so the two GATC roles are two
   * requests. Both are paged out in full rather than reading page one and
   * treating its length as a total — the mistake that made every figure on the
   * old reports page a page size.
   */
  const fetchCentres = useCallback(async () => {
    setLoading(true);
    try {
      const all: ApiUser[] = [];
      let scope = '';
      let truncated = false;

      for (const role of GATC_ROLES) {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const qs = new URLSearchParams({
            role,
            limit: String(PAGE_SIZE),
            page: String(page),
          });
          if (search) qs.set('search', search);

          const res = await fetch(`/api/users?${qs.toString()}`);
          if (res.status === 403) {
            setForbidden(true);
            return;
          }
          const data = (await res.json()) as {
            success: boolean;
            error?: string;
            users?: ApiUser[];
            pages?: number;
            scope?: string;
          };
          if (!data.success) {
            setError(data.error ?? 'The accreditation register could not be loaded.');
            return;
          }
          all.push(...(data.users ?? []));
          if (data.scope) scope = data.scope;

          const pages = data.pages ?? 1;
          if (page >= pages) break;
          if (page === MAX_PAGES && pages > MAX_PAGES) truncated = true;
        }
      }

      const now = Date.now();
      const rows: Centre[] = all
        .map((u) => ({ ...u, ...classify(u, now) }))
        .sort((a, b) => {
          // Anything blocking someone comes first: unapproved, then lapsed.
          const rank = (c: Centre) =>
            c.approvalStatus === 'PENDING'
              ? 0
              : c.accreditation === 'LAPSED'
                ? 1
                : c.accreditation === 'DUE'
                  ? 2
                  : 3;
          return rank(a) - rank(b) || a.name.localeCompare(b.name);
        });

      setError(null);
      setForbidden(false);
      setView({
        rows,
        scope: scope || 'your jurisdiction',
        truncated,
        summary: {
          centres: rows.filter((r) => r.role === 'GATC').length,
          technicians: rows.filter((r) => r.role === 'GATCTechnician').length,
          valid: rows.filter((r) => r.accreditation === 'VALID').length,
          due: rows.filter((r) => r.accreditation === 'DUE').length,
          lapsed: rows.filter((r) => r.accreditation === 'LAPSED').length,
          missing: rows.filter((r) => r.accreditation === 'MISSING').length,
          pending: rows.filter((r) => r.approvalStatus === 'PENDING').length,
          inactive: rows.filter((r) => !r.isActive).length,
        },
      });
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchCentres();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchCentres]);

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading the accreditation register…</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className={styles.gate}>
        <ShieldAlert size={40} style={{ color: 'var(--text-muted)' }} />
        <h2>GATC management</h2>
        <p>
          Accreditation records are limited to State and System Administrators. If you work at a
          test centre, your calibration queue is on the Lab Tasks page.
        </p>
        <Link href="/dashboard/tasks" className="clay-btn clay-btn-primary clay-btn-sm">
          <ClipboardCheck size={16} /> Go to Lab Tasks
        </Link>
      </div>
    );
  }

  if (!view) {
    return (
      <div className={styles.page}>
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error ?? 'The accreditation register could not be loaded.'}</span>
        </div>
      </div>
    );
  }

  const { rows, summary } = view;

  const visible = rows.filter((r) => {
    switch (filter) {
      case 'centres':
        return r.role === 'GATC';
      case 'technicians':
        return r.role === 'GATCTechnician';
      case 'pending':
        return r.approvalStatus === 'PENDING';
      case 'due':
        return r.accreditation === 'DUE';
      case 'lapsed':
        return r.accreditation === 'LAPSED' || r.accreditation === 'MISSING';
      case 'inactive':
        return !r.isActive;
      default:
        return true;
    }
  });

  const counts: Record<Filter, number> = {
    all: rows.length,
    centres: summary.centres,
    technicians: summary.technicians,
    pending: summary.pending,
    due: summary.due,
    lapsed: summary.lapsed + summary.missing,
    inactive: summary.inactive,
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Government Approved Test Centres</h1>
          <p>
            Accreditation register for {view.scope === 'national' ? 'all states' : view.scope}.
            Calibration work itself is recorded against an application in the lab queue, where the
            readings are checked against the rule&rsquo;s tolerance table.
          </p>
        </div>
        <Link href="/dashboard/tasks" className="clay-btn clay-btn-outline clay-btn-sm">
          <ClipboardCheck size={16} /> Lab queue
        </Link>
      </div>

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      )}

      {view.truncated && (
        <div className={styles.warnBox}>
          <AlertTriangle size={17} />
          <span>
            More than {MAX_PAGES * PAGE_SIZE} accounts match. The figures below cover the first{' '}
            {MAX_PAGES * PAGE_SIZE}; search by name, email or officer code to narrow the register.
          </span>
        </div>
      )}

      {/* Whichever of these is non-zero is somebody who cannot work today. */}
      {(summary.lapsed > 0 || summary.pending > 0) && (
        <div className={styles.warnBox}>
          <AlertTriangle size={17} />
          <span>
            {summary.lapsed > 0 && (
              <>
                {summary.lapsed} account{summary.lapsed === 1 ? '' : 's'} have lapsed accreditation
                and should not be assigned calibration work.
              </>
            )}
            {summary.lapsed > 0 && summary.pending > 0 && ' '}
            {summary.pending > 0 && (
              <>
                {summary.pending} account{summary.pending === 1 ? '' : 's'} cannot sign in until an
                administrator approves them.
              </>
            )}
          </span>
        </div>
      )}

      <div className={styles.metricsGrid}>
        <div className={styles.metricCard}>
          <div className={styles.metricIcon} style={{ background: 'var(--surface-warm)' }}>
            <Building2 size={22} style={{ color: 'var(--color-primary)' }} />
          </div>
          <div className={styles.metricVal}>{summary.centres}</div>
          <div className={styles.metricLabel}>Test centres</div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricIcon} style={{ background: 'var(--status-info-bg)' }}>
            <FlaskConical size={22} style={{ color: 'var(--status-info)' }} />
          </div>
          <div className={styles.metricVal}>{summary.technicians}</div>
          <div className={styles.metricLabel}>Technicians</div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricIcon} style={{ background: 'var(--status-success-bg)' }}>
            <CheckCircle2 size={22} style={{ color: 'var(--status-success)' }} />
          </div>
          <div className={styles.metricVal}>{summary.valid}</div>
          <div className={styles.metricLabel}>Accreditation in date</div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricIcon} style={{ background: 'var(--status-warning-bg)' }}>
            <CalendarClock size={22} style={{ color: 'var(--status-warning)' }} />
          </div>
          <div className={styles.metricVal}>{summary.due + summary.lapsed + summary.missing}</div>
          <div className={styles.metricLabel}>
            Needs attention · {summary.due} due, {summary.lapsed} lapsed, {summary.missing} not
            recorded
          </div>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.searchBar}>
          <Search size={17} />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name, email, phone or officer code…"
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

        <div className={styles.chips}>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`${styles.chip} ${filter === f.value ? styles.chipActive : ''}`}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
            >
              {f.label} <span className={styles.chipCount}>{counts[f.value]}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className={styles.emptyState}>
          <Building2 size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>{rows.length === 0 ? 'No test centres provisioned' : 'Nothing matches'}</h3>
          <p>
            {rows.length === 0
              ? 'GATC administrators and technicians are provisioned from User Management, not by self-registration. Once created, their accreditation appears here.'
              : 'No account in the register matches this filter.'}
          </p>
          {rows.length === 0 && (
            <Link href="/dashboard/users" className="clay-btn clay-btn-primary clay-btn-sm">
              <UserCheck size={16} /> Provision an account
            </Link>
          )}
        </div>
      ) : (
        <div className="clay-table-wrapper">
          <table className="clay-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Role</th>
                <th>Accreditation</th>
                <th>Valid until</th>
                <th>Jurisdiction</th>
                <th>Access</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => {
                const acc = ACCREDITATION_LABEL[c.accreditation];
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className={styles.subCell}>{c.email}</div>
                      {c.designation && <div className={styles.subCell}>{c.designation}</div>}
                    </td>
                    <td>
                      <span className={styles.roleCell}>{c.roleLabel}</span>
                      {c.officerCode && <div className={styles.subCell}>{c.officerCode}</div>}
                    </td>
                    <td>
                      <span className={`clay-badge ${acc.badge}`}>{acc.text}</span>
                      {c.accreditationNo && (
                        <div className={styles.subCell}>{c.accreditationNo}</div>
                      )}
                      {c.categoriesApproved && c.categoriesApproved.length > 0 && (
                        <div className={styles.subCell}>
                          {c.categoriesApproved.length} categor
                          {c.categoriesApproved.length === 1 ? 'y' : 'ies'} approved
                        </div>
                      )}
                    </td>
                    <td>
                      {c.accreditationValidUntil ? (
                        <>
                          {formatDate(c.accreditationValidUntil)}
                          {c.daysLeft !== null && (
                            <div className={styles.subCell}>
                              {c.daysLeft < 0
                                ? `${Math.abs(c.daysLeft)} days ago`
                                : `${c.daysLeft} days left`}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className={styles.notRecorded}>Not recorded</span>
                      )}
                    </td>
                    <td>
                      {c.district || c.state ? (
                        <>
                          {c.district && <strong>{c.district}</strong>}
                          <div className={styles.subCell}>{c.state}</div>
                          {c.additionalDistricts && c.additionalDistricts.length > 0 && (
                            <div className={styles.subCell}>
                              +{c.additionalDistricts.length} more district
                              {c.additionalDistricts.length === 1 ? '' : 's'}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className={styles.notRecorded}>Not recorded</span>
                      )}
                    </td>
                    <td>
                      {c.approvalStatus === 'PENDING' ? (
                        <span className="clay-badge clay-badge-pending">Awaiting approval</span>
                      ) : c.approvalStatus === 'REJECTED' ? (
                        <span className="clay-badge clay-badge-error">Rejected</span>
                      ) : !c.isActive ? (
                        <span className="clay-badge clay-badge-charcoal">Deactivated</span>
                      ) : (
                        <span className="clay-badge clay-badge-success">Can sign in</span>
                      )}
                      <div className={styles.subCell}>
                        {c.lastLoginAt
                          ? `Last signed in ${formatDateTime(c.lastLoginAt)}`
                          : 'Never signed in'}
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="clay-btn clay-btn-ghost clay-btn-sm"
                        onClick={() => setEditing(c)}
                      >
                        Accreditation
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.footNote}>
        Approving, deactivating and role changes are handled in{' '}
        <Link href="/dashboard/users">User Management</Link>, where each action is recorded against
        the account. Accounts are never deleted — an officer named on an inspection or a signed
        certificate has to stay resolvable.
      </p>

      {editing && (
        <AccreditationModal
          centre={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await fetchCentres();
          }}
        />
      )}
    </div>
  );
}

/**
 * Records an accreditation certificate number and its expiry.
 *
 * `PATCH /api/users/[id]` accepts exactly these two fields and writes an audit
 * entry naming what changed, so this form does not need to (and cannot) touch
 * role, jurisdiction or approval state.
 */
function AccreditationModal({
  centre,
  onClose,
  onSaved,
}: {
  centre: Centre;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [accreditationNo, setAccreditationNo] = useState(centre.accreditationNo ?? '');
  const [validUntil, setValidUntil] = useState(
    centre.accreditationValidUntil ? centre.accreditationValidUntil.slice(0, 10) : ''
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${centre.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accreditationNo: accreditationNo.trim(),
          // An empty string clears the date, which is how a withdrawn
          // accreditation is recorded.
          accreditationValidUntil: validUntil || '',
        }),
      });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (!data.success) {
        setError(data.error ?? 'The accreditation could not be saved.');
        return;
      }
      await onSaved();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const unchanged =
    accreditationNo.trim() === (centre.accreditationNo ?? '') &&
    validUntil === (centre.accreditationValidUntil?.slice(0, 10) ?? '');

  return (
    <div className="clay-modal-overlay" onClick={onClose}>
      <div className="clay-modal" onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div>
            <h3>Accreditation</h3>
            <p>
              {centre.name} · {centre.roleLabel}
            </p>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className={styles.errorBox}>
            <AlertTriangle size={17} />
            <span>{error}</span>
          </div>
        )}

        <label className="clay-label" htmlFor="accNo">
          Accreditation certificate number
        </label>
        <input
          id="accNo"
          className="clay-input"
          value={accreditationNo}
          onChange={(e) => setAccreditationNo(e.target.value)}
          placeholder="e.g. NABL-TC-1234"
        />

        <label className="clay-label" htmlFor="accUntil" style={{ marginTop: 16 }}>
          Valid until
        </label>
        <input
          id="accUntil"
          type="date"
          className="clay-input"
          value={validUntil}
          onChange={(e) => setValidUntil(e.target.value)}
        />
        <p className={styles.modalHint}>
          Leave blank to record that the accreditation has been withdrawn. Once the date passes, the
          account is listed as lapsed here — it does not stop the account signing in, so deactivate
          it in User Management if the centre must stop work.
        </p>

        <div className={styles.modalActions}>
          <button type="button" className="clay-btn clay-btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="clay-btn clay-btn-primary"
            onClick={save}
            disabled={busy || unchanged}
          >
            {busy ? <Loader2 size={17} className={styles.spin} /> : null}
            {busy ? 'Saving…' : 'Save accreditation'}
          </button>
        </div>
      </div>
    </div>
  );
}
