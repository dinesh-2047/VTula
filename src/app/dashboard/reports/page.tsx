'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  Award,
  Building2,
  Download,
  Gauge,
  IndianRupee,
  Loader2,
  Lock,
  Scale,
  ShieldAlert,
  Timer,
  Wallet,
} from 'lucide-react';
import {
  formatDate,
  formatDateTime,
  formatInr,
  formatInrCompact,
  formatMonthKey,
} from '@/lib/constants';
import styles from './reports.module.css';

/**
 * Departmental reporting.
 *
 * The page used to compute its own figures in the browser from three paginated
 * list endpoints, and every headline number was wrong in the same direction:
 * `instruments.length` was the page size, so a state with four thousand
 * instruments reported fifty. Revenue summed `feePaid` over whatever happened to
 * be on page one. Anything without a district was filed under an invented
 * "Central Division", which read like a real place. And two of the figures were
 * not figures at all — "100% Authentic" and a per-district "Active" were string
 * literals that would have read the same on an empty database.
 *
 * Everything below now comes from `GET /api/analytics`, which aggregates in
 * MongoDB over the caller's whole jurisdiction. The CSV export is the same
 * endpoint with `format=csv`: generated server-side, from the same aggregation,
 * so an exported figure cannot disagree with the one on screen — and the export
 * is written to the audit log, which a browser-built CSV never was.
 *
 * Chart colours are not the interface's brand tokens. The clay palette is
 * deliberately muted — its secondary and charcoal sit below the chroma floor at
 * which a fill still reads as a colour rather than as grey, and charcoal is
 * darker than the legible lightness band. The three below hold the product's own
 * hues at the minimum chroma that passes, each clearing 3:1 against the white
 * card. Every chart here plots a single series, so no reader ever has to tell
 * two of them apart.
 */

const WARM = '#803B29';
const BLUE = '#4E94C3';
const GREEN = '#177553';

const INK = '#2C2E42'; /* --text-primary, for label text on charts */
const SECONDARY = '#6B6D7E'; /* --text-secondary */
const MUTED = '#9B9DAE'; /* --text-muted */
const GRID = '#EBE9EF'; /* one step off the white card */

const PERIODS = [
  { value: 'fy', label: 'Financial year' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'Calendar year' },
  { value: 'all', label: 'All time' },
] as const;

type Period = (typeof PERIODS)[number]['value'];

const CATEGORY_LIMIT = 10;

const SLA_STATUS: Record<string, { label: string; badge: string }> = {
  BEHIND: { label: 'Behind', badge: 'clay-badge-error' },
  IN_PROGRESS: { label: 'In progress', badge: 'clay-badge-warning' },
  CLEAR: { label: 'Clear', badge: 'clay-badge-success' },
};

const INSPECTION_RESULTS: Record<string, string> = {
  PASS: 'Passed',
  FAIL: 'Failed',
  INCONCLUSIVE: 'Inconclusive',
};

/* --- the endpoint's shape ------------------------------------------------- */

interface Report {
  period: { from: string; to: string; label: string };
  scope: { level: 'national' | 'state' | 'district'; state?: string; district?: string };
  headline: {
    instruments: { total: number; active: number };
    applications: { total: number; inPeriod: number; open: number };
    certificates: { total: number; active: number; expiringSoon: number; expired: number };
    revenue: {
      collected: number;
      payments: number;
      outstanding: number;
      outstandingApplications: number;
      collectionRate: number | null;
    };
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
    truncated: boolean;
  };
  inspections: { total: number; byResult: Record<string, number>; passRate: number | null };
  funnel: { status: string; label: string; count: number }[];
  byVerificationType: { type: string; label: string; count: number; revenue: number }[];
  byDistrict: {
    state: string;
    district: string;
    applications: number;
    open: number;
    overdue: number;
    certificatesIssued: number;
    revenue: number;
    outstanding: number;
    slaStatus: string;
  }[];
  byInstrumentCategory: { type: string; count: number }[];
  monthly: {
    month: string;
    applications: number;
    revenue: number;
    approved: number;
    rejected: number;
  }[];
  generatedAt: string;
}

interface MonthPoint {
  key: string;
  label: string;
  applications: number;
  approved: number;
  rejected: number;
  undecided: number;
  revenue: number;
}

/** Report plus the series derived from it, built together so render stays pure. */
interface View {
  report: Report;
  months: MonthPoint[];
}

/*
 * A month in which nothing was filed is absent from the aggregate. Plotted as-is
 * the axis would skip it, and twelve bars would silently become nine — which
 * reads as steady activity across a quiet period. The empty months are filled in
 * so a gap looks like a gap.
 */
function buildMonths(monthly: Report['monthly']): MonthPoint[] {
  const bySeen = new Map(monthly.map((m) => [m.month, m]));
  const now = new Date();
  const out: MonthPoint[] = [];

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const row = bySeen.get(key);
    out.push({
      key,
      label: formatMonthKey(key),
      applications: row?.applications ?? 0,
      approved: row?.approved ?? 0,
      rejected: row?.rejected ?? 0,
      undecided: Math.max(0, (row?.applications ?? 0) - (row?.approved ?? 0) - (row?.rejected ?? 0)),
      revenue: row?.revenue ?? 0,
    });
  }
  return out;
}

export default function ReportsPage() {
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('fy');
  const [exporting, setExporting] = useState(false);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/analytics?period=${period}`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const data = (await res.json()) as { success: boolean; error?: string; report?: Report };
      if (!data.success || !data.report) {
        setError(data.error ?? 'The report could not be produced.');
        return;
      }
      setError(null);
      setForbidden(false);
      setView({ report: data.report, months: buildMonths(data.report.monthly) });
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchReport();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchReport]);

  /*
   * The CSV comes from the server rather than being assembled here, so the file
   * a district signs off carries the same aggregation as the screen — and the
   * download is audited. Fetched rather than linked so a permission failure
   * shows as a message instead of navigating away to a JSON error page.
   */
  async function exportCsv() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/analytics?period=${period}&format=csv`);
      if (!res.ok) {
        setError('The export could not be produced.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vtula-report-${period}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('The export could not be downloaded.');
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Aggregating the register…</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className={styles.gate}>
        <Lock size={40} style={{ color: 'var(--text-muted)' }} />
        <h2>Departmental reporting</h2>
        <p>
          These figures cover every business in a jurisdiction, so they are limited to Legal
          Metrology officers and administrators. Your own instruments, applications and
          certificates are on their respective pages.
        </p>
      </div>
    );
  }

  if (!view) {
    return (
      <div className={styles.page}>
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error ?? 'The report could not be produced.'}</span>
        </div>
      </div>
    );
  }

  const { report, months } = view;
  const h = report.headline;

  const categories = report.byInstrumentCategory
    .slice(0, CATEGORY_LIMIT)
    .map((c) => ({ label: c.type, count: c.count }));
  const hiddenCategories = report.byInstrumentCategory.slice(CATEGORY_LIMIT);
  const hiddenCategoryCount = hiddenCategories.reduce((sum, c) => sum + c.count, 0);

  const scopeText =
    report.scope.level === 'national'
      ? 'All states and union territories'
      : report.scope.level === 'state'
        ? (report.scope.state ?? 'Your state')
        : [report.scope.district, report.scope.state].filter(Boolean).join(', ') ||
          'Your jurisdiction';

  const anyRevenue = months.some((m) => m.revenue > 0);
  const anyApplications = months.some((m) => m.applications > 0);

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Reports</h1>
          <p>
            {scopeText} · {report.period.label} ({formatDate(report.period.from)} —{' '}
            {formatDate(report.period.to)})
          </p>
        </div>
        <button className="clay-btn clay-btn-primary" onClick={exportCsv} disabled={exporting}>
          {exporting ? <Loader2 size={18} className={styles.spin} /> : <Download size={18} />}
          {exporting ? 'Preparing…' : 'Export CSV'}
        </button>
      </div>

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      )}

      {/*
        * Revenue, throughput and SLA all read against a period. The endpoint
        * defaults to the Indian financial year, which is the period a Legal
        * Metrology office actually reports against.
        */}
      <div className={styles.periodTabs} role="group" aria-label="Reporting period">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`${styles.periodTab} ${period === p.value ? styles.periodTabActive : ''}`}
            onClick={() => setPeriod(p.value)}
            aria-pressed={period === p.value}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className={styles.metricsGrid}>
        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <div
              className={styles.metricIcon}
              style={{ background: 'rgba(23, 117, 83, 0.1)', color: GREEN }}
            >
              <IndianRupee size={22} />
            </div>
          </div>
          <div className={styles.metricVal}>{formatInrCompact(h.revenue.collected)}</div>
          <div className={styles.metricLabel}>Fees collected</div>
          <p className={styles.metricNote}>
            {h.revenue.payments} payment{h.revenue.payments === 1 ? '' : 's'} banked ·{' '}
            {formatInr(h.revenue.collected)}
          </p>
        </div>

        {/* Assessed but not banked. A district's position needs both halves. */}
        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <div
              className={styles.metricIcon}
              style={{ background: 'rgba(128, 59, 41, 0.1)', color: WARM }}
            >
              <Wallet size={22} />
            </div>
          </div>
          <div className={styles.metricVal}>{formatInrCompact(h.revenue.outstanding)}</div>
          <div className={styles.metricLabel}>Fees outstanding</div>
          <p className={styles.metricNote}>
            {h.revenue.outstandingApplications} application
            {h.revenue.outstandingApplications === 1 ? '' : 's'} awaiting payment
            {h.revenue.collectionRate !== null && ` · ${h.revenue.collectionRate}% collected`}
          </p>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <div
              className={styles.metricIcon}
              style={{ background: 'rgba(78, 148, 195, 0.14)', color: BLUE }}
            >
              <Building2 size={22} />
            </div>
          </div>
          <div className={styles.metricVal}>{h.applications.open.toLocaleString('en-IN')}</div>
          <div className={styles.metricLabel}>Applications in progress</div>
          <p className={styles.metricNote}>
            {h.applications.inPeriod.toLocaleString('en-IN')} filed this period ·{' '}
            {h.applications.total.toLocaleString('en-IN')} all time
          </p>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <div
              className={styles.metricIcon}
              style={{ background: 'rgba(129, 178, 154, 0.16)', color: 'var(--color-secondary-dark)' }}
            >
              <Award size={22} />
            </div>
          </div>
          <div className={styles.metricVal}>{h.certificates.active.toLocaleString('en-IN')}</div>
          <div className={styles.metricLabel}>Certificates in force</div>
          <p className={styles.metricNote}>
            {h.certificates.expiringSoon} due for renewal · {h.certificates.expired} lapsed
          </p>
        </div>
      </div>

      {/* Performance, stated as figures because two numbers do not need a chart. */}
      <div className={styles.statRow}>
        <div className={styles.statTile}>
          <Timer size={17} />
          <div>
            <div className={styles.statTileVal}>
              {report.sla.onTimePercent === null ? '—' : `${report.sla.onTimePercent}%`}
            </div>
            <div className={styles.statTileLabel}>
              Decided within target
              {report.sla.withTarget > 0 && (
                <>
                  {' '}
                  ({report.sla.onTime} of {report.sla.withTarget})
                </>
              )}
            </div>
          </div>
        </div>

        <div className={styles.statTile}>
          <Gauge size={17} />
          <div>
            <div className={styles.statTileVal}>
              {report.sla.averageTurnaroundDays === null
                ? '—'
                : `${report.sla.averageTurnaroundDays} d`}
            </div>
            <div className={styles.statTileLabel}>
              Average time to decide
              {report.sla.medianTurnaroundDays !== null &&
                ` · median ${report.sla.medianTurnaroundDays} d`}
            </div>
          </div>
        </div>

        <div className={styles.statTile}>
          <Scale size={17} />
          <div>
            <div className={styles.statTileVal}>
              {h.instruments.active.toLocaleString('en-IN')}
            </div>
            <div className={styles.statTileLabel}>
              Instruments in service · {h.instruments.total.toLocaleString('en-IN')} on the register
            </div>
          </div>
        </div>

        <div className={styles.statTile}>
          <ShieldAlert size={17} />
          <div>
            <div className={styles.statTileVal}>{h.openRiskFlags.toLocaleString('en-IN')}</div>
            <div className={styles.statTileLabel}>
              Open risk flags · {h.officers} verifying officer{h.officers === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      </div>

      {/*
        * `decided` is capped at 5,000 records server-side. Saying so is the
        * difference between an average and an average of an unstated sample.
        */}
      {report.sla.truncated && (
        <div className={styles.warnBox}>
          <AlertTriangle size={17} />
          <span>
            Turnaround is averaged over the 5,000 most recent decisions in this period, not all of
            them. Narrow the period for an exact figure.
          </span>
        </div>
      )}

      <div className={styles.chartGrid}>
        <section className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <h3>Applications received</h3>
            <p>Last twelve months, by the month they were filed.</p>
          </div>
          {anyApplications ? (
            <ResponsiveContainer width="100%" height={252}>
              <BarChart data={months} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={{ stroke: GRID }}
                  tick={{ fill: MUTED, fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tick={{ fill: MUTED, fontSize: 11 }}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(61, 64, 91, 0.05)' }}
                  content={
                    <ChartTooltip
                      titleKey="label"
                      fields={[
                        { key: 'applications', label: 'Received' },
                        { key: 'approved', label: 'Approved' },
                        { key: 'rejected', label: 'Rejected' },
                        { key: 'undecided', label: 'Still open' },
                      ]}
                    />
                  }
                />
                <Bar dataKey="applications" fill={BLUE} maxBarSize={24} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className={styles.emptyChart}>No applications have been filed in the last year.</p>
          )}
        </section>

        <section className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <h3>Fees collected</h3>
            <p>By the month the payment cleared, not the month the application was filed.</p>
          </div>
          {anyRevenue ? (
            <ResponsiveContainer width="100%" height={252}>
              <BarChart data={months} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={{ stroke: GRID }}
                  tick={{ fill: MUTED, fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={62}
                  tick={{ fill: MUTED, fontSize: 11 }}
                  tickFormatter={(v: number) => formatInrCompact(v)}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(61, 64, 91, 0.05)' }}
                  content={
                    <ChartTooltip
                      titleKey="label"
                      fields={[{ key: 'revenue', label: 'Collected', money: true }]}
                    />
                  }
                />
                <Bar dataKey="revenue" fill={GREEN} maxBarSize={24} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className={styles.emptyChart}>No fees have been banked in the last year.</p>
          )}
        </section>
      </div>

      <div className={styles.chartGrid}>
        {/*
          * Where the work is sitting, right now — not a period figure. The status
          * names are the axis, so identity comes from the label rather than from
          * a colour a reader has to match against a key.
          */}
        <section className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <h3>Where applications stand</h3>
            <p>Every application on the register, by its current stage.</p>
          </div>
          {report.funnel.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(170, report.funnel.length * 36)}>
              <BarChart
                data={report.funnel}
                layout="vertical"
                margin={{ top: 4, right: 44, bottom: 4, left: 0 }}
              >
                <CartesianGrid horizontal={false} stroke={GRID} />
                <XAxis type="number" hide allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={148}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: SECONDARY, fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(61, 64, 91, 0.05)' }}
                  content={
                    <ChartTooltip
                      titleKey="label"
                      fields={[{ key: 'count', label: 'Applications' }]}
                    />
                  }
                />
                <Bar dataKey="count" fill={WARM} maxBarSize={24} radius={[0, 4, 4, 0]}>
                  <LabelList
                    dataKey="count"
                    position="right"
                    fill={INK}
                    fontSize={11}
                    fontWeight={600}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className={styles.emptyChart}>No applications on the register yet.</p>
          )}
        </section>

        <section className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <h3>Instruments by category</h3>
            <p>
              {hiddenCategories.length > 0
                ? `The ${CATEGORY_LIMIT} largest categories. ${hiddenCategories.length} smaller ones account for a further ${hiddenCategoryCount.toLocaleString('en-IN')} instruments — the CSV export lists every category.`
                : 'Every category on the register.'}
            </p>
          </div>
          {categories.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(170, categories.length * 36)}>
              <BarChart
                data={categories}
                layout="vertical"
                margin={{ top: 4, right: 44, bottom: 4, left: 0 }}
              >
                <CartesianGrid horizontal={false} stroke={GRID} />
                <XAxis type="number" hide allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={168}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: SECONDARY, fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(61, 64, 91, 0.05)' }}
                  content={
                    <ChartTooltip
                      titleKey="label"
                      fields={[{ key: 'count', label: 'Instruments' }]}
                    />
                  }
                />
                <Bar dataKey="count" fill={BLUE} maxBarSize={24} radius={[0, 4, 4, 0]}>
                  <LabelList
                    dataKey="count"
                    position="right"
                    fill={INK}
                    fontSize={11}
                    fontWeight={600}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className={styles.emptyChart}>No instruments on the register yet.</p>
          )}
        </section>
      </div>

      <div className={styles.chartGrid}>
        <section className={styles.tableCard}>
          <div className={styles.tableCardHeader}>
            <h3>Inspections</h3>
            <p>
              Submitted inspections carried out in this period. Corrected inspections are counted
              once, against the version that stands.
            </p>
          </div>
          {report.inspections.total === 0 ? (
            <p className={styles.emptyChart}>No inspections were submitted in this period.</p>
          ) : (
            <>
              <div className={styles.bigFigure}>
                {report.inspections.passRate === null ? '—' : `${report.inspections.passRate}%`}
                <span>
                  passed, across {report.inspections.total.toLocaleString('en-IN')} inspection
                  {report.inspections.total === 1 ? '' : 's'}
                </span>
              </div>
              <div className={styles.resultRows}>
                {Object.keys(INSPECTION_RESULTS).map((key) => {
                  const count = report.inspections.byResult[key] ?? 0;
                  const share = Math.round((count / report.inspections.total) * 1000) / 10;
                  return (
                    <div key={key} className={styles.resultRow}>
                      <span>{INSPECTION_RESULTS[key]}</span>
                      <div className={styles.shareTrack}>
                        <div className={styles.shareFill} style={{ width: `${share}%` }} />
                      </div>
                      <strong>
                        {count.toLocaleString('en-IN')} <em>{share}%</em>
                      </strong>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        <section className={styles.tableCard}>
          <div className={styles.tableCardHeader}>
            <h3>By verification type</h3>
            <p>Applications filed in this period, and the fees banked against them.</p>
          </div>
          {report.byVerificationType.length === 0 ? (
            <p className={styles.emptyChart}>Nothing was filed in this period.</p>
          ) : (
            <div className="clay-table-wrapper">
              <table className="clay-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th className={styles.numeric}>Applications</th>
                    <th className={styles.numeric}>Fees banked</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byVerificationType.map((t) => (
                    <tr key={t.type}>
                      <td>
                        <strong>{t.label}</strong>
                      </td>
                      <td className={styles.numeric}>{t.count.toLocaleString('en-IN')}</td>
                      <td className={styles.numeric}>{formatInr(t.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <div className={styles.tableCard}>
        <div className={styles.tableCardHeader}>
          <h3>By district</h3>
          <p>
            Counted from the jurisdiction recorded on each application — the district the work was
            done in. Applications with no district recorded appear as &ldquo;Not recorded&rdquo;
            rather than being folded into a real one.
          </p>
        </div>

        {report.byDistrict.length === 0 ? (
          <p className={styles.emptyChart}>No applications have been filed in your jurisdiction.</p>
        ) : (
          <div className="clay-table-wrapper">
            <table className="clay-table">
              <thead>
                <tr>
                  <th>District</th>
                  <th className={styles.numeric}>Applications</th>
                  <th className={styles.numeric}>Open</th>
                  <th className={styles.numeric}>Overdue</th>
                  <th className={styles.numeric}>Certificates</th>
                  <th className={styles.numeric}>Fees banked</th>
                  <th className={styles.numeric}>Outstanding</th>
                  <th>SLA</th>
                </tr>
              </thead>
              <tbody>
                {report.byDistrict.map((d) => {
                  const sla = SLA_STATUS[d.slaStatus] ?? {
                    label: d.slaStatus,
                    badge: 'clay-badge-info',
                  };
                  return (
                    <tr key={`${d.state}-${d.district}`}>
                      <td>
                        <strong>{d.district}</strong>
                        {report.scope.level === 'national' && (
                          <div className={styles.subCell}>{d.state}</div>
                        )}
                      </td>
                      <td className={styles.numeric}>{d.applications.toLocaleString('en-IN')}</td>
                      <td className={styles.numeric}>{d.open.toLocaleString('en-IN')}</td>
                      <td className={`${styles.numeric} ${d.overdue > 0 ? styles.overdue : ''}`}>
                        {d.overdue.toLocaleString('en-IN')}
                      </td>
                      <td className={styles.numeric}>
                        {d.certificatesIssued.toLocaleString('en-IN')}
                      </td>
                      <td className={styles.numeric}>{formatInr(d.revenue)}</td>
                      <td className={styles.numeric}>{formatInr(d.outstanding)}</td>
                      <td>
                        <span className={`clay-badge ${sla.badge}`}>{sla.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {report.byDistrict.length >= 100 && (
          <p className={styles.tableFoot}>
            Showing the 100 busiest districts. The CSV export carries the same 100 rows.
          </p>
        )}
      </div>

      <p className={styles.generated}>
        Aggregated from the register at {formatDateTime(report.generatedAt)}. Figures are live — a
        report exported a minute apart may differ.
      </p>
    </div>
  );
}

/* --- Tooltip -------------------------------------------------------------- */

type Datum = Record<string, string | number>;

/**
 * Recharts clones this element and injects `active` and `payload`, which is why
 * both are optional. `fields` is supplied at the call site so each chart names
 * its own numbers instead of showing a raw `dataKey`.
 */
function ChartTooltip({
  active,
  payload,
  titleKey,
  fields,
}: {
  active?: boolean;
  payload?: { payload: Datum }[];
  titleKey: string;
  fields: { key: string; label: string; money?: boolean }[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;

  return (
    <div className={styles.tooltip}>
      <strong>{String(d[titleKey] ?? '')}</strong>
      {fields.map((f) => {
        const value = Number(d[f.key] ?? 0);
        return (
          <div key={f.key} className={styles.tooltipRow}>
            <span>{f.label}</span>
            <b>{f.money ? formatInr(value) : value.toLocaleString('en-IN')}</b>
          </div>
        );
      })}
    </div>
  );
}
