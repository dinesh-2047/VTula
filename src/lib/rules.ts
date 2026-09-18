import Rule, { type IRule } from '@/models/Rule';
import {
  FAMILY_DEFAULT_UNIT,
  INSTRUMENT_TYPE_FAMILY,
  type VerificationType,
} from '@/lib/constants';
import { addMonths } from '@/lib/utils';

/**
 * Regulatory rule engine.
 *
 * The spec calls out hardcoded validity periods and fee tables as an
 * architectural defect: rules differ by state and instrument category and change
 * when the law changes, so they must be data. Previously certificate validity
 * was `expiryDate.setFullYear(+1)` inline in the task route, and fees came from a
 * literal map in `utils.ts` keyed by instrument type.
 *
 * Resolution is most-specific-first:
 *   (state, type) → (state, *) → (*, type) → (*, *)
 */

/** Fallback used only when the database has no rules at all yet. */
export const DEFAULT_RULE = {
  validityMonths: 12,
  expiryAlertOffsetsDays: [60, 30, 7],
  expiringSoonWindowDays: 60,
  fee: {
    base: 300,
    reverificationMultiplier: 0.75,
    repairMultiplier: 0.9,
    transferMultiplier: 0.5,
  },
  requiredDocuments: ['OWNERSHIP_PROOF'],
  sla: { reviewDays: 3, schedulingDays: 7, decisionDays: 3 },
  minEvidencePhotos: 2,
  requireGpsEvidence: true,
  gpsToleranceMetres: 500,
  legalReference: 'Legal Metrology Act 2009, s.24; Legal Metrology (General) Rules 2011',
} as const;

export interface ResolvedRule {
  ruleId?: string;
  /** Version of that rule, so a certificate can record which terms applied. */
  ruleVersion?: number;
  name: string;
  validityMonths: number;
  expiryAlertOffsetsDays: number[];
  expiringSoonWindowDays: number;
  fee: IRule['fee'];
  requiredDocuments: string[];
  sla: IRule['sla'];
  tolerances: { label: string; maxErrorPercent: number }[];
  minEvidencePhotos: number;
  requireGpsEvidence: boolean;
  gpsToleranceMetres: number;
  legalReference?: string;
  /** How the rule was selected, so the choice can be explained to a user. */
  matchedScope: string;
}

/** Baseline tolerance table by instrument family, used when a rule defines none. */
function defaultTolerances(instrumentType: string): { label: string; maxErrorPercent: number }[] {
  const family = INSTRUMENT_TYPE_FAMILY[instrumentType] ?? 'OTHER';

  switch (family) {
    case 'MASS':
      return [
        { label: '10% of Max', maxErrorPercent: 0.5 },
        { label: '25% of Max', maxErrorPercent: 0.5 },
        { label: '50% of Max', maxErrorPercent: 0.3 },
        { label: '75% of Max', maxErrorPercent: 0.3 },
        { label: '100% of Max', maxErrorPercent: 0.2 },
      ];
    case 'VOLUME':
      return [
        { label: '5 L delivery', maxErrorPercent: 0.5 },
        { label: '10 L delivery', maxErrorPercent: 0.5 },
        { label: '20 L delivery', maxErrorPercent: 0.3 },
      ];
    case 'FLOW':
      return [
        { label: 'Minimum flow', maxErrorPercent: 5 },
        { label: 'Nominal flow', maxErrorPercent: 2 },
        { label: 'Maximum flow', maxErrorPercent: 2 },
      ];
    case 'LENGTH':
      return [
        { label: 'Full scale', maxErrorPercent: 0.2 },
        { label: 'Mid scale', maxErrorPercent: 0.2 },
      ];
    case 'PRESSURE':
      return [
        { label: '25% of range', maxErrorPercent: 1 },
        { label: '50% of range', maxErrorPercent: 1 },
        { label: '100% of range', maxErrorPercent: 1 },
      ];
    default:
      return [
        { label: 'Low point', maxErrorPercent: 1 },
        { label: 'Mid point', maxErrorPercent: 1 },
        { label: 'High point', maxErrorPercent: 1 },
      ];
  }
}

function toResolved(rule: IRule, scope: string): ResolvedRule {
  return {
    ruleId: String(rule._id),
    ruleVersion: rule.version,
    name: rule.name,
    validityMonths: rule.validityMonths,
    expiryAlertOffsetsDays: rule.expiryAlertOffsetsDays?.length
      ? rule.expiryAlertOffsetsDays
      : [...DEFAULT_RULE.expiryAlertOffsetsDays],
    expiringSoonWindowDays: rule.expiringSoonWindowDays ?? DEFAULT_RULE.expiringSoonWindowDays,
    fee: rule.fee,
    requiredDocuments: rule.requiredDocuments ?? [],
    sla: rule.sla,
    tolerances: rule.tolerances?.length ? rule.tolerances : [],
    minEvidencePhotos: rule.minEvidencePhotos ?? DEFAULT_RULE.minEvidencePhotos,
    requireGpsEvidence: rule.requireGpsEvidence ?? DEFAULT_RULE.requireGpsEvidence,
    gpsToleranceMetres: rule.gpsToleranceMetres ?? DEFAULT_RULE.gpsToleranceMetres,
    legalReference: rule.legalReference,
    matchedScope: scope,
  };
}

/**
 * Finds the applicable rule for a state + instrument type.
 * Never throws — falls back to the built-in national default.
 */
export async function resolveRule(
  state: string | null | undefined,
  instrumentType: string | null | undefined
): Promise<ResolvedRule> {
  const candidates = await Rule.find({
    isActive: true,
    effectiveFrom: { $lte: new Date() },
    $or: [
      { state: state ?? null, instrumentType: instrumentType ?? null },
      { state: state ?? null, instrumentType: null },
      { state: null, instrumentType: instrumentType ?? null },
      { state: null, instrumentType: null },
    ],
  }).lean<IRule[]>();

  const pick = (s: string | null, t: string | null) =>
    candidates.find((c) => (c.state ?? null) === s && (c.instrumentType ?? null) === t);

  const st = state ?? null;
  const ty = instrumentType ?? null;

  const exact = pick(st, ty);
  if (exact) return toResolvedWithFallback(exact, `state=${st} type=${ty}`, instrumentType);

  const stateWide = pick(st, null);
  if (stateWide) return toResolvedWithFallback(stateWide, `state=${st} (all categories)`, instrumentType);

  const typeWide = pick(null, ty);
  if (typeWide) return toResolvedWithFallback(typeWide, `type=${ty} (all states)`, instrumentType);

  const national = pick(null, null);
  if (national) return toResolvedWithFallback(national, 'national default', instrumentType);

  // Nothing configured — built-in baseline.
  return {
    name: 'Built-in baseline (no rule configured)',
    validityMonths: DEFAULT_RULE.validityMonths,
    expiryAlertOffsetsDays: [...DEFAULT_RULE.expiryAlertOffsetsDays],
    expiringSoonWindowDays: DEFAULT_RULE.expiringSoonWindowDays,
    fee: { ...DEFAULT_RULE.fee },
    requiredDocuments: [...DEFAULT_RULE.requiredDocuments],
    sla: { ...DEFAULT_RULE.sla },
    tolerances: defaultTolerances(instrumentType ?? ''),
    minEvidencePhotos: DEFAULT_RULE.minEvidencePhotos,
    requireGpsEvidence: DEFAULT_RULE.requireGpsEvidence,
    gpsToleranceMetres: DEFAULT_RULE.gpsToleranceMetres,
    legalReference: DEFAULT_RULE.legalReference,
    matchedScope: 'built-in baseline',
  };
}

function toResolvedWithFallback(
  rule: IRule,
  scope: string,
  instrumentType: string | null | undefined
): ResolvedRule {
  const resolved = toResolved(rule, scope);
  if (resolved.tolerances.length === 0) {
    resolved.tolerances = defaultTolerances(instrumentType ?? '');
  }
  return resolved;
}

/* ------------------------------------------------------------------ *
 * Derived calculations
 * ------------------------------------------------------------------ */

/**
 * Statutory fee for an application.
 *
 * Replaces the old `calculateFee()`, which (a) hardcoded the fee table, and
 * (b) only applied the re-verification discount when the caller passed exactly
 * `'reverification'` — while the UI sent `'re-verification'`, so the discount
 * silently never applied.
 */
export function computeFee(rule: ResolvedRule, verificationType: VerificationType): number {
  const { base, reverificationMultiplier, repairMultiplier, transferMultiplier } = rule.fee;

  const multiplier =
    verificationType === 'reverification'
      ? reverificationMultiplier
      : verificationType === 'repair'
        ? repairMultiplier
        : verificationType === 'transfer'
          ? transferMultiplier
          : 1;

  return Math.max(0, Math.round(base * multiplier));
}

/** Expiry date for a certificate issued at `issuedAt`, from the rule's validity. */
export function computeExpiryDate(rule: ResolvedRule, issuedAt: Date = new Date()): Date {
  return addMonths(issuedAt, rule.validityMonths);
}

/** SLA due date for the review stage. */
export function computeDueDate(rule: ResolvedRule, from: Date = new Date()): Date {
  const total = rule.sla.reviewDays + rule.sla.schedulingDays + rule.sla.decisionDays;
  const due = new Date(from.getTime());
  due.setDate(due.getDate() + total);
  return due;
}

/** Builds the test-point table an inspector fills in, scaled to the instrument. */
export function buildReadingTemplate(
  rule: ResolvedRule,
  instrument: { type: string; capacityValue?: number; capacityUnit?: string }
): { label: string; reference: number; observed: null; unit: string; maxErrorPercent: number }[] {
  const family = INSTRUMENT_TYPE_FAMILY[instrument.type] ?? 'OTHER';
  const unit = instrument.capacityUnit || FAMILY_DEFAULT_UNIT[family] || 'unit';
  const max = instrument.capacityValue ?? 0;

  return rule.tolerances.map((t) => {
    // "25% of Max" style labels scale against the instrument's capacity.
    const percentMatch = /^(\d+(?:\.\d+)?)%/.exec(t.label);
    const reference = percentMatch && max > 0 ? Number(((max * Number(percentMatch[1])) / 100).toFixed(3)) : 0;

    return {
      label: t.label,
      reference,
      /*
       * Deliberately empty.
       *
       * This was pre-filled with `reference`, which handed the inspector a form
       * already reading 0.00% error on every test point — submit it untouched and
       * the instrument passes. The inspector types what the instrument actually
       * showed; the server rejects a reading with no observed value.
       */
      observed: null,
      unit,
      maxErrorPercent: t.maxErrorPercent,
    };
  });
}

/**
 * Seeds the national default rule if the collection is empty.
 * Idempotent — safe to call on every boot.
 */
export async function ensureDefaultRule(): Promise<void> {
  const existing = await Rule.findOne({ state: null, instrumentType: null, isActive: true });
  if (existing) return;

  await Rule.create({
    name: 'National default',
    description:
      'Baseline validity, fee and evidence requirements applied when no state- or category-specific rule exists.',
    state: null,
    instrumentType: null,
    validityMonths: DEFAULT_RULE.validityMonths,
    expiryAlertOffsetsDays: [...DEFAULT_RULE.expiryAlertOffsetsDays],
    expiringSoonWindowDays: DEFAULT_RULE.expiringSoonWindowDays,
    fee: { ...DEFAULT_RULE.fee },
    requiredDocuments: [...DEFAULT_RULE.requiredDocuments],
    sla: { ...DEFAULT_RULE.sla },
    tolerances: [],
    minEvidencePhotos: DEFAULT_RULE.minEvidencePhotos,
    requireGpsEvidence: DEFAULT_RULE.requireGpsEvidence,
    gpsToleranceMetres: DEFAULT_RULE.gpsToleranceMetres,
    legalReference: DEFAULT_RULE.legalReference,
  });
}
