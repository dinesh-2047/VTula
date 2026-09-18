'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Building2,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileWarning,
  Gauge,
  Info,
  Loader2,
  Minus,
  RefreshCw,
  Search,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { formatDate, formatDateTime, type Role } from '@/lib/constants';
import styles from './compliance.module.css';

/**
 * Compliance Health Score — the page.
 *
 * `src/lib/compliance.ts` has computed an explainable five-component score since
 * early on, and `/api/compliance` serves it. Nothing rendered it. The only caller
 * was the nightly alerts sweep, which wrote snapshots into a collection no page
 * read — so a business never saw its own score, and an officer had no way to ask
 * "who in my district needs attention" short of reading every register in turn.
 *
 * Meanwhile the profile page told every business "your compliance score is 100",
 * from `Organization.complianceScore` — a field with a default of 100 and no writer
 * anywhere in the codebase. That number has been removed; this page is where the
 * real one lives.
 *
 * Two audiences, and the API decides which by returning `view`:
 *
 *  - `view: 'business'` — one business's score, computed live, with the component
 *    breakdown and the recommendations. An owner always gets this, for themselves.
 *  - `view: 'jurisdiction'` — the roster, worst first. Only LMO, State Admin and
 *    system Admin: a GATC laboratory is not a supervisor of businesses.
 *
 * The page never derives a grade, a total or a recommendation of its own. Every
 * number here is the server's, for the same reason the enforcement console renders
 * `allowedNextStatuses` rather than working out transitions client-side — two
 * implementations of one rule is one implementation too many.
 */

/* ── The server's shapes ─────────────────────────────────────────── */

interface Component {
  key: string;
  label: string;
  earned: number;
  possible: number;
  detail: string;
}

interface Stats {
  totalInstruments: number;
  verifiedInstruments: number;
  expiringSoon: number;
  expired: number;
  openRiskFlags: number;
  openEnforcementCases: number;
  lateRenewals: number;
  onTimeRenewals: number;
}

interface BusinessPayload {
  view: 'business';
  business: {
    ownerId: string;
    name: string;
    organizationName?: string;
    state?: string;
    district?: string;
  };
  score: number;
  grade: string;
  breakdown: Component[];
  stats: Stats;
  recommendations: string[];
  trend: {
    points: { score: number; grade: string; at: string }[];
    changeSinceLastSnapshot: number | null;
    direction: 'new' | 'improving' | 'declining' | 'flat';
    lastSnapshotAt: string | null;
  };
  computedAt: string;
  isLive: boolean;
}

interface RosterRow {
  ownerId: string;
  name: string;
  organizationName?: string;
  state?: string;
  district?: string;
  score: number | null;
  grade: string | null;
  stats: Stats | null;
  topRecommendation?: string;
  computedAt: string | null;
  stale: boolean;
}

interface JurisdictionPayload {
  view: 'jurisdiction';
  businesses: RosterRow[];
  summary: {
    assessed: number;
    unassessed: number;
    averageScore: number | null;
    byGrade: Record<string, number>;
  };
  truncated?: boolean;
  note?: string;
}

type Payload = BusinessPayload | JurisdictionPayload;

/* ── Grades ──────────────────────────────────────────────────────── */

/**
 * What each grade means, in the words a business would use.
 *
 * The thresholds live in `gradeFor` in `src/lib/compliance.ts` and are not repeated
 * here — only the reading of the letter, which the API does not send.
 */
const GRADE_MEANING: Record<string, string> = {
  A: 'Everything is verified and nothing is close to lapsing.',
  B: 'Broadly in order, with one or two things to attend to.',
  C: 'Several things need attention. Nothing here is an accusation, but it will not stay this way on its own.',
  D: 'A significant part of the estate is unverified or lapsed.',
  E: 'Most instruments cannot lawfully be used for trade in this state.',
};

const GRADE_CLASS: Record<string, string> = {
  A: styles.gradeA,
  B: styles.gradeB,
  C: styles.gradeC,
  D: styles.gradeD,
  E: styles.gradeE,
};

function gradeClass(grade: string | null): string {
  return (grade && GRADE_CLASS[grade]) || styles.gradeNone;
}

/** Icons for the five components, in the order the engine emits them. */
const COMPONENT_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  coverage: BadgeCheck,
  timeliness: Clock,
  renewalHistory: RefreshCw,
  riskFlags: FileWarning,
  enforcement: ShieldAlert,
};

/* ── The dial ────────────────────────────────────────────────────── */

/**
 * The score as a ring.
 *
 * Drawn rather than charted because the one number is the point, and a library
 * would be a dependency for a single arc. The arc is the score out of 100 — not
 * out of the highest score in the jurisdiction, which would make a bad score look
 * respectable in a bad district.
 */
function Dial({ score, grade }: { score: number; grade: string }) {
  const R = 62;
  const CIRC = 2 * Math.PI * R;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * CIRC;

  return (
    <div className={`${styles.dial} ${gradeClass(grade)}`}>
      <svg viewBox="0 0 150 150" role="img" aria-label={`Score ${score} out of 100, grade ${grade}`}>
        <circle cx="75" cy="75" r={R} className={styles.dialTrack} />
        <circle
          cx="75"
          cy="75"
          r={R}
          className={styles.dialArc}
          strokeDasharray={`${filled} ${CIRC - filled}`}
          strokeDashoffset={CIRC / 4}
        />
      </svg>
      <div className={styles.dialCentre}>
        <span className={styles.dialScore}>{score}</span>
        <span className={styles.dialOf}>out of 100</span>
        <span className={styles.dialGrade}>Grade {grade}</span>
      </div>
    </div>
  );
}

/**
 * The trend as a sparkline.
 *
 * Snapshots are irregular — the nightly sweep writes one, an approved application
 * writes one, an officer pressing "record" writes one — so the horizontal axis is
 * *snapshot order*, not time, and the caption says so. Spacing them by date would
 * imply a regular series that does not exist.
 */
function Spark({ points }: { points: { score: number; at: string }[] }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const W = 260;
    const H = 54;
    const step = W / (points.length - 1);
    return points
      .map((p, i) => {
        const x = i * step;
        const y = H - (Math.max(0, Math.min(100, p.score)) / 100) * H;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [points]);

  if (!path) return null;

  return (
    <svg className={styles.spark} viewBox="0 0 260 54" preserveAspectRatio="none" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

/* ── One business ────────────────────────────────────────────────── */

function BusinessView({
  data,
  onSnapshot,
  snapshotting,
  snapshotNote,
  onBack,
}: {
  data: BusinessPayload;
  onSnapshot: () => void;
  snapshotting: boolean;
  snapshotNote: string | null;
  onBack?: () => void;
}) {
  const { business, score, grade, breakdown, stats, recommendations, trend } = data;
  const label = business.organizationName || business.name;

  return (
    <div className={styles.page}>
      {onBack && (
        <button type="button" className={styles.backLink} onClick={onBack}>
          <ArrowLeft size={15} />
          Back to the jurisdiction list
        </button>
      )}

      <header className={styles.header}>
        <div>
          <h1>
            <Gauge size={26} />
            Compliance health
          </h1>
          <p className={styles.lead}>
            {onBack ? (
              <>
                {label}
                {business.district ? ` · ${business.district}` : ''}
                {business.state ? `, ${business.state}` : ''}
              </>
            ) : (
              <>
                One number for the state of your records, and every part of how it was
                worked out. It is advisory: it ranks what needs attention and it never
                decides an application.
              </>
            )}
          </p>
        </div>
      </header>

      {/* ── The number ── */}
      <section className={styles.scoreRow}>
        <Dial score={score} grade={grade} />

        <div className={styles.scoreSide}>
          <p className={styles.gradeMeaning}>{GRADE_MEANING[grade] ?? ''}</p>

          {/*
            * Direction before delta. "Improving" is the thing a business wants to
            * know; the number of points is detail.
            */}
          <div className={styles.trendRow}>
            {trend.direction === 'improving' ? (
              <span className={`${styles.trendPill} ${styles.trendUp}`}>
                <TrendingUp size={14} />
                Improving
                {trend.changeSinceLastSnapshot != null &&
                  ` · +${trend.changeSinceLastSnapshot} since the last assessment`}
              </span>
            ) : trend.direction === 'declining' ? (
              <span className={`${styles.trendPill} ${styles.trendDown}`}>
                <TrendingDown size={14} />
                Declining
                {trend.changeSinceLastSnapshot != null &&
                  ` · ${trend.changeSinceLastSnapshot} since the last assessment`}
              </span>
            ) : trend.direction === 'flat' ? (
              <span className={`${styles.trendPill} ${styles.trendFlat}`}>
                <Minus size={14} />
                Unchanged since the last assessment
              </span>
            ) : (
              <span className={`${styles.trendPill} ${styles.trendFlat}`}>
                <Activity size={14} />
                First assessment — no trend yet
              </span>
            )}
          </div>

          {trend.points.length >= 2 && (
            <div className={styles.sparkWrap}>
              <Spark points={trend.points} />
              <span className={styles.sparkCaption}>
                {trend.points.length} recorded assessments, oldest first. Assessments are not
                taken on a fixed schedule, so the spacing is order and not time.
              </span>
            </div>
          )}

          <p className={styles.liveNote}>
            <Info size={13} />
            Worked out just now from your current records
            {trend.lastSnapshotAt
              ? `. The last assessment kept on file was ${formatDateTime(trend.lastSnapshotAt)}.`
              : '. Nothing has been recorded on file yet.'}
          </p>

          <div className={styles.snapshotRow}>
            <button
              type="button"
              className="clay-btn clay-btn-outline clay-btn-sm"
              onClick={onSnapshot}
              disabled={snapshotting}
            >
              {snapshotting ? <Loader2 size={14} className={styles.spin} /> : <ClipboardList size={14} />}
              {snapshotting ? 'Recording…' : 'Record this assessment'}
            </button>
            {/*
              * Said plainly, because the button does not do the obvious thing: it
              * does not recompute — the figure above is already live — it files the
              * figure so it becomes a point on the trend.
              */}
            <span className={styles.snapshotHint}>
              Adds today&apos;s figure to the record above. At most one an hour.
            </span>
          </div>
          {snapshotNote && (
            <p className={styles.snapshotNote}>
              <CheckCircle2 size={14} />
              {snapshotNote}
            </p>
          )}
        </div>
      </section>

      {/* ── How it was worked out ── */}
      <section className={styles.card}>
        <h2>
          <ClipboardList size={16} />
          How the number was worked out
        </h2>
        <p className={styles.cardLead}>
          Five parts, each worth a fixed share. Every part says what it counted, so
          nothing here has to be taken on trust.
        </p>
        <ul className={styles.components}>
          {breakdown.map((comp) => {
            const Icon = COMPONENT_ICONS[comp.key] ?? BadgeCheck;
            const pct = comp.possible > 0 ? Math.round((comp.earned / comp.possible) * 100) : 0;
            return (
              <li key={comp.key} className={styles.component}>
                <div className={styles.componentHead}>
                  <span className={styles.componentLabel}>
                    <Icon size={15} />
                    {comp.label}
                  </span>
                  <span className={styles.componentScore}>
                    {comp.earned}
                    <span className={styles.componentOf}>/{comp.possible}</span>
                  </span>
                </div>
                <div className={styles.bar}>
                  <div
                    className={pct >= 80 ? styles.barFillGood : pct >= 40 ? styles.barFillMid : styles.barFillPoor}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className={styles.componentDetail}>{comp.detail}</p>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── What to do ── */}
      <section className={styles.card}>
        <h2>
          <ArrowRight size={16} />
          What would raise it
        </h2>
        <ol className={styles.recos}>
          {recommendations.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ol>
        {stats.expired > 0 && (
          <Link href="/dashboard/applications/new" className="clay-btn clay-btn-primary clay-btn-sm">
            Start a re-verification
            <ArrowRight size={14} />
          </Link>
        )}
      </section>

      {/* ── The counts behind it ── */}
      <section className={styles.card}>
        <h2>
          <Activity size={16} />
          The counts behind it
        </h2>
        <dl className={styles.statGrid}>
          <div className={styles.stat}>
            <dt>Instruments registered</dt>
            <dd>{stats.totalInstruments}</dd>
          </div>
          <div className={styles.stat}>
            <dt>Holding a valid certificate</dt>
            <dd>{stats.verifiedInstruments}</dd>
          </div>
          <div className={`${styles.stat} ${stats.expiringSoon > 0 ? styles.statWarn : ''}`}>
            <dt>Expiring soon</dt>
            <dd>{stats.expiringSoon}</dd>
          </div>
          <div className={`${styles.stat} ${stats.expired > 0 ? styles.statBad : ''}`}>
            <dt>Expired</dt>
            <dd>{stats.expired}</dd>
          </div>
          <div className={`${styles.stat} ${stats.openRiskFlags > 0 ? styles.statWarn : ''}`}>
            <dt>Open queries</dt>
            <dd>{stats.openRiskFlags}</dd>
          </div>
          <div className={`${styles.stat} ${stats.openEnforcementCases > 0 ? styles.statBad : ''}`}>
            <dt>Open enforcement cases</dt>
            <dd>{stats.openEnforcementCases}</dd>
          </div>
          <div className={styles.stat}>
            <dt>Renewals on time</dt>
            <dd>{stats.onTimeRenewals}</dd>
          </div>
          <div className={`${styles.stat} ${stats.lateRenewals > 0 ? styles.statWarn : ''}`}>
            <dt>Renewals after lapse</dt>
            <dd>{stats.lateRenewals}</dd>
          </div>
        </dl>
      </section>

      <p className={styles.footNote}>
        This score measures the state of records, not the honesty of a business. It ranks
        what needs attention; it is never on its own a ground for enforcement, and no
        application is decided by it.
      </p>
    </div>
  );
}

/* ── The jurisdiction roster ─────────────────────────────────────── */

function RosterView({
  data,
  onOpen,
}: {
  data: JurisdictionPayload;
  onOpen: (ownerId: string) => void;
}) {
  const { businesses, summary } = data;
  const [needle, setNeedle] = useState('');

  /*
   * Filtered here rather than by a round trip. The API returns the whole roster in
   * one response — up to its 500 cap — so there is nothing to fetch, and an officer
   * looking for one shop should not wait for the network to find a row they already
   * have.
   */
  const rows = useMemo(() => {
    const q = needle.trim().toLowerCase();
    if (!q) return businesses;
    return businesses.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.organizationName ?? '').toLowerCase().includes(q) ||
        (b.district ?? '').toLowerCase().includes(q)
    );
  }, [businesses, needle]);

  const grades = ['A', 'B', 'C', 'D', 'E'];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>
            <Gauge size={26} />
            Compliance health
          </h1>
          <p className={styles.lead}>
            Every business in your jurisdiction, worst first. The score is advisory — it
            says where to look, not what to do.
          </p>
        </div>
      </header>

      {data.note ? (
        <p className={styles.emptyNote}>
          <Info size={16} />
          {data.note}
        </p>
      ) : (
        <>
          <section className={styles.summaryRow}>
            <div className={styles.summaryTile}>
              <span className={styles.summaryValue}>
                {summary.averageScore != null ? summary.averageScore : '—'}
              </span>
              <span className={styles.summaryLabel}>Average score</span>
            </div>
            <div className={styles.summaryTile}>
              <span className={styles.summaryValue}>{summary.assessed}</span>
              <span className={styles.summaryLabel}>Assessed</span>
            </div>
            <div className={styles.summaryTile}>
              <span className={styles.summaryValue}>{summary.unassessed}</span>
              <span className={styles.summaryLabel}>Never assessed</span>
            </div>
            {/*
              * A distribution rather than a second average. Two districts with the
              * same mean look identical until you see that one of them holds nine
              * E-grades.
              */}
            <div className={`${styles.summaryTile} ${styles.summaryWide}`}>
              <span className={styles.summaryLabel}>By grade</span>
              <div className={styles.gradeBars}>
                {grades.map((g) => {
                  const n = summary.byGrade[g] ?? 0;
                  const pct = summary.assessed > 0 ? (n / summary.assessed) * 100 : 0;
                  return (
                    <div key={g} className={styles.gradeBarRow}>
                      <span className={`${styles.gradeChip} ${gradeClass(g)}`}>{g}</span>
                      <div className={styles.gradeBarTrack}>
                        <div
                          className={`${styles.gradeBarFill} ${gradeClass(g)}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className={styles.gradeBarCount}>{n}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {summary.unassessed > 0 && (
            <p className={styles.warnNote}>
              <AlertTriangle size={15} />
              {summary.unassessed} of these {businesses.length} businesses have never been
              assessed, and are listed last. A score appears once the nightly sweep reaches
              them, or immediately if you open one and record an assessment.
            </p>
          )}

          {data.truncated && (
            <p className={styles.warnNote}>
              <AlertTriangle size={15} />
              This list stops at 500 businesses. There are more in your jurisdiction than are
              shown — narrow by district, or use the registers, until this page is paged.
            </p>
          )}

          <section className={styles.card}>
            <div className={styles.tableHead}>
              <h2>
                <Building2 size={16} />
                Businesses
                <span className={styles.countPill}>{rows.length}</span>
              </h2>
              <div className={styles.searchForm}>
                <Search size={15} />
                <input
                  type="search"
                  value={needle}
                  onChange={(e) => setNeedle(e.target.value)}
                  placeholder="Filter by name or district"
                  aria-label="Filter the list"
                />
                {needle && (
                  <button
                    type="button"
                    className={styles.searchClear}
                    onClick={() => setNeedle('')}
                    aria-label="Clear the filter"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            {rows.length === 0 ? (
              <p className={styles.emptyNote}>
                <Info size={16} />
                No business in the list matches “{needle}”.
              </p>
            ) : (
              <div className="clay-table-wrapper">
                <table className="clay-table">
                  <thead>
                    <tr>
                      <th>Business</th>
                      <th>Where</th>
                      <th>Score</th>
                      <th>Needs attention</th>
                      <th>Assessed</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b) => (
                      <tr key={b.ownerId}>
                        <td>
                          <strong>{b.organizationName || b.name}</strong>
                          {b.organizationName && b.organizationName !== b.name && (
                            <span className={styles.subName}>{b.name}</span>
                          )}
                        </td>
                        <td className={styles.whereCell}>
                          {b.district ?? '—'}
                          {b.state ? <span className={styles.subName}>{b.state}</span> : null}
                        </td>
                        <td>
                          {/*
                            * Never assessed is not a low score. Rendering a null as
                            * 0 would put a business that nothing has looked at yet
                            * at the top of an enforcement officer's list.
                            */}
                          {b.score == null ? (
                            <span className={styles.notAssessed}>Not assessed</span>
                          ) : (
                            <span className={`${styles.scoreCell} ${gradeClass(b.grade)}`}>
                              <span className={styles.scoreCellNum}>{b.score}</span>
                              <span className={styles.gradeChipSm}>{b.grade}</span>
                            </span>
                          )}
                        </td>
                        <td className={styles.recoCell}>{b.topRecommendation ?? '—'}</td>
                        <td className={styles.whenCell}>
                          {b.computedAt ? formatDate(b.computedAt) : '—'}
                          {b.computedAt && b.stale && (
                            <span className={styles.staleFlag}>
                              <Clock size={11} />
                              over a week old
                            </span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="clay-btn clay-btn-ghost clay-btn-sm"
                            onClick={() => onOpen(b.ownerId)}
                          >
                            Open
                            <ArrowRight size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <p className={styles.footNote}>
        A score is a ranking of records, not a finding against a business. Opening one
        recomputes it live, which is why a figure on this page may differ from the figure
        on the business&apos;s own — this list reads the last assessment on file.
      </p>
    </div>
  );
}

/* ── The page ────────────────────────────────────────────────────── */

function ComplianceView() {
  const router = useRouter();
  const urlParams = useSearchParams();
  const { data: session, status } = useSession();
  const role: Role | undefined = session?.user?.role;

  const ownerId = urlParams.get('ownerId');

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);
  const [snapshotNote, setSnapshotNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/compliance${ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : ''}`);
      const body = (await res.json()) as Payload & { success: boolean; error?: string };
      if (!body.success) {
        setError(body.error || 'That could not be loaded.');
        setData(null);
        return;
      }
      setError(null);
      setData(body);
    } catch {
      setError('Could not reach the server.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

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

  /*
   * The snapshot is a POST and then a reload, because the reload is what puts the
   * new point on the trend. Returning `created: false` is not a failure — it is the
   * once-an-hour rule, and the server's own sentence says so better than a generic
   * "already done" would.
   */
  const snapshot = useCallback(async () => {
    setSnapshotting(true);
    setSnapshotNote(null);
    try {
      const res = await fetch('/api/compliance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ownerId ? { ownerId } : {}),
      });
      const body = (await res.json()) as {
        success: boolean;
        error?: string;
        created?: boolean;
        message?: string;
        score?: number;
      };
      if (!body.success) {
        setSnapshotNote(body.error || 'That could not be recorded.');
        return;
      }
      setSnapshotNote(
        body.created
          ? `Assessment recorded — score ${body.score} is now on the file.`
          : (body.message ?? 'An assessment was already recorded recently.')
      );
      await load();
    } catch {
      setSnapshotNote('Could not reach the server. Nothing was recorded.');
    } finally {
      setSnapshotting(false);
    }
  }, [ownerId, load]);

  const openBusiness = useCallback(
    (id: string) => {
      setSnapshotNote(null);
      router.push(`/dashboard/compliance?ownerId=${encodeURIComponent(id)}`);
    },
    [router]
  );

  const backToRoster = useCallback(() => {
    setSnapshotNote(null);
    router.push('/dashboard/compliance');
  }, [router]);

  if (status === 'loading' || loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Working out the score…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.errorBox}>
          <AlertTriangle size={20} />
          <div>
            <strong>{error ?? 'Nothing to show.'}</strong>
            {/*
              * A testing centre reaching this page gets the server's own sentence
              * explaining why, rather than an empty table. The nav does not offer
              * them the link, so arriving here means a bookmark or a typed URL.
              */}
            {role === 'GATC' || role === 'GATCTechnician' ? (
              <span>
                Your lab tasks are under <Link href="/dashboard/tasks">Lab Tasks</Link>.
              </span>
            ) : (
              <button type="button" className="clay-btn clay-btn-outline clay-btn-sm" onClick={() => void load()}>
                <RefreshCw size={14} />
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (data.view === 'business') {
    return (
      <BusinessView
        data={data}
        onSnapshot={() => void snapshot()}
        snapshotting={snapshotting}
        snapshotNote={snapshotNote}
        onBack={ownerId ? backToRoster : undefined}
      />
    );
  }

  return <RosterView data={data} onOpen={openBusiness} />;
}

/**
 * `useSearchParams` client-side renders the tree up to the nearest Suspense
 * boundary when the route is prerendered, so the boundary has to exist.
 */
export default function CompliancePage() {
  return (
    <Suspense
      fallback={
        <div className={styles.loadingWrap}>
          <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
          <p>Loading compliance health…</p>
        </div>
      }
    >
      <ComplianceView />
    </Suspense>
  );
}
