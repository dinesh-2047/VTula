'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  User as UserIcon,
  Save,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ShieldCheck,
  KeyRound,
  Building2,
  MapPin,
  BadgeCheck,
  FileText,
  Gauge,
  ClipboardCheck,
  Award,
} from 'lucide-react';
import {
  INDIAN_STATES,
  ORGANIZATION_TYPES,
  ORGANIZATION_TYPE_LABELS,
  formatDate,
  formatDateTime,
  type OrganizationType,
} from '@/lib/constants';
import styles from './profile.module.css';

/**
 * The signed-in user's own account.
 *
 * This page used to open with six invented values — `'+91 98765 43210'`,
 * `'Legal Metrology Commercial Enterprise'`, `'Gujarat'`, `'Ahmedabad'` — seeded
 * into `useState`, so every visitor saw somebody else's details presented as
 * their own. Its submit handler was `setSaved(true)` and a three-second timer: it
 * announced "Profile settings updated successfully" without sending a request,
 * and the edit vanished on refresh.
 *
 * It now reads and writes `/api/profile`. Two behaviours worth naming, because
 * they are the route's rules rather than this page's decoration:
 *  - **An officer cannot edit their own jurisdiction.** `state` and `district`
 *    decide which records an LMO may see, so changing them here would be a
 *    self-service transfer into another district's caseload. The route answers
 *    `JURISDICTION_LOCKED`; the page shows the fields as read-only and says who
 *    can change them.
 *  - **Changing the sign-in email needs the current password**, because the email
 *    *is* the credential. The field asks for it rather than letting the request
 *    fail with `PASSWORD_REQUIRED`.
 */

interface Profile {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: string;
  roleLabel: string;
  state?: string;
  district?: string;
  additionalDistricts?: string[];
  organizationName?: string;
  organizationId?: string;
  officerCode?: string;
  designation?: string;
  accreditationNo?: string;
  accreditationValidUntil?: string;
  categoriesApproved?: string[];
  isEmailVerified?: boolean;
  isPhoneVerified?: boolean;
  approvalStatus: string;
  lastLoginAt?: string;
  createdAt: string;
  aadhaarLinked: boolean;
}

interface OrganizationDetail {
  id: string;
  name: string;
  legalName?: string;
  type?: string;
  gstin?: string;
  pan?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    district?: string;
    state?: string;
    pincode?: string;
  };
}

type Activity =
  | {
      kind: 'officer';
      assignedOpen: number;
      inspectionsSubmitted: number;
      certificatesIssued: number;
    }
  | {
      kind: 'owner';
      instruments: number;
      openApplications: number;
      activeCertificates: number;
    };

interface Payload {
  success: boolean;
  error?: string;
  code?: string;
  profile?: Profile;
  organization?: OrganizationDetail | null;
  activity?: Activity;
  editable?: { jurisdiction: boolean; organization: boolean };
  message?: string;
  sessionStale?: boolean;
}

export default function ProfilePage() {
  const { update: refreshSession } = useSession();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [organization, setOrganization] = useState<OrganizationDetail | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [editable, setEditable] = useState({ jurisdiction: false, organization: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/profile');
      const data = (await res.json()) as Payload;
      if (!data.success || !data.profile) {
        setError(data.error || 'Your profile could not be loaded.');
        return;
      }
      setError(null);
      setProfile(data.profile);
      setOrganization(data.organization ?? null);
      setActivity(data.activity ?? null);
      setEditable(data.editable ?? { jurisdiction: false, organization: false });
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

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

  const save = useCallback(
    async (body: Record<string, unknown>): Promise<Payload> => {
      try {
        const res = await fetch('/api/profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as Payload;
        if (data.success) {
          setError(null);
          setNotice(data.message ?? 'Saved.');
          // The header and sidebar read the name from the session, so a name or
          // email change has to be pushed into the token or the old value lingers.
          if (data.sessionStale) await refreshSession();
          await load();
        } else {
          setNotice(null);
          setError(data.error ?? 'The change could not be saved.');
        }
        return data;
      } catch {
        setNotice(null);
        setError('Could not reach the server. Nothing was changed.');
        return { success: false };
      }
    },
    [load, refreshSession]
  );

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading your profile…</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className={styles.page}>
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error ?? 'Your profile could not be loaded.'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>My Profile</h1>
          <p>Your contact details, credentials and password.</p>
        </div>
      </div>

      <div className={styles.container}>
        {notice && (
          <div className={styles.successBanner}>
            <CheckCircle2 size={18} />
            <span>{notice}</span>
          </div>
        )}
        {error && (
          <div className={styles.errorBox}>
            <AlertTriangle size={17} />
            <span>{error}</span>
          </div>
        )}

        <div className={styles.card}>
          <div className={styles.userHead}>
            <div className={styles.avatar}>{profile.name.charAt(0).toUpperCase()}</div>
            <div className={styles.userHeadText}>
              <h3>{profile.name}</h3>
              <div className={styles.badgeRow}>
                <span className="clay-badge clay-badge-primary">{profile.roleLabel}</span>
                {profile.approvalStatus === 'APPROVED' ? (
                  <span className="clay-badge clay-badge-success">Approved</span>
                ) : profile.approvalStatus === 'PENDING' ? (
                  <span className="clay-badge clay-badge-warning">Awaiting approval</span>
                ) : (
                  <span className="clay-badge clay-badge-error">Rejected</span>
                )}
                {profile.isEmailVerified ? (
                  <span className="clay-badge clay-badge-info">Email verified</span>
                ) : (
                  <span className="clay-badge clay-badge-pending">Email unverified</span>
                )}
                {profile.phone &&
                  (profile.isPhoneVerified ? (
                    <span className="clay-badge clay-badge-info">Phone verified</span>
                  ) : (
                    <span className="clay-badge clay-badge-pending">Phone unverified</span>
                  ))}
              </div>
              <p className={styles.userHeadMeta}>
                Registered {formatDate(profile.createdAt)}
                {profile.lastLoginAt
                  ? ` · last signed in ${formatDateTime(profile.lastLoginAt)}`
                  : ''}
              </p>
            </div>
          </div>

          {activity && (
            <div className={styles.activity}>
              {activity.kind === 'officer' ? (
                <>
                  <Stat icon={<FileText size={16} />} value={activity.assignedOpen} label="open applications assigned" />
                  <Stat icon={<ClipboardCheck size={16} />} value={activity.inspectionsSubmitted} label="inspections submitted" />
                  <Stat icon={<Award size={16} />} value={activity.certificatesIssued} label="certificates issued" />
                </>
              ) : (
                <>
                  <Stat icon={<Gauge size={16} />} value={activity.instruments} label="instruments in use" />
                  <Stat icon={<FileText size={16} />} value={activity.openApplications} label="applications in progress" />
                  <Stat icon={<Award size={16} />} value={activity.activeCertificates} label="valid certificates" />
                </>
              )}
            </div>
          )}
        </div>

        <ContactForm key={`contact-${profile.id}-${profile.email}`} profile={profile} onSave={save} />

        <JurisdictionForm
          key={`jur-${profile.id}-${profile.state ?? ''}-${profile.district ?? ''}`}
          profile={profile}
          canEdit={editable.jurisdiction}
          onSave={save}
        />

        {editable.organization && (
          <BusinessForm
            key={`org-${organization?.id ?? 'none'}`}
            profile={profile}
            organization={organization}
            onSave={save}
          />
        )}

        {!editable.organization && (profile.officerCode || profile.accreditationNo) && (
          <section className={styles.card}>
            <h2>
              <BadgeCheck size={16} />
              Departmental credentials
            </h2>
            <p className={styles.sectionNote}>
              These identify you on inspection reports and signed certificates, so only an
              administrator can change them.
            </p>
            <div className={styles.readGrid}>
              {profile.officerCode && (
                <div>
                  <span>Officer / centre code</span>
                  <strong>{profile.officerCode}</strong>
                </div>
              )}
              {profile.designation && (
                <div>
                  <span>Designation</span>
                  <strong>{profile.designation}</strong>
                </div>
              )}
              {profile.accreditationNo && (
                <div>
                  <span>Accreditation</span>
                  <strong>{profile.accreditationNo}</strong>
                </div>
              )}
              {profile.accreditationValidUntil && (
                <div>
                  <span>Accreditation valid until</span>
                  <strong>{formatDate(profile.accreditationValidUntil)}</strong>
                </div>
              )}
              {profile.categoriesApproved && profile.categoriesApproved.length > 0 && (
                <div>
                  <span>Approved categories</span>
                  <strong>{profile.categoriesApproved.join(', ')}</strong>
                </div>
              )}
            </div>
          </section>
        )}

        <PasswordForm onSave={save} />
      </div>
    </div>
  );
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className={styles.stat}>
      {icon}
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Contact details
 * ------------------------------------------------------------------ */

function ContactForm({
  profile,
  onSave,
}: {
  profile: Profile;
  onSave: (body: Record<string, unknown>) => Promise<Payload>;
}) {
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== profile.email;
  const dirty =
    name.trim() !== profile.name || emailChanged || phone.trim() !== (profile.phone ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const body: Record<string, unknown> = {};
    if (name.trim() !== profile.name) body.name = name.trim();
    if (emailChanged) {
      body.email = email.trim();
      body.currentPassword = currentPassword;
    }
    if (phone.trim() !== (profile.phone ?? '')) body.phone = phone.trim();
    const result = await onSave(body);
    if (result.success) setCurrentPassword('');
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className={styles.card}>
      <h2>
        <UserIcon size={16} />
        Contact details
      </h2>
      <div className={styles.formGrid}>
        <div className="clay-input-group">
          <label className="clay-label">Full name</label>
          <input
            type="text"
            className="clay-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="clay-input-group">
          <label className="clay-label">Email address</label>
          <input
            type="email"
            className="clay-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <span className={styles.hint}>
            {emailChanged
              ? 'You will sign in with this address from next time, and it will need verifying again.'
              : 'This is the address you sign in with.'}
          </span>
        </div>
        <div className="clay-input-group">
          <label className="clay-label">Phone number</label>
          <input
            type="tel"
            className="clay-input"
            placeholder="+919876543210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <span className={styles.hint}>
            International format. Changing it means verifying by OTP again — OTP sign-in uses this
            number.
          </span>
        </div>
        {/* Only asked for when it is actually required, so the field is not noise. */}
        {emailChanged && (
          <div className="clay-input-group">
            <label className="clay-label">Current password</label>
            <input
              type="password"
              className="clay-input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
            <span className={styles.hint}>
              Confirming your password is required to change the address you sign in with.
            </span>
          </div>
        )}
      </div>
      <div className={styles.actions}>
        <button type="submit" className="clay-btn clay-btn-primary" disabled={saving || !dirty}>
          {saving ? <Loader2 size={18} className={styles.spin} /> : <Save size={18} />}
          Save details
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Jurisdiction
 * ------------------------------------------------------------------ */

function JurisdictionForm({
  profile,
  canEdit,
  onSave,
}: {
  profile: Profile;
  canEdit: boolean;
  onSave: (body: Record<string, unknown>) => Promise<Payload>;
}) {
  const [state, setState] = useState(profile.state ?? '');
  const [district, setDistrict] = useState(profile.district ?? '');
  const [saving, setSaving] = useState(false);

  const dirty = state !== (profile.state ?? '') || district.trim() !== (profile.district ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await onSave({ state, district: district.trim() });
    setSaving(false);
  }

  if (!canEdit) {
    return (
      <section className={styles.card}>
        <h2>
          <MapPin size={16} />
          Jurisdiction
        </h2>
        <p className={styles.sectionNote}>
          Your state and district decide which applications, instruments and certificates you can
          see, so they are set by an administrator rather than here.
        </p>
        <div className={styles.readGrid}>
          <div>
            <span>State</span>
            <strong>{profile.state || 'Not set'}</strong>
          </div>
          <div>
            <span>District</span>
            <strong>{profile.district || 'Not set'}</strong>
          </div>
          {profile.additionalDistricts && profile.additionalDistricts.length > 0 && (
            <div>
              <span>Additional districts</span>
              <strong>{profile.additionalDistricts.join(', ')}</strong>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className={styles.card}>
      <h2>
        <MapPin size={16} />
        Where your instruments are
      </h2>
      <p className={styles.sectionNote}>
        This decides which Legal Metrology office handles your applications.
      </p>
      <div className={styles.formGrid}>
        <div className="clay-input-group">
          <label className="clay-label">State</label>
          <select
            className="clay-input clay-select"
            value={state}
            onChange={(e) => setState(e.target.value)}
            required
          >
            <option value="">Select a state</option>
            {INDIAN_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="clay-input-group">
          <label className="clay-label">District</label>
          <input
            type="text"
            className="clay-input"
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
          />
        </div>
      </div>
      <div className={styles.actions}>
        <button type="submit" className="clay-btn clay-btn-primary" disabled={saving || !dirty}>
          {saving ? <Loader2 size={18} className={styles.spin} /> : <Save size={18} />}
          Save jurisdiction
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Business details
 * ------------------------------------------------------------------ */

function BusinessForm({
  profile,
  organization,
  onSave,
}: {
  profile: Profile;
  organization: OrganizationDetail | null;
  onSave: (body: Record<string, unknown>) => Promise<Payload>;
}) {
  const [tradeName, setTradeName] = useState(profile.organizationName ?? '');
  const [form, setForm] = useState({
    legalName: organization?.legalName ?? '',
    type: organization?.type ?? 'PROPRIETORSHIP',
    gstin: organization?.gstin ?? '',
    pan: organization?.pan ?? '',
    line1: organization?.address?.line1 ?? '',
    line2: organization?.address?.line2 ?? '',
    city: organization?.address?.city ?? '',
    district: organization?.address?.district ?? '',
    state: organization?.address?.state ?? '',
    pincode: organization?.address?.pincode ?? '',
  });
  const [saving, setSaving] = useState(false);

  const set = (k: keyof typeof form, v: string) => setForm((prev) => ({ ...prev, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const body: Record<string, unknown> = {};
    if (tradeName.trim() !== (profile.organizationName ?? '')) {
      body.organizationName = tradeName.trim();
    }
    if (organization) {
      body.organization = {
        legalName: form.legalName,
        type: form.type,
        gstin: form.gstin,
        pan: form.pan,
        address: {
          line1: form.line1,
          line2: form.line2,
          city: form.city,
          district: form.district,
          state: form.state,
          pincode: form.pincode,
        },
      };
    }
    await onSave(body);
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className={styles.card}>
      <h2>
        <Building2 size={16} />
        Business details
      </h2>

      {organization ? (
        <p className={styles.sectionNote}>
          These appear on your verification certificates.{' '}
          {/*
            This sentence used to read "Your compliance score is 100 across 0
            registered instruments" — for everyone, always. It was printing two
            denormalised fields on the organisation record that no code ever wrote,
            one of which defaulted to 100. Both are gone; the score is computed from
            the actual estate on its own page.
          */}
          Your compliance score is worked out from your instruments, renewals and any
          open findings — see{' '}
          <Link href="/dashboard/compliance" className={styles.noteLink}>
            Compliance Health
          </Link>
          .
        </p>
      ) : (
        <p className={styles.sectionNote}>
          No business record is linked to your account yet. It is created with your first registered
          instrument — until then, only the trading name below can be set.
        </p>
      )}

      <div className={styles.formGrid}>
        <div className="clay-input-group">
          <label className="clay-label">Trading name</label>
          <input
            type="text"
            className="clay-input"
            value={tradeName}
            onChange={(e) => setTradeName(e.target.value)}
          />
        </div>

        {organization && (
          <>
            <div className="clay-input-group">
              <label className="clay-label">Registered legal name</label>
              <input
                type="text"
                className="clay-input"
                value={form.legalName}
                onChange={(e) => set('legalName', e.target.value)}
              />
            </div>
            <div className="clay-input-group">
              <label className="clay-label">Constitution</label>
              <select
                className="clay-input clay-select"
                value={form.type}
                onChange={(e) => set('type', e.target.value)}
              >
                {ORGANIZATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ORGANIZATION_TYPE_LABELS[t as OrganizationType]}
                  </option>
                ))}
              </select>
            </div>
            <div className="clay-input-group">
              <label className="clay-label">GSTIN</label>
              <input
                type="text"
                className="clay-input"
                maxLength={15}
                placeholder="24AAAAA0000A1Z5"
                value={form.gstin}
                onChange={(e) => set('gstin', e.target.value.toUpperCase())}
              />
            </div>
            <div className="clay-input-group">
              <label className="clay-label">PAN</label>
              <input
                type="text"
                className="clay-input"
                maxLength={10}
                placeholder="AAAAA0000A"
                value={form.pan}
                onChange={(e) => set('pan', e.target.value.toUpperCase())}
              />
            </div>
            <div className="clay-input-group" style={{ gridColumn: 'span 2' }}>
              <label className="clay-label">Address line 1</label>
              <input
                type="text"
                className="clay-input"
                value={form.line1}
                onChange={(e) => set('line1', e.target.value)}
              />
            </div>
            <div className="clay-input-group" style={{ gridColumn: 'span 2' }}>
              <label className="clay-label">Address line 2</label>
              <input
                type="text"
                className="clay-input"
                value={form.line2}
                onChange={(e) => set('line2', e.target.value)}
              />
            </div>
            <div className="clay-input-group">
              <label className="clay-label">City / town</label>
              <input
                type="text"
                className="clay-input"
                value={form.city}
                onChange={(e) => set('city', e.target.value)}
              />
            </div>
            <div className="clay-input-group">
              <label className="clay-label">District</label>
              <input
                type="text"
                className="clay-input"
                value={form.district}
                onChange={(e) => set('district', e.target.value)}
              />
            </div>
            <div className="clay-input-group">
              <label className="clay-label">State</label>
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
            </div>
            <div className="clay-input-group">
              <label className="clay-label">Pincode</label>
              <input
                type="text"
                className="clay-input"
                maxLength={6}
                inputMode="numeric"
                value={form.pincode}
                onChange={(e) => set('pincode', e.target.value.replace(/\D/g, ''))}
              />
            </div>
          </>
        )}
      </div>

      <div className={styles.actions}>
        <button type="submit" className="clay-btn clay-btn-primary" disabled={saving}>
          {saving ? <Loader2 size={18} className={styles.spin} /> : <Save size={18} />}
          Save business details
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Password
 * ------------------------------------------------------------------ */

function PasswordForm({ onSave }: { onSave: (body: Record<string, unknown>) => Promise<Payload> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setLocalError('The two new passwords do not match.');
      return;
    }
    setLocalError('');
    setSaving(true);
    const result = await onSave({
      action: 'change-password',
      currentPassword: current,
      newPassword: next,
    });
    if (result.success) {
      setCurrent('');
      setNext('');
      setConfirm('');
    }
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className={styles.card}>
      <h2>
        <KeyRound size={16} />
        Change password
      </h2>
      <p className={styles.sectionNote}>
        At least 10 characters, and different from the current one. You will be notified by email
        and SMS when it changes — that is how you would find out if it were not you.
      </p>
      {localError && (
        <div className={styles.errorBox}>
          <AlertTriangle size={16} />
          <span>{localError}</span>
        </div>
      )}
      <div className={styles.formGrid}>
        <div className="clay-input-group">
          <label className="clay-label">Current password</label>
          <input
            type="password"
            className="clay-input"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div className="clay-input-group">
          <label className="clay-label">New password</label>
          <input
            type="password"
            className="clay-input"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            minLength={10}
            required
          />
        </div>
        <div className="clay-input-group">
          <label className="clay-label">Repeat new password</label>
          <input
            type="password"
            className="clay-input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={10}
            required
          />
        </div>
      </div>
      <div className={styles.actions}>
        <button
          type="submit"
          className="clay-btn clay-btn-secondary"
          disabled={saving || !current || next.length < 10}
        >
          {saving ? <Loader2 size={18} className={styles.spin} /> : <ShieldCheck size={18} />}
          Change password
        </button>
      </div>
    </form>
  );
}
