'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  X,
  Loader2,
  AlertTriangle,
  ShieldCheck,
  ShieldX,
  Ban,
  RotateCcw,
  KeyRound,
  Save,
  Briefcase,
  FileText,
  Gauge,
  ClipboardCheck,
} from 'lucide-react';
import {
  ROLE_LABELS,
  INDIAN_STATES,
  formatDate,
  formatDateTime,
  type Role,
} from '@/lib/constants';
import styles from './users.module.css';

/**
 * Everything an administrator can do to one account, in one panel.
 *
 * The actions map one-for-one onto `PATCH /api/users/[id]`, including the parts
 * that refuse: the route will not let an administrator act on their own account,
 * will not deactivate an officer who still holds open applications unless
 * `force` is sent, and has no DELETE. So this panel shows the workload *before*
 * offering to deactivate, and turns the `HAS_OPEN_WORK` conflict into a second,
 * deliberate button rather than swallowing it.
 */

export interface UserDetail {
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
  accreditationNo?: string;
  accreditationValidUntil?: string;
  isActive: boolean;
  isEmailVerified?: boolean;
  isPhoneVerified?: boolean;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  rejectionReason?: string;
  approvedByName?: string;
  approvedAt?: string;
  lastLoginAt?: string;
  createdAt: string;
  canSignIn: boolean;
}

interface Workload {
  openApplications: number;
  instrumentsOwned: number;
  inspectionsSigned: number;
}

interface ActionResult {
  success: boolean;
  error?: string;
  code?: string;
  message?: string;
}

const ACCREDITED_ROLES: Role[] = ['GATC', 'GATCTechnician'];

export default function UserDrawer({
  userId,
  canSetState,
  onClose,
  onChanged,
}: {
  userId: string;
  /** Only a national Admin may move an account between states. */
  canSetState: boolean;
  onClose: () => void;
  onChanged: (message: string, closed?: boolean) => Promise<void>;
}) {
  const [user, setUser] = useState<UserDetail | null>(null);
  const [workload, setWorkload] = useState<Workload | null>(null);
  const [grantable, setGrantable] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Set when the API refuses because the officer still holds live work. */
  const [openWorkBlock, setOpenWorkBlock] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [deactivateReason, setDeactivateReason] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [showDeactivate, setShowDeactivate] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/users/${userId}`);
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        user?: UserDetail;
        workload?: Workload;
        grantableRoles?: Role[];
      };
      if (!data.success || !data.user) {
        setError(data.error || 'This account could not be loaded.');
        return;
      }
      setError(null);
      setUser(data.user);
      setWorkload(data.workload ?? null);
      setGrantable(data.grantableRoles ?? []);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

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

  const patch = useCallback(
    async (body: Record<string, unknown>): Promise<ActionResult> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/users/${userId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return (await res.json()) as ActionResult;
      } catch {
        return { success: false, error: 'Could not reach the server. Nothing was changed.' };
      } finally {
        setBusy(false);
      }
    },
    [userId]
  );

  async function run(body: Record<string, unknown>, fallback: string, close = false) {
    const data = await patch(body);
    if (!data.success) {
      // `HAS_OPEN_WORK` is not a failure to hide — it is the route telling the
      // administrator that work would be stranded. Offer the override explicitly.
      if (data.code === 'HAS_OPEN_WORK') {
        setOpenWorkBlock(data.error ?? 'This officer still has open applications.');
        return;
      }
      setError(data.error ?? 'The change could not be saved.');
      return;
    }
    setOpenWorkBlock(null);
    await onChanged(data.message ?? fallback, close);
    if (!close) await load();
  }

  return (
    <div className={styles.drawerBackdrop} onClick={onClose} role="presentation">
      <aside
        className={styles.drawer}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Manage account"
      >
        <div className={styles.drawerHeader}>
          <div>
            <h2>{user ? user.organizationName || user.name : 'Account'}</h2>
            {user && <p>{user.email}</p>}
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        </div>

        <div className={styles.drawerBody}>
          {loading ? (
            <div className={styles.drawerLoading}>
              <Loader2 size={28} className={styles.spin} />
              <p>Loading account…</p>
            </div>
          ) : !user ? (
            <div className={styles.errorBox}>
              <AlertTriangle size={16} />
              <span>{error ?? 'This account could not be loaded.'}</span>
            </div>
          ) : (
            <>
              {error && (
                <div className={styles.errorBox}>
                  <AlertTriangle size={16} />
                  <span>{error}</span>
                </div>
              )}

              <div className={styles.drawerFacts}>
                <div>
                  <span>Role</span>
                  <strong>{user.roleLabel}</strong>
                </div>
                <div>
                  <span>Jurisdiction</span>
                  <strong>
                    {[user.district, user.state].filter(Boolean).join(', ') || 'Not set'}
                  </strong>
                </div>
                <div>
                  <span>Sign-in</span>
                  <strong>
                    {user.canSignIn
                      ? 'Allowed'
                      : user.approvalStatus === 'PENDING'
                        ? 'Blocked — awaiting approval'
                        : user.approvalStatus === 'REJECTED'
                          ? 'Blocked — rejected'
                          : 'Blocked — deactivated'}
                  </strong>
                </div>
                <div>
                  <span>Registered</span>
                  <strong>{formatDate(user.createdAt)}</strong>
                </div>
                <div>
                  <span>Last signed in</span>
                  <strong>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}</strong>
                </div>
                {user.approvedByName && (
                  <div>
                    <span>Decided by</span>
                    <strong>
                      {user.approvedByName}
                      {user.approvedAt ? ` · ${formatDate(user.approvedAt)}` : ''}
                    </strong>
                  </div>
                )}
              </div>

              {user.approvalStatus === 'REJECTED' && user.rejectionReason && (
                <div className={styles.reasonBox}>
                  <strong>Reason given:</strong> {user.rejectionReason}
                </div>
              )}

              {/* What deactivating or re-roling this account would strand. */}
              {workload && (
                <div className={styles.workload}>
                  <div className={styles.workloadItem}>
                    <FileText size={16} />
                    <div>
                      <strong>{workload.openApplications}</strong>
                      <span>open applications assigned</span>
                    </div>
                  </div>
                  <div className={styles.workloadItem}>
                    <Gauge size={16} />
                    <div>
                      <strong>{workload.instrumentsOwned}</strong>
                      <span>instruments owned</span>
                    </div>
                  </div>
                  <div className={styles.workloadItem}>
                    <ClipboardCheck size={16} />
                    <div>
                      <strong>{workload.inspectionsSigned}</strong>
                      <span>inspections signed</span>
                    </div>
                  </div>
                </div>
              )}

              {openWorkBlock && (
                <div className={styles.warnBox}>
                  <AlertTriangle size={16} />
                  <div>
                    <p>{openWorkBlock}</p>
                    <button
                      type="button"
                      className="clay-btn clay-btn-sm clay-btn-outline"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          {
                            action: 'deactivate',
                            reason: deactivateReason.trim(),
                            force: true,
                          },
                          `${user.name} can no longer sign in.`,
                          true
                        )
                      }
                    >
                      <Ban size={15} />
                      Deactivate anyway
                    </button>
                  </div>
                </div>
              )}

              {/* ── Approval ── */}
              {user.approvalStatus === 'PENDING' && (
                <section className={styles.drawerSection}>
                  <h3>
                    <ShieldCheck size={15} />
                    Approval
                  </h3>
                  <p className={styles.sectionNote}>
                    This account cannot sign in until it is approved. Approving confirms this person
                    holds the role they registered for.
                  </p>
                  <div className={styles.sectionActions}>
                    <button
                      type="button"
                      className="clay-btn clay-btn-primary clay-btn-sm"
                      disabled={busy}
                      onClick={() =>
                        void run({ action: 'approve' }, `${user.name} can now sign in.`, true)
                      }
                    >
                      <ShieldCheck size={15} />
                      Approve
                    </button>
                    <button
                      type="button"
                      className="clay-btn clay-btn-outline clay-btn-sm"
                      onClick={() => setShowReject((v) => !v)}
                    >
                      <ShieldX size={15} />
                      Reject
                    </button>
                  </div>
                  {showReject && (
                    <div className={styles.reasonForm}>
                      <label className="clay-label">
                        Reason — shown to the applicant, so write it for them
                      </label>
                      <textarea
                        className="clay-input"
                        rows={3}
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="e.g. The officer code does not match our records for Rajkot district."
                      />
                      <button
                        type="button"
                        className="clay-btn clay-btn-sm"
                        style={{ background: 'var(--status-error)', color: 'white' }}
                        disabled={busy || rejectReason.trim().length < 5}
                        onClick={() =>
                          void run(
                            { action: 'reject', reason: rejectReason.trim() },
                            `The request from ${user.name} has been rejected.`,
                            true
                          )
                        }
                      >
                        Confirm rejection
                      </button>
                    </div>
                  )}
                </section>
              )}

              {/* ── Details ── */}
              <EditForm
                key={user.id}
                user={user}
                grantable={grantable}
                canSetState={canSetState}
                busy={busy}
                onSave={(body) => run(body, 'Account updated.')}
              />

              {/* ── Password ── */}
              <section className={styles.drawerSection}>
                <h3>
                  <KeyRound size={15} />
                  Password
                </h3>
                <p className={styles.sectionNote}>
                  Resetting also clears any sign-in lockout, which is usually the reason for doing
                  it. The account holder is notified.
                </p>
                {showPassword ? (
                  <div className={styles.reasonForm}>
                    <label className="clay-label">New password (at least 10 characters)</label>
                    <input
                      type="text"
                      className="clay-input"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="clay-btn clay-btn-sm clay-btn-secondary"
                      disabled={busy || newPassword.length < 10}
                      onClick={async () => {
                        await run(
                          { action: 'reset-password', newPassword },
                          `Password reset for ${user.name}.`
                        );
                        setNewPassword('');
                        setShowPassword(false);
                      }}
                    >
                      <KeyRound size={15} />
                      Reset password
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="clay-btn clay-btn-outline clay-btn-sm"
                    onClick={() => setShowPassword(true)}
                  >
                    <KeyRound size={15} />
                    Reset password
                  </button>
                )}
              </section>

              {/* ── Access ── */}
              <section className={styles.drawerSection}>
                <h3>
                  <Briefcase size={15} />
                  Access
                </h3>
                {user.isActive ? (
                  <>
                    <p className={styles.sectionNote}>
                      Deactivating stops sign-in. Nothing is deleted — inspections and certificates
                      this account signed stay on record, because they carry legal weight.
                    </p>
                    {showDeactivate ? (
                      <div className={styles.reasonForm}>
                        <label className="clay-label">Reason (recorded in the audit log)</label>
                        <textarea
                          className="clay-input"
                          rows={2}
                          value={deactivateReason}
                          onChange={(e) => setDeactivateReason(e.target.value)}
                          placeholder="e.g. Transferred to Bhavnagar office on 1 April."
                        />
                        <button
                          type="button"
                          className="clay-btn clay-btn-sm"
                          style={{ background: 'var(--status-error)', color: 'white' }}
                          disabled={busy || deactivateReason.trim().length < 5}
                          onClick={() =>
                            void run(
                              { action: 'deactivate', reason: deactivateReason.trim() },
                              `${user.name} can no longer sign in.`,
                              true
                            )
                          }
                        >
                          <Ban size={15} />
                          Deactivate account
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="clay-btn clay-btn-outline clay-btn-sm"
                        onClick={() => setShowDeactivate(true)}
                      >
                        <Ban size={15} />
                        Deactivate account
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <p className={styles.sectionNote}>
                      This account is deactivated and cannot sign in.
                    </p>
                    <button
                      type="button"
                      className="clay-btn clay-btn-primary clay-btn-sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          { action: 'reactivate' },
                          `${user.name} can sign in again.`,
                          true
                        )
                      }
                    >
                      <RotateCcw size={15} />
                      Reactivate account
                    </button>
                  </>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Field edits
 * ------------------------------------------------------------------ */

/**
 * Keyed on the account id by the caller, so the fields initialise from the
 * loaded account once instead of being copied in by an effect.
 */
function EditForm({
  user,
  grantable,
  canSetState,
  busy,
  onSave,
}: {
  user: UserDetail;
  grantable: Role[];
  canSetState: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: user.name,
    phone: user.phone ?? '',
    role: user.role as string,
    state: user.state ?? '',
    district: user.district ?? '',
    additionalDistricts: (user.additionalDistricts ?? []).join(', '),
    officerCode: user.officerCode ?? '',
    designation: user.designation ?? '',
    accreditationNo: user.accreditationNo ?? '',
    accreditationValidUntil: user.accreditationValidUntil
      ? user.accreditationValidUntil.slice(0, 10)
      : '',
  });

  const set = (k: keyof typeof form, v: string) => setForm((prev) => ({ ...prev, [k]: v }));
  const accredited = ACCREDITED_ROLES.includes(form.role as Role);

  /** Only changed fields are sent; the route answers `NO_CHANGES` otherwise. */
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (form.name.trim() !== user.name) body.name = form.name.trim();
    if (form.phone.trim() !== (user.phone ?? '')) body.phone = form.phone.trim();
    if (form.role !== user.role) body.role = form.role;
    if (form.state && form.state !== (user.state ?? '')) body.state = form.state;
    if (form.district.trim() !== (user.district ?? '')) body.district = form.district.trim();

    const districts = form.additionalDistricts
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    if (districts.join(', ') !== (user.additionalDistricts ?? []).join(', ')) {
      body.additionalDistricts = districts;
    }
    if (form.officerCode.trim() !== (user.officerCode ?? '')) {
      body.officerCode = form.officerCode.trim();
    }
    if (form.designation.trim() !== (user.designation ?? '')) {
      body.designation = form.designation.trim();
    }
    if (accredited) {
      if (form.accreditationNo.trim() !== (user.accreditationNo ?? '')) {
        body.accreditationNo = form.accreditationNo.trim();
      }
      const currentValid = user.accreditationValidUntil
        ? user.accreditationValidUntil.slice(0, 10)
        : '';
      if (form.accreditationValidUntil !== currentValid) {
        body.accreditationValidUntil = form.accreditationValidUntil || '';
      }
    }

    void onSave(body);
  }

  return (
    <form onSubmit={submit} className={styles.drawerSection}>
      <h3>
        <Save size={15} />
        Details
      </h3>
      <div className={styles.drawerGrid}>
        <div className="clay-input-group">
          <label className="clay-label">Name</label>
          <input
            className="clay-input"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div className="clay-input-group">
          <label className="clay-label">Phone</label>
          <input
            className="clay-input"
            placeholder="+919876543210"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
          {!user.isPhoneVerified && user.phone && (
            <span className={styles.hint}>Not verified by OTP yet.</span>
          )}
        </div>
        <div className="clay-input-group">
          <label className="clay-label">Role</label>
          <select
            className="clay-input clay-select"
            value={form.role}
            onChange={(e) => set('role', e.target.value)}
          >
            {/* The current role stays selectable even if this administrator
                could not grant it, so saving other fields is still possible. */}
            {(grantable.includes(user.role) ? grantable : [user.role, ...grantable]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="clay-input-group">
          <label className="clay-label">State</label>
          {canSetState ? (
            <select
              className="clay-input clay-select"
              value={form.state}
              onChange={(e) => set('state', e.target.value)}
            >
              <option value="">Not set</option>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <input className="clay-input" value={form.state || 'Not set'} readOnly />
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
        <div className="clay-input-group">
          <label className="clay-label">Additional districts</label>
          <input
            className="clay-input"
            placeholder="Comma separated"
            value={form.additionalDistricts}
            onChange={(e) => set('additionalDistricts', e.target.value)}
          />
          <span className={styles.hint}>Extra districts this officer may work in.</span>
        </div>
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
            value={form.designation}
            onChange={(e) => set('designation', e.target.value)}
          />
        </div>
        {accredited && (
          <>
            <div className="clay-input-group">
              <label className="clay-label">Accreditation number</label>
              <input
                className="clay-input"
                value={form.accreditationNo}
                onChange={(e) => set('accreditationNo', e.target.value)}
              />
            </div>
            <div className="clay-input-group">
              <label className="clay-label">Accreditation valid until</label>
              <input
                type="date"
                className="clay-input"
                value={form.accreditationValidUntil}
                onChange={(e) => set('accreditationValidUntil', e.target.value)}
              />
            </div>
          </>
        )}
      </div>
      <div className={styles.sectionActions}>
        <button type="submit" className="clay-btn clay-btn-secondary clay-btn-sm" disabled={busy}>
          {busy ? <Loader2 size={15} className={styles.spin} /> : <Save size={15} />}
          Save changes
        </button>
      </div>
    </form>
  );
}
