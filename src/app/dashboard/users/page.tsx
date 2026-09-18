'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Users,
  Search,
  Filter,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  UserPlus,
  ShieldCheck,
  X,
  Clock,
  Settings2,
  RefreshCw,
} from 'lucide-react';
import {
  ROLES,
  ROLE_LABELS,
  INDIAN_STATES,
  formatDate,
  formatDateTime,
  type Role,
} from '@/lib/constants';
import UserDrawer from './UserDrawer';
import styles from './users.module.css';

/**
 * Departmental account administration.
 *
 * This page rendered a three-row `INITIAL_USERS` constant — "Rajesh Sharma",
 * "Gujarat Calibration Center", "Kishan Trading Corporation" — with a search box
 * that filtered those three. The department's user list was fiction, and the
 * fiction mattered: `/api/auth/register` creates every non-Owner account as
 * `PENDING`, and `canSignIn()` refuses a session to a pending account. With no
 * real list and no approve action, an officer who registered could never sign in
 * and no screen in the product could tell anyone why.
 *
 * It now reads `/api/users`, which scopes the list to the administrator's own
 * state unless they are a system Admin, and every action goes to
 * `PATCH /api/users/[id]`: approve, reject with a reason, deactivate, reactivate,
 * reset a password. There is no delete — officers are named on inspections and
 * signed certificates, so accounts are deactivated and the history stays intact.
 */

interface UserRow {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: Role;
  roleLabel: string;
  state?: string;
  district?: string;
  additionalDistricts?: string[];
  organizationName?: string;
  officerCode?: string;
  designation?: string;
  isActive: boolean;
  isEmailVerified?: boolean;
  isPhoneVerified?: boolean;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  rejectionReason?: string;
  lastLoginAt?: string;
  createdAt: string;
  canSignIn: boolean;
}

interface ListPayload {
  success: boolean;
  error?: string;
  users?: UserRow[];
  total?: number;
  pendingCount?: number;
  countsByRole?: Record<string, number>;
  scope?: string;
  grantableRoles?: Role[];
}

const PAGE_SIZE = 25;

const APPROVAL_LABELS: Record<string, string> = {
  PENDING: 'Awaiting approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

/** A password an administrator hands over once and the officer then changes. */
function suggestPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789#@$%';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export default function UsersManagementPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [countsByRole, setCountsByRole] = useState<Record<string, number>>({});
  const [scope, setScope] = useState('');
  const [grantable, setGrantable] = useState<Role[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('all');
  const [approval, setApproval] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [page, setPage] = useState(1);

  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const fetchUsers = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (role !== 'all') params.set('role', role);
    if (approval !== 'all') params.set('approvalStatus', approval);
    if (stateFilter !== 'all') params.set('state', stateFilter);
    if (search) params.set('search', search);

    try {
      const res = await fetch(`/api/users?${params.toString()}`);
      const data = (await res.json()) as ListPayload;

      if (!data.success) {
        setError(data.error || 'The account list could not be loaded.');
        return;
      }

      setError(null);
      setUsers(data.users ?? []);
      setTotal(data.total ?? 0);
      setPendingCount(data.pendingCount ?? 0);
      setCountsByRole(data.countsByRole ?? {});
      setScope(data.scope ?? '');
      setGrantable(data.grantableRoles ?? []);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [page, role, approval, stateFilter, search]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchUsers();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchUsers]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const national = scope === 'national';

  /** Approving is one click: it is the action an administrator is here to take. */
  async function approve(u: UserRow) {
    setNotice(null);
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      const data = (await res.json()) as { success: boolean; error?: string; message?: string };
      if (!data.success) {
        setError(data.error || 'The account could not be approved.');
        return;
      }
      setError(null);
      setNotice(data.message ?? `${u.name} can now sign in.`);
      await fetchUsers();
    } catch {
      setError('Could not reach the server. The account has not been approved.');
    }
  }

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading accounts…</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>User Management</h1>
          <p>
            {total} account{total === 1 ? '' : 's'} ·{' '}
            {national ? 'all states' : `${scope || 'your state'} only`}
          </p>
        </div>
        <button
          type="button"
          className="clay-btn clay-btn-primary"
          onClick={() => setShowNew((v) => !v)}
        >
          {showNew ? <X size={18} /> : <UserPlus size={18} />}
          {showNew ? 'Close' : 'Provision account'}
        </button>
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

      {showNew && (
        <ProvisionForm
          grantable={grantable}
          fixedState={national ? undefined : scope}
          onDone={async (message) => {
            setShowNew(false);
            setNotice(message);
            await fetchUsers();
          }}
        />
      )}

      {/*
        * Pending accounts are the only ones with somebody waiting on the other
        * end, so they get their own chip and it comes first.
        */}
      <div className={styles.statusChips}>
        <button
          type="button"
          className={`${styles.chip} ${approval === 'PENDING' ? styles.chipActive : ''}`}
          onClick={() => {
            setApproval('PENDING');
            setPage(1);
          }}
        >
          <Clock size={14} />
          Awaiting approval
          <span className={styles.chipCount}>{pendingCount}</span>
        </button>
        {['all', 'APPROVED', 'REJECTED'].map((key) => (
          <button
            key={key}
            type="button"
            className={`${styles.chip} ${approval === key ? styles.chipActive : ''}`}
            onClick={() => {
              setApproval(key);
              setPage(1);
            }}
          >
            {key === 'all' ? 'All accounts' : APPROVAL_LABELS[key]}
          </button>
        ))}
      </div>

      <div className={styles.filters}>
        <div className={styles.searchBar}>
          <Search size={18} />
          <input
            type="text"
            placeholder="Search by name, email, phone, officer code or business…"
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
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              setPage(1);
            }}
            style={{ padding: '10px 38px 10px 14px', fontSize: '0.85rem' }}
            aria-label="Filter by role"
          >
            <option value="all">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
                {countsByRole[r] ? ` (${countsByRole[r]})` : ''}
              </option>
            ))}
          </select>
        </div>

        {national && (
          <div className={styles.filterGroup}>
            <select
              className="clay-input clay-select"
              value={stateFilter}
              onChange={(e) => {
                setStateFilter(e.target.value);
                setPage(1);
              }}
              style={{ padding: '10px 38px 10px 14px', fontSize: '0.85rem' }}
              aria-label="Filter by state"
            >
              <option value="all">All states</option>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {users.length === 0 ? (
        <div className={styles.emptyState}>
          <Users size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>No accounts found</h3>
          <p>Nothing matches these filters.</p>
        </div>
      ) : (
        <>
          <div className="clay-table-wrapper">
            <table className="clay-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Role</th>
                  <th>Jurisdiction</th>
                  <th>Sign-in</th>
                  <th>Last signed in</th>
                  <th>Manage</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const extra = u.additionalDistricts?.length ?? 0;
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className={styles.cellStrong}>
                          {u.organizationName || u.name}
                        </div>
                        <div className={styles.cellSub}>
                          {u.email}
                          {u.isEmailVerified ? '' : ' · unverified'}
                        </div>
                        {u.phone && (
                          <div className={styles.cellSub}>
                            {u.phone}
                            {u.isPhoneVerified ? '' : ' · unverified'}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="clay-badge clay-badge-primary">{u.roleLabel}</span>
                        {(u.designation || u.officerCode) && (
                          <div className={styles.cellSub}>
                            {[u.designation, u.officerCode].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className={styles.cellStrong}>{u.state || '—'}</div>
                        <div className={styles.cellSub}>
                          {u.district || 'No district'}
                          {extra > 0 ? ` +${extra} more` : ''}
                        </div>
                      </td>
                      <td>
                        {u.canSignIn ? (
                          <span className="clay-badge clay-badge-success">Can sign in</span>
                        ) : u.approvalStatus === 'PENDING' ? (
                          <span className="clay-badge clay-badge-warning">Awaiting approval</span>
                        ) : u.approvalStatus === 'REJECTED' ? (
                          <span className="clay-badge clay-badge-error">Rejected</span>
                        ) : (
                          <span className="clay-badge clay-badge-charcoal">Deactivated</span>
                        )}
                        {u.approvalStatus === 'REJECTED' && u.rejectionReason && (
                          <div className={styles.cellSub}>{u.rejectionReason}</div>
                        )}
                      </td>
                      <td>
                        {u.lastLoginAt ? (
                          <span className={styles.cellSub}>{formatDateTime(u.lastLoginAt)}</span>
                        ) : (
                          <span className={styles.muted}>
                            Never · registered {formatDate(u.createdAt)}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className={styles.rowActions}>
                          {u.approvalStatus === 'PENDING' && (
                            <button
                              type="button"
                              className="clay-btn clay-btn-sm clay-btn-primary"
                              onClick={() => void approve(u)}
                            >
                              <ShieldCheck size={15} />
                              Approve
                            </button>
                          )}
                          <button
                            type="button"
                            className="clay-btn clay-btn-sm clay-btn-outline"
                            onClick={() => setOpenId(u.id)}
                          >
                            <Settings2 size={15} />
                            Manage
                          </button>
                        </div>
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

      {openId && (
        <UserDrawer
          userId={openId}
          canSetState={national}
          onClose={() => setOpenId(null)}
          onChanged={async (message: string, closed?: boolean) => {
            setNotice(message);
            if (closed) setOpenId(null);
            await fetchUsers();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Provisioning
 * ------------------------------------------------------------------ */

function ProvisionForm({
  grantable,
  fixedState,
  onDone,
}: {
  grantable: Role[];
  /** A StateAdmin provisions into their own state and nowhere else. */
  fixedState?: string;
  onDone: (message: string) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: (grantable.find((r) => r === 'LMO') ?? grantable[0] ?? 'LMO') as Role,
    phone: '',
    state: fixedState ?? '',
    district: '',
    officerCode: '',
    designation: '',
    organizationName: '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [revealed, setRevealed] = useState(false);

  const set = (k: keyof typeof form, v: string) => setForm((prev) => ({ ...prev, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          phone: form.phone || undefined,
          state: form.state || undefined,
          district: form.district || undefined,
          officerCode: form.officerCode || undefined,
          designation: form.designation || undefined,
          organizationName: form.organizationName || undefined,
        }),
      });
      const data = (await res.json()) as { success: boolean; error?: string; message?: string };
      if (!data.success) {
        setErr(data.error || 'The account could not be created.');
        return;
      }
      await onDone(data.message ?? `${form.name} can now sign in.`);
    } catch {
      setErr('Could not reach the server. Nothing has been created.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className={styles.panel}>
      <h2>
        <UserPlus size={16} />
        Provision a departmental account
      </h2>
      <p className={styles.panelNote}>
        This is how an officer or GATC technician is meant to get an account: created by somebody who
        knows who they are, approved on the spot. Self-registration leaves them waiting.
      </p>

      {err && (
        <div className={styles.errorBox}>
          <AlertTriangle size={16} />
          <span>{err}</span>
        </div>
      )}

      <div className={styles.formGrid}>
        <div className="clay-input-group">
          <label className="clay-label">Full name *</label>
          <input
            className="clay-input"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            required
          />
        </div>
        <div className="clay-input-group">
          <label className="clay-label">Email address *</label>
          <input
            type="email"
            className="clay-input"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            required
          />
        </div>
        <div className="clay-input-group">
          <label className="clay-label">Role *</label>
          <select
            className="clay-input clay-select"
            value={form.role}
            onChange={(e) => set('role', e.target.value)}
          >
            {grantable.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="clay-input-group">
          <label className="clay-label">Initial password *</label>
          <div className={styles.inlineField}>
            <input
              type={revealed ? 'text' : 'password'}
              className="clay-input"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              minLength={10}
              required
            />
            <button
              type="button"
              className="clay-btn clay-btn-sm clay-btn-outline"
              onClick={() => {
                set('password', suggestPassword());
                setRevealed(true);
              }}
            >
              <RefreshCw size={14} />
              Generate
            </button>
          </div>
          <span className={styles.hint}>
            At least 10 characters. Hand it over once — they should change it at first sign-in.
          </span>
        </div>
        <div className="clay-input-group">
          <label className="clay-label">Phone (optional)</label>
          <input
            className="clay-input"
            placeholder="+919876543210"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
        </div>
        <div className="clay-input-group">
          <label className="clay-label">State {form.role === 'Admin' ? '' : '*'}</label>
          {fixedState ? (
            <input className="clay-input" value={fixedState} readOnly />
          ) : (
            <select
              className="clay-input clay-select"
              value={form.state}
              onChange={(e) => set('state', e.target.value)}
            >
              <option value="">Select a state</option>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="clay-input-group">
          <label className="clay-label">District</label>
          <input
            className="clay-input"
            value={form.district}
            onChange={(e) => set('district', e.target.value)}
          />
        </div>
        {form.role === 'Owner' ? (
          <div className="clay-input-group">
            <label className="clay-label">Business name</label>
            <input
              className="clay-input"
              value={form.organizationName}
              onChange={(e) => set('organizationName', e.target.value)}
            />
          </div>
        ) : (
          <>
            <div className="clay-input-group">
              <label className="clay-label">Officer / centre code</label>
              <input
                className="clay-input"
                value={form.officerCode}
                onChange={(e) => set('officerCode', e.target.value)}
              />
            </div>
            <div className="clay-input-group">
              <label className="clay-label">Designation</label>
              <input
                className="clay-input"
                placeholder="e.g. Inspector of Legal Metrology"
                value={form.designation}
                onChange={(e) => set('designation', e.target.value)}
              />
            </div>
          </>
        )}
      </div>

      <div className={styles.panelActions}>
        <button type="submit" className="clay-btn clay-btn-primary" disabled={saving}>
          {saving ? <Loader2 size={17} className={styles.spin} /> : <UserPlus size={17} />}
          Create account
        </button>
      </div>
    </form>
  );
}
