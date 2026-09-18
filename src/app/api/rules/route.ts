import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import Rule from '@/models/Rule';
import {
  handle,
  ok,
  requireAdmin,
  BadRequest,
  Conflict,
  hasGlobalScope,
} from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { resolveRule, ensureDefaultRule } from '@/lib/rules';
import {
  assertRuleScopeAllowed,
  readRuleFields,
  presentRule,
  feeTable,
} from '@/lib/ruleAdmin';
import {
  INDIAN_STATES,
  INSTRUMENT_TYPES,
  INSTRUMENT_TYPE_FAMILY,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  VERIFICATION_TYPES,
} from '@/lib/constants';

/**
 * Regulatory rule administration.
 *
 * The spec is explicit that validity periods, fees, required documents, evidence
 * minimums and SLA targets are **configuration, not code** — they differ per state
 * and per instrument category, and they change when the law changes. The engine in
 * `src/lib/rules.ts` already reads them from the database; nothing could write
 * them, so in practice every deployment ran on the seeded national default.
 *
 * Two rules of the road, both enforced here and in `[id]`:
 *
 *  - **An amendment creates a new version rather than editing the old one.** A
 *    certificate issued last month was issued under last month's validity period,
 *    and an audit has to be able to see which rule applied.
 *  - **A StateAdmin may only write rules for their own state.** National rules
 *    (`state: null`) apply everywhere and are a system-Admin matter.
 */

export const GET = handle(async (req: NextRequest) => {
  await dbConnect();
  const actor = await requireAdmin('rules.list');

  // A deployment that has never been seeded would otherwise show an empty table
  // while quietly running on the built-in baseline.
  await ensureDefaultRule();

  const sp = req.nextUrl.searchParams;

  const query: Record<string, unknown> = {};
  if (sp.get('includeSuperseded') !== 'true') query.isActive = true;

  if (hasGlobalScope(actor.role)) {
    const state = sp.get('state');
    if (state === 'national') query.state = null;
    else if (state && state !== 'all') query.state = state;
  } else {
    // A StateAdmin sees their own state's rules plus the national rules they
    // inherit — they cannot change the latter, but they need to see what applies.
    query.$or = [{ state: actor.state }, { state: null }];
  }

  const instrumentType = sp.get('instrumentType');
  if (instrumentType === 'all-categories') query.instrumentType = null;
  else if (instrumentType && instrumentType !== 'all') query.instrumentType = instrumentType;

  const rules = await Rule.find(query)
    // Most specific first, which is also resolution order.
    .sort({ state: -1, instrumentType: -1, version: -1 })
    .limit(300);

  /*
   * The point of the page is not "what rows exist" but "what would actually
   * apply". Resolution walks four candidate scopes most-specific-first, so an
   * administrator who has just added a state rule needs to confirm it wins.
   */
  const probeState = sp.get('probeState') ?? (hasGlobalScope(actor.role) ? null : actor.state ?? null);
  const probeType = sp.get('probeInstrumentType');
  const effective = probeState || probeType ? await resolveRule(probeState, probeType) : null;

  return ok({
    rules: rules.map(presentRule),
    total: rules.length,
    effective: effective
      ? {
          ...effective,
          feeTable: feeTable(effective),
          probe: { state: probeState, instrumentType: probeType },
        }
      : null,
    options: {
      states: INDIAN_STATES,
      // Grouped by family, because a rule usually covers a family rather than one
      // category, and 26 flat options is an unhelpful dropdown.
      instrumentTypes: INSTRUMENT_TYPES.map((t) => ({
        code: t,
        family: INSTRUMENT_TYPE_FAMILY[t] ?? 'OTHER',
      })),
      documentTypes: DOCUMENT_TYPES.map((d) => ({ code: d, label: DOCUMENT_TYPE_LABELS[d] })),
      verificationTypes: VERIFICATION_TYPES,
    },
    scope: hasGlobalScope(actor.role) ? 'national' : actor.state,
    canEditNational: hasGlobalScope(actor.role),
  });
});

/** Creates a rule for a scope that has none. Amending an existing one is a PATCH on `[id]`. */
export const POST = handle(async (req: NextRequest) => {
  await dbConnect();
  const actor = await requireAdmin('rules.create');

  const body = (await req.json()) as Record<string, unknown>;

  const state = typeof body.state === 'string' && body.state.trim() ? body.state.trim() : null;
  const instrumentType =
    typeof body.instrumentType === 'string' && body.instrumentType.trim()
      ? body.instrumentType.trim()
      : null;

  if (state && !(INDIAN_STATES as readonly string[]).includes(state)) {
    throw BadRequest(`"${state}" is not a recognised state or union territory`, 'INVALID_STATE');
  }
  if (instrumentType && !(INSTRUMENT_TYPES as readonly string[]).includes(instrumentType)) {
    throw BadRequest(`"${instrumentType}" is not a recognised instrument category`, 'INVALID_TYPE');
  }

  assertRuleScopeAllowed(actor, { state, instrumentType });

  const fields = readRuleFields(body);
  if (!fields.name) {
    throw BadRequest(
      'Give the rule a name, so it can be recognised in the audit trail',
      'NAME_REQUIRED'
    );
  }
  if (fields.fee === undefined) throw BadRequest('Set the fee table for this rule', 'FEE_REQUIRED');
  if (fields.validityMonths === undefined) {
    throw BadRequest('Set the certificate validity in months', 'VALIDITY_REQUIRED');
  }

  // The unique partial index would reject this anyway; catching it here produces a
  // message that says what to do instead.
  const clash = await Rule.findOne({ state, instrumentType, isActive: true });
  if (clash) {
    throw Conflict(
      `An active rule already covers this scope (${clash.name}). Amend it instead — that creates a new version and keeps the old one on record.`,
      'SCOPE_TAKEN'
    );
  }

  const created = await Rule.create({
    state,
    instrumentType,
    ...fields,
    version: 1,
    isActive: true,
    createdBy: new Types.ObjectId(actor.id),
    updatedBy: new Types.ObjectId(actor.id),
  });

  await auditAction(
    { id: actor.id, role: actor.role, email: actor.email },
    'rule.create',
    { type: 'Rule', id: created._id, label: created.name },
    {
      details: `Created rule for state=${state ?? 'all'} type=${instrumentType ?? 'all'}: validity ${created.validityMonths} months, base fee ₹${created.fee.base}`,
      headers: req.headers,
    }
  );

  return ok({ rule: presentRule(created), message: `"${created.name}" is now in force.` }, 201);
});
