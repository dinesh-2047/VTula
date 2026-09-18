import { type IRule } from '@/models/Rule';
import { BadRequest, Forbidden, hasGlobalScope, type AuthedUser } from '@/lib/rbac';
import { computeFee, type ResolvedRule } from '@/lib/rules';
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  VERIFICATION_TYPES,
  type VerificationType,
} from '@/lib/constants';

/**
 * Validation and presentation shared by the rule administration routes.
 *
 * Lives here rather than in one of the route files because `/api/rules` and
 * `/api/rules/[id]` both need it, and a route importing another route is a
 * needless coupling of two request handlers.
 */

export type ScopeInput = { state?: string | null; instrumentType?: string | null };

/**
 * Refuses a rule scope the actor has no authority over.
 *
 * A national rule (`state: null`) applies in every state, so only a system
 * administrator may write one. A StateAdmin is confined to their own state —
 * otherwise state-level scoping could be escaped by editing another state's fees.
 */
export function assertRuleScopeAllowed(actor: AuthedUser, scope: ScopeInput): void {
  if (hasGlobalScope(actor.role)) return;

  if (!scope.state) {
    throw Forbidden(
      'A rule with no state applies nationally, which only a system administrator can set. Name your own state instead.'
    );
  }
  if (scope.state !== actor.state) {
    throw Forbidden(`You can only configure rules for ${actor.state ?? 'your own state'}`);
  }
}

/**
 * Validates and normalises the editable fields of a rule.
 *
 * Every bound here is a real-world one rather than a schema formality: a validity
 * of zero months would issue certificates that expire the day they are signed, and
 * a re-verification multiplier above 1 would make the discount a surcharge.
 */
export function readRuleFields(body: Record<string, unknown>): Partial<IRule> {
  const out: Record<string, unknown> = {};

  const num = (key: string): number | undefined => {
    if (body[key] === undefined) return undefined;
    const n = Number(body[key]);
    if (!Number.isFinite(n)) throw BadRequest(`${key} must be a number`, 'INVALID_NUMBER');
    return n;
  };

  if (typeof body.name === 'string' && body.name.trim()) out.name = body.name.trim();
  if (typeof body.description === 'string') out.description = body.description.trim() || undefined;
  if (typeof body.legalReference === 'string') {
    out.legalReference = body.legalReference.trim() || undefined;
  }

  const validityMonths = num('validityMonths');
  if (validityMonths !== undefined) {
    if (validityMonths < 1 || validityMonths > 120) {
      throw BadRequest('Validity must be between 1 and 120 months', 'INVALID_VALIDITY');
    }
    out.validityMonths = Math.trunc(validityMonths);
  }

  if (body.expiryAlertOffsetsDays !== undefined) {
    if (!Array.isArray(body.expiryAlertOffsetsDays)) {
      throw BadRequest('Reminder offsets must be a list of days', 'INVALID_OFFSETS');
    }
    const offsets = [
      ...new Set(
        body.expiryAlertOffsetsDays
          .map((d) => Math.trunc(Number(d)))
          .filter((d) => Number.isFinite(d) && d >= 1 && d <= 365)
      ),
    ].sort((a, b) => b - a);
    if (offsets.length === 0) {
      throw BadRequest('Give at least one reminder offset between 1 and 365 days', 'INVALID_OFFSETS');
    }
    out.expiryAlertOffsetsDays = offsets;
  }

  const soon = num('expiringSoonWindowDays');
  if (soon !== undefined) {
    if (soon < 1 || soon > 365) {
      throw BadRequest('The expiring-soon window must be between 1 and 365 days', 'INVALID_WINDOW');
    }
    out.expiringSoonWindowDays = Math.trunc(soon);
  }

  if (body.fee !== undefined) {
    const fee = body.fee as Record<string, unknown>;
    if (typeof fee !== 'object' || fee === null) {
      throw BadRequest('fee must be an object', 'INVALID_FEE');
    }
    const base = Number(fee.base);
    if (!Number.isFinite(base) || base < 0) {
      throw BadRequest('The base fee must be zero or more', 'INVALID_FEE');
    }
    const mult = (key: string, fallback: number): number => {
      if (fee[key] === undefined) return fallback;
      const n = Number(fee[key]);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        throw BadRequest(`${key} must be between 0 and 2`, 'INVALID_MULTIPLIER');
      }
      return n;
    };
    out.fee = {
      base: Math.round(base),
      reverificationMultiplier: mult('reverificationMultiplier', 0.75),
      repairMultiplier: mult('repairMultiplier', 0.9),
      transferMultiplier: mult('transferMultiplier', 0.5),
    };
  }

  if (body.requiredDocuments !== undefined) {
    if (!Array.isArray(body.requiredDocuments)) {
      throw BadRequest('requiredDocuments must be a list', 'INVALID_DOCUMENTS');
    }
    const rejected = body.requiredDocuments.filter(
      (d) => !(DOCUMENT_TYPES as readonly string[]).includes(String(d).toUpperCase())
    );
    if (rejected.length > 0) {
      throw BadRequest(
        `Not a recognised document type: ${rejected.join(', ')}`,
        'UNKNOWN_DOCUMENT_TYPE'
      );
    }
    out.requiredDocuments = [...new Set(body.requiredDocuments.map((d) => String(d).toUpperCase()))];
  }

  if (body.sla !== undefined) {
    const sla = body.sla as Record<string, unknown>;
    const stage = (key: string, fallback: number): number => {
      if (sla?.[key] === undefined) return fallback;
      const n = Math.trunc(Number(sla[key]));
      if (!Number.isFinite(n) || n < 1 || n > 90) {
        throw BadRequest(`${key} must be between 1 and 90 days`, 'INVALID_SLA');
      }
      return n;
    };
    out.sla = {
      reviewDays: stage('reviewDays', 3),
      schedulingDays: stage('schedulingDays', 7),
      decisionDays: stage('decisionDays', 3),
    };
  }

  if (body.tolerances !== undefined) {
    if (!Array.isArray(body.tolerances)) {
      throw BadRequest('tolerances must be a list of test points', 'INVALID_TOLERANCES');
    }
    out.tolerances = body.tolerances.map((raw) => {
      const t = raw as Record<string, unknown>;
      const label = String(t?.label ?? '').trim();
      const maxErrorPercent = Number(t?.maxErrorPercent);
      if (!label) throw BadRequest('Every test point needs a label', 'INVALID_TOLERANCES');
      if (!Number.isFinite(maxErrorPercent) || maxErrorPercent < 0 || maxErrorPercent > 100) {
        throw BadRequest(
          `Maximum permissible error for "${label}" must be between 0 and 100 percent`,
          'INVALID_TOLERANCES'
        );
      }
      return { label, maxErrorPercent };
    });
  }

  const photos = num('minEvidencePhotos');
  if (photos !== undefined) {
    if (photos < 0 || photos > 20) {
      throw BadRequest('Require between 0 and 20 evidence photographs', 'INVALID_PHOTO_COUNT');
    }
    out.minEvidencePhotos = Math.trunc(photos);
  }

  if (typeof body.requireGpsEvidence === 'boolean') {
    out.requireGpsEvidence = body.requireGpsEvidence;
  }

  const gps = num('gpsToleranceMetres');
  if (gps !== undefined) {
    if (gps < 0 || gps > 100_000) {
      throw BadRequest('GPS tolerance must be between 0 and 100000 metres', 'INVALID_GPS_TOLERANCE');
    }
    out.gpsToleranceMetres = Math.trunc(gps);
  }

  if (body.effectiveFrom !== undefined) {
    const d = new Date(String(body.effectiveFrom));
    if (Number.isNaN(d.getTime())) {
      throw BadRequest('effectiveFrom is not a valid date', 'INVALID_DATE');
    }
    out.effectiveFrom = d;
  }

  return out as Partial<IRule>;
}

/** A human label for a rule's scope, in resolution order terms. */
export function scopeLabel(state?: string | null, instrumentType?: string | null): string {
  // Instrument type codes are already the human names ("Fuel Dispenser").
  if (state && instrumentType) return `${state} — ${instrumentType}`;
  if (state) return `${state} — all categories`;
  if (instrumentType) return `All states — ${instrumentType}`;
  return 'National default';
}

/** What each verification type costs under a rule, so the UI shows rupees not multipliers. */
export function feeTable(rule: Pick<ResolvedRule, 'fee'>): Record<string, number> {
  return Object.fromEntries(
    VERIFICATION_TYPES.map((t) => [
      t,
      computeFee(rule as ResolvedRule, t as VerificationType),
    ])
  );
}

/** Shapes a stored rule for the client. */
export function presentRule(rule: IRule) {
  return {
    id: String(rule._id),
    name: rule.name,
    description: rule.description,
    scope: {
      state: rule.state,
      instrumentType: rule.instrumentType,
      label: scopeLabel(rule.state, rule.instrumentType),
    },
    validityMonths: rule.validityMonths,
    expiryAlertOffsetsDays: rule.expiryAlertOffsetsDays,
    expiringSoonWindowDays: rule.expiringSoonWindowDays,
    fee: rule.fee,
    feeTable: feeTable(rule),
    requiredDocuments: (rule.requiredDocuments ?? []).map((d) => ({
      code: d,
      label: DOCUMENT_TYPE_LABELS[d as keyof typeof DOCUMENT_TYPE_LABELS] ?? d,
    })),
    sla: rule.sla,
    slaTotalDays: rule.sla.reviewDays + rule.sla.schedulingDays + rule.sla.decisionDays,
    tolerances: rule.tolerances ?? [],
    minEvidencePhotos: rule.minEvidencePhotos,
    requireGpsEvidence: rule.requireGpsEvidence,
    gpsToleranceMetres: rule.gpsToleranceMetres,
    legalReference: rule.legalReference,
    isActive: rule.isActive,
    version: rule.version,
    effectiveFrom: rule.effectiveFrom,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}
