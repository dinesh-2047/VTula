'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Scale,
  Loader2,
  AlertTriangle,
  Plus,
  X,
  History,
  Ban,
  Pencil,
  Info,
  Target,
  ShieldCheck,
  MapPin,
  Trash2,
} from 'lucide-react';
import {
  VERIFICATION_TYPE_LABELS,
  formatDate,
  formatDateTime,
  formatInr,
  type VerificationType,
} from '@/lib/constants';
import styles from './rules.module.css';

/**
 * Regulatory rule administration.
 *
 * The spec is explicit that validity periods, fees, required documents, evidence
 * minimums and SLA targets are configuration rather than code: they differ by state
 * and by instrument category, and they change when the law changes. `src/lib/rules.ts`
 * has always read them from the database and `/api/rules` has always been able to
 * write them — but nothing in the interface called it, so in practice every
 * deployment ran on the single seeded national default and no administrator could
 * see, let alone change, what their state charged.
 *
 * Two properties of the API shape this page, and both are worth stating on screen
 * because they surprise people:
 *
 *  - **An amendment supersedes; it does not edit.** A PATCH stands the current
 *    version down and writes version + 1. A certificate issued last month keeps the
 *    validity period it was issued under, and an inspector disputing a rejected
 *    reading can still see the tolerance table that was in force that day. So the
 *    dialog is titled "Amend", warns what will happen, and reports which version
 *    replaced which afterwards.
 *  - **What matters is not which rows exist but which one applies.** Resolution
 *    walks four scopes most-specific-first — state + category, state, category,
 *    national — so a newly added state rule only takes effect if nothing narrower
 *    outranks it. The probe at the top asks the server that question directly rather
 *    than having this page reimplement the precedence order and drift from it.
 */

interface FeeShape {
  base: number;
  reverificationMultiplier: number;
  repairMultiplier: number;
  transferMultiplier: number;
}

interface SlaShape {
  reviewDays: number;
  schedulingDays: number;
  decisionDays: number;
}

interface Tolerance {
  label: string;
  maxErrorPercent: number;
}

interface DocRef {
  code: string;
  label: string;
}

interface Rule {
  id: string;
  name: string;
  description?: string;
  scope: { state: string | null; instrumentType: string | null; label: string };
  validityMonths: number;
  expiryAlertOffsetsDays: number[];
  expiringSoonWindowDays: number;
  fee: FeeShape;
  feeTable: Record<string, number>;
  requiredDocuments: DocRef[];
  sla: SlaShape;
  slaTotalDays: number;
  tolerances: Tolerance[];
  minEvidencePhotos: number;
  requireGpsEvidence: boolean;
  gpsToleranceMetres: number;
  legalReference?: string;
  isActive: boolean;
  version: number;
  effectiveFrom?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Effective {
  ruleId?: string;
  ruleVersion?: number;
  name: string;
  validityMonths: number;
  expiryAlertOffsetsDays: number[];
  expiringSoonWindowDays: number;
  fee: FeeShape;
  feeTable: Record<string, number>;
  requiredDocuments: string[];
  sla: SlaShape;
  tolerances: Tolerance[];
  minEvidencePhotos: number;
  requireGpsEvidence: boolean;
  gpsToleranceMetres: number;
  legalReference?: string;
  matchedScope: string;
  probe: { state: string | null; instrumentType: string | null };
}

interface Options {
  states: string[];
  instrumentTypes: { code: string; family: string }[];
  documentTypes: DocRef[];
  verificationTypes: string[];
}

interface View {
  rules: Rule[];
  effective: Effective | null;
  options: Options;
  scope: string;
  canEditNational: boolean;
}

interface HistoryRow {
  id: string;
  name: string;
  version: number;
  isActive: boolean;
  effectiveFrom?: string;
  validityMonths: number;
  baseFee?: number;
  supersededAt?: string;
}

/** The writable half of a rule, as the form holds it. */
interface Draft {
  name: string;
  description: string;
  legalReference: string;
  state: string;
  instrumentType: string;
  validityMonths: number;
  expiringSoonWindowDays: number;
  expiryAlertOffsetsDays: number[];
  fee: FeeShape;
  requiredDocuments: string[];
  sla: SlaShape;
  tolerances: Tolerance[];
  minEvidencePhotos: number;
  requireGpsEvidence: boolean;
  gpsToleranceMetres: number;
  effectiveFrom: string;
}

/*
 * Mirrors `readRuleFields` in `src/lib/ruleAdmin.ts`. Kept in sync deliberately
 * rather than fetched: the server is still the authority and will reject anything
 * out of range, but a form that lets you type 0 months and only tells you after a
 * round trip is a worse form.
 */
const LIMITS = {
  validityMonths: { min: 1, max: 120 },
  expiringSoonWindowDays: { min: 1, max: 365 },
  offset: { min: 1, max: 365 },
  multiplier: { min: 0, max: 2 },
  slaStage: { min: 1, max: 90 },
  minEvidencePhotos: { min: 0, max: 20 },
  gpsToleranceMetres: { min: 0, max: 100_000 },
  maxErrorPercent: { min: 0, max: 100 },
};

const BASELINE: Omit<Draft, 'state' | 'instrumentType' | 'name' | 'effectiveFrom'> = {
  description: '',
  legalReference: '',
  validityMonths: 12,
  expiringSoonWindowDays: 30,
  expiryAlertOffsetsDays: [60, 30, 15, 7, 1],
  fee: { base: 500, reverificationMultiplier: 0.75, repairMultiplier: 0.9, transferMultiplier: 0.5 },
  requiredDocuments: [],
  sla: { reviewDays: 3, schedulingDays: 7, decisionDays: 3 },
  tolerances: [],
  minEvidencePhotos: 3,
  requireGpsEvidence: true,
  gpsToleranceMetres: 500,
};

/** `Math.round(base * multiplier)`, exactly as `computeFee` does it server-side. */
function previewFee(fee: FeeShape, type: VerificationType): number {
  const multiplier =
    type === 'reverification'
      ? fee.reverificationMultiplier
      : type === 'repair'
        ? fee.repairMultiplier
        : type === 'transfer'
          ? fee.transferMultiplier
          : 1;
  return Math.max(0, Math.round(fee.base * multiplier));
}

/** `<input type="date">` wants `YYYY-MM-DD`, and only ever in local terms. */
function dateInputValue(iso: string | undefined, fallback: Date): string {
  const d = iso ? new Date(iso) : fallback;
  const use = Number.isNaN(d.getTime()) ? fallback : d;
  return `${use.getFullYear()}-${String(use.getMonth() + 1).padStart(2, '0')}-${String(use.getDate()).padStart(2, '0')}`;
}

function draftFrom(rule: Rule, today: Date): Draft {
  return {
    name: rule.name,
    description: rule.description ?? '',
    legalReference: rule.legalReference ?? '',
    state: rule.scope.state ?? '',
    instrumentType: rule.scope.instrumentType ?? '',
    validityMonths: rule.validityMonths,
    expiringSoonWindowDays: rule.expiringSoonWindowDays,
    expiryAlertOffsetsDays: [...rule.expiryAlertOffsetsDays],
    fee: { ...rule.fee },
    requiredDocuments: rule.requiredDocuments.map((d) => d.code),
    sla: { ...rule.sla },
    tolerances: rule.tolerances.map((t) => ({ ...t })),
    minEvidencePhotos: rule.minEvidencePhotos,
    requireGpsEvidence: rule.requireGpsEvidence,
    gpsToleranceMetres: rule.gpsToleranceMetres,
    // An amendment takes effect now unless the administrator says otherwise; the
    // stored `effectiveFrom` belongs to the version being superseded.
    effectiveFrom: dateInputValue(undefined, today),
  };
}

export default function RulesPage() {
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [probeState, setProbeState] = useState('');
  const [probeType, setProbeType] = useState('');
  const [includeSuperseded, setIncludeSuperseded] = useState(false);

  const [editing, setEditing] = useState<{ rule: Rule | null; draft: Draft } | null>(null);
  const [history, setHistory] = useState<{ rule: Rule; rows: HistoryRow[] } | null>(null);

  const fetchRules = useCallback(async () => {
    const params = new URLSearchParams();
    if (probeState) params.set('probeState', probeState);
    if (probeType) params.set('probeInstrumentType', probeType);
    if (includeSuperseded) params.set('includeSuperseded', 'true');

    try {
      const res = await fetch(`/api/rules?${params.toString()}`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const data = (await res.json()) as { success: boolean; error?: string } & Partial<View>;
      if (!data.success || !data.options) {
        setError(data.error || 'Rules could not be loaded.');
        return;
      }
      setForbidden(false);
      setError(null);
      setView({
        rules: data.rules ?? [],
        effective: data.effective ?? null,
        options: data.options,
        scope: data.scope ?? 'national',
        canEditNational: data.canEditNational ?? false,
      });
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [probeState, probeType, includeSuperseded]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchRules();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchRules]);

  /*
   * Grouped for the category dropdown. Twenty-six flat options is an unhelpful
   * list, and a rule usually covers a family — every weighbridge, every dispenser —
   * rather than one model of one instrument.
   */
  const typesByFamily = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const t of view?.options.instrumentTypes ?? []) {
      const list = groups.get(t.family) ?? [];
      list.push(t.code);
      groups.set(t.family, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [view?.options.instrumentTypes]);

  function openAmend(rule: Rule) {
    setNotice(null);
    setEditing({ rule, draft: draftFrom(rule, new Date()) });
  }

  function openCreate() {
    setNotice(null);
    const today = new Date();
    setEditing({
      rule: null,
      draft: {
        ...BASELINE,
        name: '',
        // A StateAdmin can only write rules for their own state, so it is filled in
        // and locked rather than offered and then refused by the server.
        state: view?.canEditNational ? '' : view?.scope ?? '',
        instrumentType: '',
        effectiveFrom: dateInputValue(undefined, today),
      },
    });
  }

  async function loadHistory(rule: Rule) {
    setNotice(null);
    try {
      const res = await fetch(`/api/rules/${rule.id}`);
      const data = (await res.json()) as { success: boolean; error?: string; history?: HistoryRow[] };
      if (!data.success) {
        setError(data.error || 'The version history could not be loaded.');
        return;
      }
      setHistory({ rule, rows: data.history ?? [] });
    } catch {
      setError('Could not reach the server.');
    }
  }

  async function withdraw(rule: Rule) {
    const confirmed = window.confirm(
      `Withdraw "${rule.name}" (${rule.scope.label})?\n\n` +
        'The rule stays on record as history, but it stops applying. Applications in ' +
        'this scope will fall back to the next broader rule, which may change what ' +
        'applicants are charged and how long their certificates last.'
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/rules/${rule.id}`, { method: 'DELETE' });
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        message?: string;
        certificatesIssuedUnderIt?: number;
      };
      if (!data.success) {
        setError(data.error || 'The rule could not be withdrawn.');
        return;
      }
      const issued = data.certificatesIssuedUnderIt ?? 0;
      setNotice(
        `${data.message ?? 'Withdrawn.'}${issued > 0 ? ` ${issued} certificate${issued === 1 ? '' : 's'} issued under it keep the terms they were issued with.` : ''}`
      );
      await fetchRules();
    } catch {
      setError('Could not reach the server.');
    }
  }

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading rules…</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className={styles.gate}>
        <ShieldCheck size={44} style={{ color: 'var(--color-secondary)' }} />
        <h2>Rules are set by administrators</h2>
        <p>
          Fees, validity periods, required documents and SLA targets decide what every
          applicant in a jurisdiction pays and waits, so they are limited to State and
          system administrators. If a fee or a validity period looks wrong, raise it with
          your administrator rather than working around it.
        </p>
        <Link href="/dashboard" className="clay-btn clay-btn-outline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (!view) {
    return (
      <div className={styles.errorBox}>
        <AlertTriangle size={18} />
        <span>{error ?? 'Rules could not be loaded.'}</span>
      </div>
    );
  }

  const active = view.rules.filter((r) => r.isActive);
  const superseded = view.rules.filter((r) => !r.isActive);

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Regulatory Rules</h1>
          <p>
            Validity periods, fees, required documents, evidence minimums and SLA targets —
            configuration rather than code, because they differ by state and category and
            change when the law does.{' '}
            {view.scope === 'national'
              ? 'You are a system administrator, so you can set national rules as well as any state’s.'
              : `You can set rules for ${view.scope}. National rules are shown because you inherit them, but only a system administrator can change them.`}
          </p>
        </div>
        <button type="button" className="clay-btn clay-btn-primary" onClick={openCreate}>
          <Plus size={18} />
          New rule
        </button>
      </div>

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" className={styles.boxDismiss} onClick={() => setError(null)}>
            <X size={15} />
          </button>
        </div>
      )}
      {notice && (
        <div className={styles.noticeBox}>
          <Info size={18} />
          <span>{notice}</span>
          <button type="button" className={styles.boxDismiss} onClick={() => setNotice(null)}>
            <X size={15} />
          </button>
        </div>
      )}

      {/* ── What actually applies ─────────────────────────────────────────── */}
      {/*
        * Asked of the server, not worked out here. `resolveRule` walks state +
        * category, then state, then category, then national, and this page
        * reimplementing that order is exactly how the two would drift apart.
        */}
      <section className={styles.probe}>
        <header className={styles.probeHeader}>
          <div>
            <h2>
              <Target size={17} />
              What applies where
            </h2>
            <p>
              Pick a jurisdiction and a category to see the rule that would actually be
              used — including which scope it was matched on.
            </p>
          </div>
          <div className={styles.probeInputs}>
            <select
              className="clay-select"
              value={probeState}
              onChange={(e) => setProbeState(e.target.value)}
              aria-label="Probe state"
              disabled={view.scope !== 'national'}
            >
              <option value="">
                {view.scope === 'national' ? 'National (no state)' : view.scope}
              </option>
              {view.options.states.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              className="clay-select"
              value={probeType}
              onChange={(e) => setProbeType(e.target.value)}
              aria-label="Probe instrument category"
            >
              <option value="">All categories</option>
              {typesByFamily.map(([family, codes]) => (
                <optgroup key={family} label={family}>
                  {codes.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </header>

        {view.effective ? (
          <div className={styles.probeBody}>
            <div className={styles.probeMatch}>
              <span className="clay-badge clay-badge-info">{view.effective.matchedScope}</span>
              <strong>{view.effective.name}</strong>
              {view.effective.ruleVersion !== undefined && (
                <span className={styles.probeVersion}>version {view.effective.ruleVersion}</span>
              )}
            </div>

            <div className={styles.probeGrid}>
              <div className={styles.probeStat}>
                <span className={styles.probeLabel}>Certificate validity</span>
                <span className={styles.probeVal}>{view.effective.validityMonths} months</span>
              </div>
              <div className={styles.probeStat}>
                <span className={styles.probeLabel}>Total SLA</span>
                <span className={styles.probeVal}>
                  {view.effective.sla.reviewDays +
                    view.effective.sla.schedulingDays +
                    view.effective.sla.decisionDays}{' '}
                  days
                </span>
                <span className={styles.probeSub}>
                  {view.effective.sla.reviewDays} review · {view.effective.sla.schedulingDays}{' '}
                  scheduling · {view.effective.sla.decisionDays} decision
                </span>
              </div>
              <div className={styles.probeStat}>
                <span className={styles.probeLabel}>Evidence required</span>
                <span className={styles.probeVal}>
                  {view.effective.minEvidencePhotos} photo
                  {view.effective.minEvidencePhotos === 1 ? '' : 's'}
                </span>
                <span className={styles.probeSub}>
                  {view.effective.requireGpsEvidence
                    ? `GPS within ${view.effective.gpsToleranceMetres} m`
                    : 'GPS not required'}
                </span>
              </div>
              <div className={styles.probeStat}>
                <span className={styles.probeLabel}>Expiry reminders</span>
                <span className={styles.probeVal}>
                  {view.effective.expiryAlertOffsetsDays.join(', ')} days before
                </span>
                <span className={styles.probeSub}>
                  Flagged “expiring soon” at {view.effective.expiringSoonWindowDays} days
                </span>
              </div>
            </div>

            <div className={styles.feeStrip}>
              {(view.effective.requiredDocuments.length > 0 ||
                view.effective.tolerances.length > 0) && (
                <div className={styles.probeLists}>
                  {view.effective.requiredDocuments.length > 0 && (
                    <div>
                      <span className={styles.probeLabel}>Documents an applicant must upload</span>
                      <div className={styles.tagRow}>
                        {view.effective.requiredDocuments.map((d) => (
                          <span key={d} className={styles.tag}>
                            {view.options.documentTypes.find((o) => o.code === d)?.label ?? d}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {view.effective.tolerances.length > 0 && (
                    <div>
                      <span className={styles.probeLabel}>
                        Maximum permissible error, by test point
                      </span>
                      <div className={styles.tagRow}>
                        {view.effective.tolerances.map((t) => (
                          <span key={t.label} className={styles.tag}>
                            {t.label}: ±{t.maxErrorPercent}%
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div>
                <span className={styles.probeLabel}>Fee by application type</span>
                <div className={styles.feeRow}>
                  {view.options.verificationTypes.map((t) => (
                    <div key={t} className={styles.feeChip}>
                      <span>{VERIFICATION_TYPE_LABELS[t as VerificationType] ?? t}</span>
                      <b>{formatInr(view.effective?.feeTable?.[t] ?? 0)}</b>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {view.effective.legalReference && (
              <p className={styles.legalRef}>Legal basis: {view.effective.legalReference}</p>
            )}
          </div>
        ) : (
          <p className={styles.probeEmpty}>
            Choose a state or a category above. With neither, resolution would return the
            national default, which is the first row in the table below.
          </p>
        )}
      </section>

      {/* ── The register ──────────────────────────────────────────────────── */}
      <div className={styles.tableToolbar}>
        <h2>
          {active.length} rule{active.length === 1 ? '' : 's'} in force
        </h2>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={includeSuperseded}
            onChange={(e) => setIncludeSuperseded(e.target.checked)}
          />
          Show superseded versions
        </label>
      </div>

      <div className="clay-table-wrapper">
        <table className="clay-table">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Rule</th>
              <th className={styles.numeric}>Validity</th>
              <th className={styles.numeric}>Base fee</th>
              <th className={styles.numeric}>SLA</th>
              <th>Documents</th>
              <th>Version</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...active, ...superseded].map((rule) => {
              // Precedence is state-and-category, then state, then category, then
              // national — the same order `resolveRule` walks.
              const canEdit = rule.scope.state ? true : view.canEditNational;
              const isDefault = !rule.scope.state && !rule.scope.instrumentType;
              return (
                <tr key={rule.id} className={rule.isActive ? '' : styles.supersededRow}>
                  <td>
                    <div className={styles.scopeCell}>
                      {rule.scope.state ? <MapPin size={13} /> : <Scale size={13} />}
                      {rule.scope.label}
                    </div>
                    {isDefault && (
                      <div className={styles.subCell}>
                        The fallback for everything with no narrower rule
                      </div>
                    )}
                  </td>
                  <td>
                    <strong>{rule.name}</strong>
                    {rule.legalReference && (
                      <div className={styles.subCell}>{rule.legalReference}</div>
                    )}
                  </td>
                  <td className={styles.numeric}>{rule.validityMonths} mo</td>
                  <td className={styles.numeric}>
                    {formatInr(rule.fee.base)}
                    <div className={styles.subCell}>
                      re-verify {formatInr(rule.feeTable.reverification ?? 0)}
                    </div>
                  </td>
                  <td className={styles.numeric}>
                    {rule.slaTotalDays} d
                    <div className={styles.subCell}>
                      {rule.sla.reviewDays}/{rule.sla.schedulingDays}/{rule.sla.decisionDays}
                    </div>
                  </td>
                  <td>
                    {rule.requiredDocuments.length === 0 ? (
                      <span className={styles.notSet}>None required</span>
                    ) : (
                      <span>
                        {rule.requiredDocuments.length} required
                        <div className={styles.subCell}>
                          {rule.requiredDocuments
                            .slice(0, 2)
                            .map((d) => d.label)
                            .join(', ')}
                          {rule.requiredDocuments.length > 2
                            ? ` +${rule.requiredDocuments.length - 2}`
                            : ''}
                        </div>
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`clay-badge ${rule.isActive ? 'clay-badge-success' : 'clay-badge-charcoal'}`}
                    >
                      v{rule.version} {rule.isActive ? 'in force' : 'superseded'}
                    </span>
                    <div className={styles.subCell}>from {formatDate(rule.effectiveFrom)}</div>
                  </td>
                  <td>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        title="Version history"
                        onClick={() => void loadHistory(rule)}
                      >
                        <History size={16} />
                      </button>
                      {rule.isActive && canEdit && (
                        <button
                          type="button"
                          className={styles.iconBtn}
                          title="Amend (creates a new version)"
                          onClick={() => openAmend(rule)}
                        >
                          <Pencil size={16} />
                        </button>
                      )}
                      {rule.isActive && canEdit && !isDefault && (
                        <button
                          type="button"
                          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                          title="Withdraw"
                          onClick={() => void withdraw(rule)}
                        >
                          <Ban size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className={styles.footNote}>
        Rules are never deleted. Withdrawing one deactivates it and leaves it on record,
        because it is the evidence of what applied while it was in force — a certificate
        carries a snapshot of the rule it was issued under, and an inspector disputing a
        reading needs the tolerance table from that day, not today’s.
      </p>

      {editing && (
        <RuleEditor
          rule={editing.rule}
          draft={editing.draft}
          options={view.options}
          typesByFamily={typesByFamily}
          canEditNational={view.canEditNational}
          lockedState={view.canEditNational ? null : view.scope}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            void fetchRules();
          }}
        />
      )}

      {history && (
        <HistoryModal
          rule={history.rule}
          rows={history.rows}
          onClose={() => setHistory(null)}
        />
      )}
    </div>
  );
}

/* ── Editor ─────────────────────────────────────────────────────────────── */

function RuleEditor({
  rule,
  draft: initial,
  options,
  typesByFamily,
  canEditNational,
  lockedState,
  onClose,
  onSaved,
}: {
  rule: Rule | null;
  draft: Draft;
  options: Options;
  typesByFamily: [string, string[]][];
  canEditNational: boolean;
  lockedState: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offsetInput, setOffsetInput] = useState('');

  const amending = rule !== null;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function setFee<K extends keyof FeeShape>(key: K, value: number) {
    setDraft((d) => ({ ...d, fee: { ...d.fee, [key]: value } }));
  }

  function setSla<K extends keyof SlaShape>(key: K, value: number) {
    setDraft((d) => ({ ...d, sla: { ...d.sla, [key]: value } }));
  }

  function toggleDocument(code: string) {
    setDraft((d) => ({
      ...d,
      requiredDocuments: d.requiredDocuments.includes(code)
        ? d.requiredDocuments.filter((c) => c !== code)
        : [...d.requiredDocuments, code],
    }));
  }

  function addOffset() {
    const n = Math.trunc(Number(offsetInput));
    if (!Number.isFinite(n) || n < LIMITS.offset.min || n > LIMITS.offset.max) {
      setError(`A reminder offset must be between ${LIMITS.offset.min} and ${LIMITS.offset.max} days.`);
      return;
    }
    setError(null);
    setOffsetInput('');
    setDraft((d) => ({
      ...d,
      expiryAlertOffsetsDays: [...new Set([...d.expiryAlertOffsetsDays, n])].sort((a, b) => b - a),
    }));
  }

  async function save() {
    if (!draft.name.trim()) {
      setError('Give the rule a name, so it can be recognised in the audit trail.');
      return;
    }
    if (draft.expiryAlertOffsetsDays.length === 0) {
      setError('Keep at least one expiry reminder offset.');
      return;
    }
    if (draft.tolerances.some((t) => !t.label.trim())) {
      setError('Every test point needs a label.');
      return;
    }

    setSaving(true);
    setError(null);

    /*
     * Scope is not sent on an amendment. A PATCH creates a successor for the *same*
     * scope, and `readRuleFields` ignores `state`/`instrumentType` anyway — sending
     * them would suggest an editable field that is not one.
     */
    const payload: Record<string, unknown> = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      legalReference: draft.legalReference.trim(),
      validityMonths: draft.validityMonths,
      expiringSoonWindowDays: draft.expiringSoonWindowDays,
      expiryAlertOffsetsDays: draft.expiryAlertOffsetsDays,
      fee: draft.fee,
      requiredDocuments: draft.requiredDocuments,
      sla: draft.sla,
      tolerances: draft.tolerances,
      minEvidencePhotos: draft.minEvidencePhotos,
      requireGpsEvidence: draft.requireGpsEvidence,
      gpsToleranceMetres: draft.gpsToleranceMetres,
      effectiveFrom: draft.effectiveFrom,
    };
    if (!amending) {
      payload.state = draft.state || null;
      payload.instrumentType = draft.instrumentType || null;
    }

    try {
      const res = await fetch(amending ? `/api/rules/${rule.id}` : '/api/rules', {
        method: amending ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        message?: string;
        supersededVersion?: number;
        impact?: { note?: string };
      };
      if (!data.success) {
        setError(data.error || 'The rule could not be saved.');
        return;
      }
      // The impact note is the server's count of open applications in scope, which
      // is the one thing the administrator cannot see from this form.
      onSaved([data.message, data.impact?.note].filter(Boolean).join(' '));
    } catch {
      setError('Could not reach the server. Nothing was saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="clay-modal-overlay" onClick={onClose}>
      <div
        className={`clay-modal ${styles.editorModal}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className={styles.modalHeader}>
          <div>
            <h3>{amending ? `Amend “${rule.name}”` : 'New rule'}</h3>
            <p>
              {amending
                ? `${rule.scope.label} · currently version ${rule.version}`
                : 'Choose the narrowest scope this should apply to.'}
            </p>
          </div>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {amending && (
          <div className={styles.warnBox}>
            <Info size={17} />
            <span>
              Saving does not edit version {rule.version}. It stands that version down and
              writes version {rule.version + 1}. Certificates already issued keep the terms
              they were issued under; open applications in this scope will be decided under
              the new version.
            </span>
          </div>
        )}

        {error && (
          <div className={styles.errorBox}>
            <AlertTriangle size={17} />
            <span>{error}</span>
          </div>
        )}

        <div className={styles.formGrid}>
          {!amending && (
            <>
              <div className={styles.field}>
                <label className="clay-label" htmlFor="rule-state">
                  State or union territory
                </label>
                <select
                  id="rule-state"
                  className="clay-select"
                  value={draft.state}
                  disabled={lockedState !== null}
                  onChange={(e) => set('state', e.target.value)}
                >
                  {canEditNational && <option value="">National — applies everywhere</option>}
                  {options.states.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <p className={styles.hint}>
                  {lockedState
                    ? `Fixed to ${lockedState}: a State Administrator sets their own state’s rules, and a rule with no state applies nationally.`
                    : 'Leave as “National” for a rule that applies in every state unless a narrower one overrides it.'}
                </p>
              </div>

              <div className={styles.field}>
                <label className="clay-label" htmlFor="rule-type">
                  Instrument category
                </label>
                <select
                  id="rule-type"
                  className="clay-select"
                  value={draft.instrumentType}
                  onChange={(e) => set('instrumentType', e.target.value)}
                >
                  <option value="">All categories</option>
                  {typesByFamily.map(([family, codes]) => (
                    <optgroup key={family} label={family}>
                      {codes.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <p className={styles.hint}>
                  A category-specific rule outranks a state-wide one for that category.
                </p>
              </div>
            </>
          )}

          <div className={`${styles.field} ${styles.fieldWide}`}>
            <label className="clay-label" htmlFor="rule-name">
              Name
            </label>
            <input
              id="rule-name"
              className="clay-input"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Karnataka weighbridges 2026"
            />
          </div>

          <div className={`${styles.field} ${styles.fieldWide}`}>
            <label className="clay-label" htmlFor="rule-desc">
              Description <span className={styles.optional}>optional</span>
            </label>
            <textarea
              id="rule-desc"
              className="clay-input"
              rows={2}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="What changed and why — this is what the next administrator reads."
            />
          </div>

          <div className={`${styles.field} ${styles.fieldWide}`}>
            <label className="clay-label" htmlFor="rule-legal">
              Legal reference <span className={styles.optional}>optional</span>
            </label>
            <input
              id="rule-legal"
              className="clay-input"
              value={draft.legalReference}
              onChange={(e) => set('legalReference', e.target.value)}
              placeholder="e.g. Legal Metrology (General) Rules, 2011 — Rule 15"
            />
            <p className={styles.hint}>
              Shown to applicants and officers next to the figures it justifies.
            </p>
          </div>
        </div>

        <h4 className={styles.sectionTitle}>Certificate validity and reminders</h4>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label className="clay-label" htmlFor="rule-validity">
              Validity (months)
            </label>
            <input
              id="rule-validity"
              className="clay-input"
              type="number"
              min={LIMITS.validityMonths.min}
              max={LIMITS.validityMonths.max}
              value={draft.validityMonths}
              onChange={(e) => set('validityMonths', Number(e.target.value))}
            />
            <p className={styles.hint}>
              How long a certificate issued under this rule remains valid.
            </p>
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="rule-soon">
              “Expiring soon” window (days)
            </label>
            <input
              id="rule-soon"
              className="clay-input"
              type="number"
              min={LIMITS.expiringSoonWindowDays.min}
              max={LIMITS.expiringSoonWindowDays.max}
              value={draft.expiringSoonWindowDays}
              onChange={(e) => set('expiringSoonWindowDays', Number(e.target.value))}
            />
            <p className={styles.hint}>
              When an instrument starts showing as expiring rather than verified.
            </p>
          </div>

          <div className={`${styles.field} ${styles.fieldWide}`}>
            <span className="clay-label">Reminder offsets (days before expiry)</span>
            <div className={styles.tagRow}>
              {draft.expiryAlertOffsetsDays.map((d) => (
                <span key={d} className={styles.editableTag}>
                  {d} d
                  <button
                    type="button"
                    onClick={() =>
                      set(
                        'expiryAlertOffsetsDays',
                        draft.expiryAlertOffsetsDays.filter((x) => x !== d)
                      )
                    }
                    aria-label={`Remove the ${d} day reminder`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className={styles.inlineAdd}>
              <input
                className="clay-input"
                type="number"
                min={LIMITS.offset.min}
                max={LIMITS.offset.max}
                value={offsetInput}
                onChange={(e) => setOffsetInput(e.target.value)}
                placeholder="Add days"
              />
              <button
                type="button"
                className="clay-btn clay-btn-sm clay-btn-outline"
                onClick={addOffset}
              >
                Add
              </button>
            </div>
            <p className={styles.hint}>
              A notification goes out at each offset. Duplicates are dropped and the list is
              kept in descending order, matching what the server stores.
            </p>
          </div>
        </div>

        <h4 className={styles.sectionTitle}>Fees</h4>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label className="clay-label" htmlFor="rule-fee">
              Base fee (₹)
            </label>
            <input
              id="rule-fee"
              className="clay-input"
              type="number"
              min={0}
              value={draft.fee.base}
              onChange={(e) => setFee('base', Number(e.target.value))}
            />
            <p className={styles.hint}>
              Whole rupees. This is an initial verification; the others are multiples of it.
            </p>
          </div>

          {(
            [
              ['reverificationMultiplier', 'Re-verification ×'],
              ['repairMultiplier', 'After repair ×'],
              ['transferMultiplier', 'On transfer ×'],
            ] as [keyof FeeShape, string][]
          ).map(([key, label]) => (
            <div className={styles.field} key={key}>
              <label className="clay-label" htmlFor={`rule-${key}`}>
                {label}
              </label>
              <input
                id={`rule-${key}`}
                className="clay-input"
                type="number"
                step={0.05}
                min={LIMITS.multiplier.min}
                max={LIMITS.multiplier.max}
                value={draft.fee[key]}
                onChange={(e) => setFee(key, Number(e.target.value))}
              />
            </div>
          ))}

          {/*
            * The multipliers are what gets stored, but rupees are what an applicant
            * pays, so the form shows both. A multiplier above 1 turns the intended
            * discount into a surcharge, which is easy to type and hard to spot.
            */}
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <span className="clay-label">What an applicant would pay</span>
            <div className={styles.feeRow}>
              {options.verificationTypes.map((t) => {
                const amount = previewFee(draft.fee, t as VerificationType);
                const surcharge = t !== 'initial' && amount > draft.fee.base;
                return (
                  <div
                    key={t}
                    className={`${styles.feeChip} ${surcharge ? styles.feeChipWarn : ''}`}
                  >
                    <span>{VERIFICATION_TYPE_LABELS[t as VerificationType] ?? t}</span>
                    <b>{formatInr(amount)}</b>
                  </div>
                );
              })}
            </div>
            {options.verificationTypes.some(
              (t) => t !== 'initial' && previewFee(draft.fee, t as VerificationType) > draft.fee.base
            ) && (
              <p className={styles.hintWarn}>
                One of these costs more than an initial verification. That is allowed, but it
                is usually a multiplier typed above 1 by mistake.
              </p>
            )}
          </div>
        </div>

        <h4 className={styles.sectionTitle}>Service level targets</h4>
        <div className={styles.formGrid}>
          {(
            [
              ['reviewDays', 'Review (days)', 'From submission to an officer accepting or querying it.'],
              ['schedulingDays', 'Scheduling (days)', 'From acceptance to an inspection being booked.'],
              ['decisionDays', 'Decision (days)', 'From inspection to approval or rejection.'],
            ] as [keyof SlaShape, string, string][]
          ).map(([key, label, hint]) => (
            <div className={styles.field} key={key}>
              <label className="clay-label" htmlFor={`sla-${key}`}>
                {label}
              </label>
              <input
                id={`sla-${key}`}
                className="clay-input"
                type="number"
                min={LIMITS.slaStage.min}
                max={LIMITS.slaStage.max}
                value={draft.sla[key]}
                onChange={(e) => setSla(key, Number(e.target.value))}
              />
              <p className={styles.hint}>{hint}</p>
            </div>
          ))}
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <p className={styles.slaTotal}>
              Total published turnaround:{' '}
              <strong>
                {draft.sla.reviewDays + draft.sla.schedulingDays + draft.sla.decisionDays} days
              </strong>
              . This is what the reports page measures against, so shortening it moves
              applications into “behind” rather than making anything faster.
            </p>
          </div>
        </div>

        <h4 className={styles.sectionTitle}>Documents an applicant must upload</h4>
        <div className={styles.docGrid}>
          {options.documentTypes.map((d) => (
            <label key={d.code} className={styles.checkRow}>
              <input
                type="checkbox"
                checked={draft.requiredDocuments.includes(d.code)}
                onChange={() => toggleDocument(d.code)}
              />
              <span>{d.label}</span>
            </label>
          ))}
        </div>

        <h4 className={styles.sectionTitle}>Evidence and tolerances</h4>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label className="clay-label" htmlFor="rule-photos">
              Minimum evidence photographs
            </label>
            <input
              id="rule-photos"
              className="clay-input"
              type="number"
              min={LIMITS.minEvidencePhotos.min}
              max={LIMITS.minEvidencePhotos.max}
              value={draft.minEvidencePhotos}
              onChange={(e) => set('minEvidencePhotos', Number(e.target.value))}
            />
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="rule-gps">
              GPS tolerance (metres)
            </label>
            <input
              id="rule-gps"
              className="clay-input"
              type="number"
              min={LIMITS.gpsToleranceMetres.min}
              max={LIMITS.gpsToleranceMetres.max}
              value={draft.gpsToleranceMetres}
              disabled={!draft.requireGpsEvidence}
              onChange={(e) => set('gpsToleranceMetres', Number(e.target.value))}
            />
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={draft.requireGpsEvidence}
                onChange={(e) => set('requireGpsEvidence', e.target.checked)}
              />
              <span>Require GPS on inspection evidence</span>
            </label>
            <p className={styles.hint}>
              How far a geo-tagged photograph may sit from the instrument’s recorded
              location before it is queried.
            </p>
          </div>

          <div className={`${styles.field} ${styles.fieldWide}`}>
            <span className="clay-label">
              Maximum permissible error, by test point{' '}
              <span className={styles.optional}>optional</span>
            </span>
            {draft.tolerances.length === 0 && (
              <p className={styles.hint}>
                None set, so inspections fall back to the baseline table for the
                instrument’s family — mass, volume, length, flow or pressure.
              </p>
            )}
            {draft.tolerances.map((t, i) => (
              <div className={styles.toleranceRow} key={`tol-${i}`}>
                <input
                  className="clay-input"
                  value={t.label}
                  placeholder="Test point, e.g. 50% of Max"
                  onChange={(e) =>
                    set(
                      'tolerances',
                      draft.tolerances.map((x, j) =>
                        j === i ? { ...x, label: e.target.value } : x
                      )
                    )
                  }
                />
                <input
                  className="clay-input"
                  type="number"
                  step={0.05}
                  min={LIMITS.maxErrorPercent.min}
                  max={LIMITS.maxErrorPercent.max}
                  value={t.maxErrorPercent}
                  onChange={(e) =>
                    set(
                      'tolerances',
                      draft.tolerances.map((x, j) =>
                        j === i ? { ...x, maxErrorPercent: Number(e.target.value) } : x
                      )
                    )
                  }
                />
                <span className={styles.percentMark}>%</span>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  onClick={() =>
                    set(
                      'tolerances',
                      draft.tolerances.filter((_, j) => j !== i)
                    )
                  }
                  aria-label="Remove this test point"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="clay-btn clay-btn-sm clay-btn-outline"
              onClick={() =>
                set('tolerances', [...draft.tolerances, { label: '', maxErrorPercent: 0.5 }])
              }
            >
              <Plus size={15} />
              Add test point
            </button>
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="rule-effective">
              In force from
            </label>
            <input
              id="rule-effective"
              className="clay-input"
              type="date"
              value={draft.effectiveFrom}
              onChange={(e) => set('effectiveFrom', e.target.value)}
            />
          </div>
        </div>

        <div className={styles.modalActions}>
          <button type="button" className="clay-btn clay-btn-outline" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="clay-btn clay-btn-primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? (
              <>
                <Loader2 size={16} className={styles.spin} />
                Saving…
              </>
            ) : amending ? (
              `Save as version ${rule.version + 1}`
            ) : (
              'Create rule'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Version history ────────────────────────────────────────────────────── */

function HistoryModal({
  rule,
  rows,
  onClose,
}: {
  rule: Rule;
  rows: HistoryRow[];
  onClose: () => void;
}) {
  return (
    <div className="clay-modal-overlay" onClick={onClose}>
      <div
        className={`clay-modal ${styles.historyModal}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className={styles.modalHeader}>
          <div>
            <h3>Version history</h3>
            <p>{rule.scope.label}</p>
          </div>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <p className={styles.hint}>
          Every amendment for this scope, newest first. The superseded rows are not dead
          weight: a certificate records which version it was issued under, and this is where
          that version’s terms are read back.
        </p>

        <div className="clay-table-wrapper">
          <table className="clay-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Name</th>
                <th className={styles.numeric}>Validity</th>
                <th className={styles.numeric}>Base fee</th>
                <th>In force</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.id} className={h.isActive ? '' : styles.supersededRow}>
                  <td>
                    <span
                      className={`clay-badge ${h.isActive ? 'clay-badge-success' : 'clay-badge-charcoal'}`}
                    >
                      v{h.version}
                    </span>
                  </td>
                  <td>{h.name}</td>
                  <td className={styles.numeric}>{h.validityMonths} mo</td>
                  <td className={styles.numeric}>
                    {h.baseFee === undefined ? '—' : formatInr(h.baseFee)}
                  </td>
                  <td>
                    {formatDate(h.effectiveFrom)}
                    {h.supersededAt && (
                      <div className={styles.subCell}>
                        superseded {formatDateTime(h.supersededAt)}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={styles.modalActions}>
          <button type="button" className="clay-btn clay-btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
