'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  Scale,
  FileText,
  Award,
  Clock,
  Plus,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  ClipboardCheck,
  MapPin,
  Timer,
  Flag,
  Gauge,
  IndianRupee,
  PenLine,
  MessageSquareWarning,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import {
  OFFICIAL_ROLES,
  OPEN_APPLICATION_STATUSES,
  OWNER_ACTION_STATUSES,
  CERTIFICATE_VALID_STATUSES,
  ROLE_LABELS,
  applicationStatusLabel,
  certificateStatusLabel,
  statusBadgeClass,
  formatDate,
  type Role,
} from '@/lib/constants';
import styles from './page.module.css';

/**
 * The dashboard home page.
 *
 * Every number on this screen used to be wrong, and wrong in a way that got
 * worse as the database grew:
 *
 *  - The counts were `instruments.length`, `applications.length` and
 *    `certificates.length` over unparameterised list fetches. Those endpoints
 *    page at fifty rows, so "Total Instruments" was the size of the first page.
 *    A business with sixty instruments saw fifty, forever.
 *  - The filters tested `'Pending' | 'Submitted' | 'Scheduled'` and
 *    `status === 'Active'`. The enums are SCREAMING_SNAKE, so *every* one of
 *    those comparisons was false and the tiles read zero on a live system.
 *  - "Inspections Verified" counted approved applications, which is a different
 *    thing from an inspection and a different thing again from one done today.
 *  - "Jurisdiction Region" fell back to the string `'Central District'` — a
 *    place that does not exist — whenever the session had no district.
 *
 * The two audiences need different sources, and one of them is a hard
 * constraint: `GET /api/analytics` is `requireOfficial`, so it cannot back the
 * owner half. Officials therefore read their figures from the analytics report
 * (which aggregates in Mongo, over their real jurisdiction) and their queue from
 * `/api/tasks`; owners read totals from the `total` and `countsByStatus` fields
 * the scoped list endpoints already return, never from the length of a page.
 */

interface ListMeta {
  success: boolean;
  error?: string;
  total?: number;
  countsByStatus?: Record<string, number>;
}

interface AppRow {
  _id: string;
  applicationNo: string;
  status: string;
  type?: string;
  createdAt?: string;
  submittedDate?: string;
  dueDate?: string;
  priorityReasons?: string[];
  instrumentId?: {
    type?: string;
    brand?: string;
    model?: string;
    serialNo?: string;
  } | null;
  ownerId?: { name?: string; organizationName?: string } | null;
}

interface CertRow {
  _id: string;
  certNo: string;
  status: string;
  effectiveStatus?: string;
  issuedDate?: string;
  expiryDate: string;
  daysToExpiry?: number;
  instrumentSnapshot?: { type?: string; brand?: string; serialNo?: string };
}

interface AppList extends ListMeta {
  applications?: AppRow[];
}

interface CertList extends ListMeta {
  certificates?: CertRow[];
}

interface TaskList {
  success: boolean;
  error?: string;
  tasks?: AppRow[];
  countsByStatus?: Record<string, number>;
  scope?: { role: string; state: string | null; district: string | null };
}

/** Only the parts of the analytics report this page shows. */
interface Report {
  period: { label: string };
  scope: { level: 'national' | 'state' | 'district'; state?: string; district?: string };
  headline: {
    instruments: { total: number; active: number };
    applications: { total: number; inPeriod: number; open: number };
    certificates: { total: number; active: number; expiringSoon: number; expired: number };
    revenue: { collected: number; outstanding: number; collectionRate: number | null };
    officers: number;
    openRiskFlags: number;
  };
  sla: {
    decided: number;
    withTarget: number;
    onTime: number;
    onTimePercent: number | null;
    averageTurnaroundDays: number | null;
    medianTurnaroundDays: number | null;
  };
  inspections: { total: number; passRate: number | null };
}

interface OfficialData {
  kind: 'official';
  report: Report;
  queue: AppRow[];
  queueTotal: number;
}

interface OwnerData {
  kind: 'owner';
  instruments: { total: number; active: number };
  applications: { total: number; open: number; recent: AppRow[]; actionable: AppRow[] };
  certificates: { total: number; valid: number; recent: CertRow[] };
  renewals: { total: number; rows: CertRow[] };
}

type Data = OfficialData | OwnerData;

/** Fees are stored in whole rupees (`Rule.fee.base` is "in INR"), not paise. */
function money(rupees: number): string {
  return `₹${rupees.toLocaleString('en-IN')}`;
}

/** `null` means "not enough data to say", which is not the same as zero. */
function orDash(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}

function sumStatuses(counts: Record<string, number> | undefined, keys: readonly string[]): number {
  if (!counts) return 0;
  return keys.reduce((total, key) => total + (counts[key] ?? 0), 0);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

export default function DashboardPage() {
  const { data: session, status: sessionStatus } = useSession();
  const role: Role = session?.user?.role ?? 'Owner';
  const official = OFFICIAL_ROLES.includes(role);

  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isOfficial: boolean) => {
      try {
        if (isOfficial) {
          const [analytics, tasks] = await Promise.all([
            getJson<{ success: boolean; error?: string; report?: Report }>('/api/analytics'),
            getJson<TaskList>('/api/tasks?limit=6'),
          ]);

          if (!analytics.success || !analytics.report) {
            setError(analytics.error ?? 'Your dashboard figures could not be loaded.');
            return;
          }

          setError(null);
          setData({
            kind: 'official',
            report: analytics.report,
            queue: tasks.tasks ?? [],
            // `/api/tasks` already counts only the officer-queue statuses within
            // this officer's scope, so the whole map is the queue size.
            queueTotal: Object.values(tasks.countsByStatus ?? {}).reduce((a, b) => a + b, 0),
          });
          return;
        }

        /*
         * Four scoped reads, none of which counts rows in the browser. `limit=1`
         * on the instruments call is deliberate: the tile needs `total` and
         * `countsByStatus`, not the instruments themselves.
         */
        const [instruments, applications, certificates, renewals] = await Promise.all([
          getJson<ListMeta>('/api/instruments?limit=1'),
          getJson<AppList>('/api/applications?limit=6'),
          getJson<CertList>('/api/certificates?limit=6'),
          getJson<CertList>('/api/certificates?expiring=true&limit=5'),
        ]);

        const firstFailure = [instruments, applications, certificates, renewals].find(
          (r) => !r.success
        );
        if (firstFailure) {
          setError(firstFailure.error ?? 'Your dashboard figures could not be loaded.');
          return;
        }

        const appRows = applications.applications ?? [];

        setError(null);
        setData({
          kind: 'owner',
          instruments: {
            total: instruments.total ?? 0,
            active: instruments.countsByStatus?.ACTIVE ?? 0,
          },
          applications: {
            total: applications.total ?? 0,
            open: sumStatuses(applications.countsByStatus, OPEN_APPLICATION_STATUSES),
            recent: appRows,
            // What the *applicant* still owes the department, as opposed to what
            // the department owes them.
            actionable: appRows.filter((a) =>
              (OWNER_ACTION_STATUSES as readonly string[]).includes(a.status)
            ),
          },
          certificates: {
            total: certificates.total ?? 0,
            valid: sumStatuses(certificates.countsByStatus, CERTIFICATE_VALID_STATUSES),
            recent: certificates.certificates ?? [],
          },
          renewals: {
            total: renewals.total ?? 0,
            rows: renewals.certificates ?? [],
          },
        });
      } catch {
        setError('Could not reach the server. Check your connection and try again.');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (sessionStatus === 'loading') return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await load(official);
    })();
    return () => {
      cancelled = true;
    };
  }, [load, official, sessionStatus]);

  if (loading || sessionStatus === 'loading') {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading your dashboard…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error ?? 'Your dashboard figures could not be loaded.'}</span>
        </div>
      </div>
    );
  }

  return data.kind === 'official' ? (
    <OfficialDashboard data={data} role={role} />
  ) : (
    <OwnerDashboard data={data} name={session?.user?.name ?? null} />
  );
}

/* ------------------------------------------------------------------ *
 * Officials
 * ------------------------------------------------------------------ */

function OfficialDashboard({ data, role }: { data: OfficialData; role: Role }) {
  const { report, queue, queueTotal } = data;
  const { headline, sla, scope } = report;

  /*
   * The jurisdiction the server actually scoped the figures to. The old page
   * invented `'Central District'` here; if a district is genuinely unset that is
   * a data problem an officer should see, not one to paper over with a placeholder.
   */
  const jurisdiction =
    scope.level === 'national'
      ? 'All India'
      : scope.level === 'state'
        ? (scope.state ?? 'State not set')
        : [scope.district, scope.state].filter(Boolean).join(', ') || 'Not set';

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Verification workspace</h1>
          <p>
            {ROLE_LABELS[role]} · {jurisdiction} · figures for {report.period.label}
          </p>
        </div>

        <div className={styles.quickActions}>
          <Link href="/dashboard/tasks" className="clay-btn clay-btn-primary">
            <ClipboardCheck size={18} />
            Work queue{queueTotal > 0 ? ` (${queueTotal})` : ''}
          </Link>
          <Link href="/dashboard/reports" className="clay-btn clay-btn-secondary">
            <FileText size={18} />
            Reports
          </Link>
        </div>
      </div>

      <div className={styles.statsGrid}>
        <StatCard
          label="Applications open"
          value={headline.applications.open}
          note={`${headline.applications.inPeriod} received this period`}
          icon={ClipboardCheck}
          color="var(--status-pending)"
          bg="var(--status-pending-bg)"
          href="/dashboard/tasks"
        />
        <StatCard
          label="Decided on time"
          value={orDash(sla.onTimePercent, '%')}
          note={
            sla.withTarget > 0
              ? `${sla.onTime} of ${sla.withTarget} against target`
              : 'No decisions with a target yet'
          }
          icon={Timer}
          color="var(--color-secondary)"
          bg="rgba(129, 178, 154, 0.08)"
          href="/dashboard/reports"
        />
        <StatCard
          label="Certificates in force"
          value={headline.certificates.active}
          note={`${headline.certificates.expiringSoon} expiring soon · ${headline.certificates.expired} expired`}
          icon={Award}
          color="var(--color-primary)"
          bg="rgba(224, 122, 95, 0.08)"
          href="/dashboard/certificates"
        />
        <StatCard
          label="Risk flags to triage"
          value={headline.openRiskFlags}
          note={
            headline.openRiskFlags > 0
              ? 'Open or under review'
              : 'Nothing awaiting triage'
          }
          icon={Flag}
          color={headline.openRiskFlags > 0 ? 'var(--status-error)' : 'var(--text-muted)'}
          bg={headline.openRiskFlags > 0 ? 'rgba(224, 122, 95, 0.12)' : 'var(--surface-warm)'}
          href="/dashboard/reports"
        />
      </div>

      <div className={styles.contentGrid}>
        <div className={`clay-card ${styles.activityCard}`}>
          <div className={styles.cardHeader}>
            <h3>Next in your queue</h3>
            <Link href="/dashboard/tasks" className={styles.viewAll}>
              View all <ArrowRight size={14} />
            </Link>
          </div>

          <div className={styles.activityList}>
            {queue.length === 0 ? (
              <div className={styles.emptyState}>
                <CheckCircle2 size={22} />
                <p>Nothing is waiting in {jurisdiction}.</p>
              </div>
            ) : (
              queue.map((task) => {
                const overdue = task.dueDate ? new Date(task.dueDate) < new Date() : false;
                const instrument = task.instrumentId;
                return (
                  <Link
                    key={task._id}
                    href={`/dashboard/applications/${task._id}`}
                    className={styles.activityItem}
                  >
                    <div className={styles.activityIcon}>
                      <FileText size={18} />
                    </div>
                    <div className={styles.activityInfo}>
                      <span className={styles.activityTitle}>
                        {task.applicationNo}
                        {instrument?.type ? ` · ${instrument.type}` : ''}
                      </span>
                      <span className={styles.activityDate}>
                        {task.ownerId?.organizationName || task.ownerId?.name || 'Applicant'}
                        {task.dueDate && (
                          <>
                            {' · '}
                            <span className={overdue ? styles.overdue : undefined}>
                              {overdue ? 'Overdue since ' : 'Due '}
                              {formatDate(task.dueDate)}
                            </span>
                          </>
                        )}
                      </span>
                    </div>
                    <span className={`clay-badge ${statusBadgeClass(task.status)}`}>
                      {applicationStatusLabel(task.status)}
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </div>

        {/*
          * Performance, stated with its own caveats. `onTimePercent` and the
          * turnaround averages are null until something has been decided, and a
          * dash is the honest rendering of that — 0% and 100% both lie.
          */}
        <div className={`clay-card ${styles.tipsCard}`}>
          <h3>How the district is doing</h3>

          <div className={styles.metricRow}>
            <Gauge size={18} />
            <div>
              <strong>{orDash(sla.averageTurnaroundDays, ' days')} average turnaround</strong>
              <p>
                Median {orDash(sla.medianTurnaroundDays, ' days')}, across {sla.decided} decided{' '}
                {sla.decided === 1 ? 'application' : 'applications'} in {report.period.label}.
              </p>
            </div>
          </div>

          <div className={styles.metricRow}>
            <ShieldCheck size={18} />
            <div>
              <strong>{orDash(report.inspections.passRate, '% passed')}</strong>
              <p>
                {report.inspections.total} {report.inspections.total === 1 ? 'inspection' : 'inspections'}{' '}
                recorded. A failed inspection is a rejection with a reason, not a missing record.
              </p>
            </div>
          </div>

          <div className={styles.metricRow}>
            <IndianRupee size={18} />
            <div>
              <strong>{money(headline.revenue.collected)} collected</strong>
              <p>
                {money(headline.revenue.outstanding)} still assessed but unpaid
                {headline.revenue.collectionRate !== null && (
                  <> · {headline.revenue.collectionRate}% of assessed fees banked</>
                )}
                .
              </p>
            </div>
          </div>

          <div className={styles.metricRow}>
            <MapPin size={18} />
            <div>
              <strong>{headline.officers} verifying officers</strong>
              <p>
                Approved and active in {jurisdiction}, holding {headline.instruments.total}{' '}
                registered {headline.instruments.total === 1 ? 'instrument' : 'instruments'}.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Owners
 * ------------------------------------------------------------------ */

function OwnerDashboard({ data, name }: { data: OwnerData; name: string | null }) {
  const { instruments, applications, certificates, renewals } = data;

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>{name ? `Welcome back, ${name.split(' ')[0]}` : 'Your compliance overview'}</h1>
          <p>Your instruments, their verification applications, and the certificates in force.</p>
        </div>

        <div className={styles.quickActions}>
          <Link href="/dashboard/instruments/new" className="clay-btn clay-btn-secondary">
            <Plus size={18} />
            Add instrument
          </Link>
          <Link href="/dashboard/applications/new" className="clay-btn clay-btn-primary">
            <Plus size={18} />
            New application
          </Link>
        </div>
      </div>

      <div className={styles.statsGrid}>
        <StatCard
          label="Instruments registered"
          value={instruments.total}
          note={`${instruments.active} verified and in use`}
          icon={Scale}
          color="var(--color-primary)"
          bg="rgba(224, 122, 95, 0.08)"
          href="/dashboard/instruments"
        />
        <StatCard
          label="Applications in progress"
          value={applications.open}
          note={`${applications.total} submitted in total`}
          icon={FileText}
          color="var(--status-pending)"
          bg="var(--status-pending-bg)"
          href="/dashboard/applications"
        />
        <StatCard
          label="Certificates in force"
          value={certificates.valid}
          note={`${certificates.total} issued to you overall`}
          icon={Award}
          color="var(--color-secondary)"
          bg="rgba(129, 178, 154, 0.08)"
          href="/dashboard/certificates"
        />
        <StatCard
          label="Renewals due"
          value={renewals.total}
          note={renewals.total > 0 ? 'Expiring within 60 days' : 'Nothing expiring soon'}
          icon={Clock}
          color={renewals.total > 0 ? 'var(--status-warning)' : 'var(--text-muted)'}
          bg={renewals.total > 0 ? 'var(--status-warning-bg)' : 'var(--surface-warm)'}
          href="/dashboard/certificates?expiring=true"
        />
      </div>

      <div className={styles.contentGrid}>
        {/*
          * The one panel worth the space: what the applicant themselves has to do.
          * A draft nobody submits and a query nobody answers are the two ways an
          * application silently stops moving, and neither generates a reminder
          * from the department.
          */}
        <div className={`clay-card ${styles.activityCard}`}>
          <div className={styles.cardHeader}>
            <h3>Needs your attention</h3>
            <Link href="/dashboard/applications" className={styles.viewAll}>
              All applications <ArrowRight size={14} />
            </Link>
          </div>

          <div className={styles.activityList}>
            {applications.actionable.length === 0 && renewals.rows.length === 0 ? (
              <div className={styles.emptyState}>
                <CheckCircle2 size={22} />
                <p>Nothing needs you right now. The department will notify you of any change.</p>
              </div>
            ) : (
              <>
                {applications.actionable.map((a) => (
                  <Link
                    key={a._id}
                    href={
                      a.status === 'DRAFT'
                        ? '/dashboard/applications/new'
                        : `/dashboard/applications/${a._id}`
                    }
                    className={styles.activityItem}
                  >
                    <div className={styles.activityIcon}>
                      {a.status === 'DRAFT' ? <PenLine size={18} /> : <MessageSquareWarning size={18} />}
                    </div>
                    <div className={styles.activityInfo}>
                      <span className={styles.activityTitle}>
                        {a.status === 'DRAFT'
                          ? `Finish application ${a.applicationNo}`
                          : `Answer the query on ${a.applicationNo}`}
                      </span>
                      <span className={styles.activityDate}>
                        {a.instrumentId?.type ?? 'Instrument'}
                        {a.instrumentId?.serialNo ? ` · ${a.instrumentId.serialNo}` : ''}
                      </span>
                    </div>
                    <span className={`clay-badge ${statusBadgeClass(a.status)}`}>
                      {applicationStatusLabel(a.status)}
                    </span>
                  </Link>
                ))}

                {renewals.rows.map((c) => (
                  <Link
                    key={c._id}
                    href="/dashboard/applications/new"
                    className={styles.activityItem}
                  >
                    <div className={styles.activityIcon}>
                      <RefreshCw size={18} />
                    </div>
                    <div className={styles.activityInfo}>
                      <span className={styles.activityTitle}>
                        Re-verify {c.instrumentSnapshot?.type ?? 'instrument'}
                        {c.instrumentSnapshot?.serialNo ? ` · ${c.instrumentSnapshot.serialNo}` : ''}
                      </span>
                      <span className={styles.activityDate}>
                        {c.certNo} expires {formatDate(c.expiryDate)}
                        {typeof c.daysToExpiry === 'number' && c.daysToExpiry >= 0 && (
                          <>
                            {' · '}
                            <span className={c.daysToExpiry <= 14 ? styles.overdue : undefined}>
                              {c.daysToExpiry} {c.daysToExpiry === 1 ? 'day' : 'days'} left
                            </span>
                          </>
                        )}
                      </span>
                    </div>
                    <span
                      className={`clay-badge ${statusBadgeClass(c.effectiveStatus ?? c.status)}`}
                    >
                      {certificateStatusLabel(c.effectiveStatus ?? c.status)}
                    </span>
                  </Link>
                ))}
              </>
            )}
          </div>
        </div>

        <div className={`clay-card ${styles.tipsCard}`}>
          <h3>Recent activity</h3>

          {applications.recent.length === 0 && certificates.recent.length === 0 ? (
            <div className={styles.emptyState}>
              <FileText size={22} />
              <p>
                Nothing yet. Register an instrument, then apply for its verification — the
                department schedules a visit and issues the certificate from there.
              </p>
            </div>
          ) : (
            <div className={styles.activityList}>
              {applications.recent.slice(0, 3).map((a) => (
                <Link
                  key={a._id}
                  href={`/dashboard/applications/${a._id}`}
                  className={styles.activityItem}
                >
                  <div className={styles.activityIcon}>
                    <FileText size={18} />
                  </div>
                  <div className={styles.activityInfo}>
                    <span className={styles.activityTitle}>
                      {a.applicationNo}
                      {a.instrumentId?.type ? ` · ${a.instrumentId.type}` : ''}
                    </span>
                    <span className={styles.activityDate}>
                      {formatDate(a.submittedDate ?? a.createdAt)}
                    </span>
                  </div>
                  <span className={`clay-badge ${statusBadgeClass(a.status)}`}>
                    {applicationStatusLabel(a.status)}
                  </span>
                </Link>
              ))}

              {certificates.recent.slice(0, 3).map((c) => (
                <Link
                  key={c._id}
                  href={`/dashboard/certificates?search=${encodeURIComponent(c.certNo)}`}
                  className={styles.activityItem}
                >
                  <div className={styles.activityIcon}>
                    <Award size={18} />
                  </div>
                  <div className={styles.activityInfo}>
                    <span className={styles.activityTitle}>{c.certNo}</span>
                    <span className={styles.activityDate}>
                      Issued {formatDate(c.issuedDate)} · valid to {formatDate(c.expiryDate)}
                    </span>
                  </div>
                  <span
                    className={`clay-badge ${statusBadgeClass(c.effectiveStatus ?? c.status)}`}
                  >
                    {certificateStatusLabel(c.effectiveStatus ?? c.status)}
                  </span>
                </Link>
              ))}
            </div>
          )}

          <div className={styles.metricRow} style={{ marginTop: 6 }}>
            <AlertTriangle size={18} style={{ color: 'var(--status-warning)' }} />
            <div>
              <strong>Re-verify before expiry</strong>
              <p>
                Using an instrument whose certificate has lapsed is an offence under the Legal
                Metrology Act, 2009. Apply for re-verification well before the expiry date —
                a visit has to be scheduled and that takes time.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  note,
  icon: Icon,
  color,
  bg,
  href,
}: {
  label: string;
  value: number | string;
  note?: string;
  icon: React.ComponentType<{ size?: number }>;
  color: string;
  bg: string;
  href: string;
}) {
  return (
    <Link href={href} className={styles.statCard}>
      <div className={styles.statIcon} style={{ background: bg, color }}>
        <Icon size={24} />
      </div>
      <div className={styles.statInfo}>
        <div className={styles.statValue}>{value}</div>
        <div className={styles.statLabel}>{label}</div>
        {note && <div className={styles.statNote}>{note}</div>}
      </div>
      <TrendingUp size={18} className={styles.statArrow} />
    </Link>
  );
}
