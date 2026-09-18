import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import Rule from '@/models/Rule';
import Application from '@/models/Application';
import Certificate from '@/models/Certificate';
import {
  handle,
  ok,
  requireAdmin,
  BadRequest,
  NotFound,
  Conflict,
  hasGlobalScope,
} from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { assertRuleScopeAllowed, readRuleFields, presentRule } from '@/lib/ruleAdmin';
import { OPEN_APPLICATION_STATUSES } from '@/lib/constants';

/**
 * One regulatory rule: read its version history, amend it, or withdraw it.
 *
 * Amendment is **supersede-and-replace**, not edit-in-place. A certificate issued
 * under a twelve-month validity does not retroactively become a two-year
 * certificate because somebody changed the rule afterwards, and an inspector
 * disputing a rejected reading needs to see the tolerance table that was in force
 * on the day. So a PATCH deactivates the current row and writes a successor with
 * `version + 1`; the old row stays, inactive, as the record of what applied.
 */

/** Loads a rule and refuses one the administrator has no authority over. */
async function loadRule(id: string, actor: Awaited<ReturnType<typeof requireAdmin>>) {
  if (!Types.ObjectId.isValid(id)) throw NotFound('No such rule');

  const rule = await Rule.findById(id);
  if (!rule) throw NotFound('No such rule');

  // A StateAdmin may read a national rule they inherit but not touch it; the write
  // paths call `assertRuleScopeAllowed` separately.
  if (!hasGlobalScope(actor.role) && rule.state && rule.state !== actor.state) {
    throw NotFound('No such rule');
  }

  return rule;
}

export const GET = handle(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();
  const actor = await requireAdmin('rules.read');

  const rule = await loadRule(id, actor);

  // Every version for this scope, so the page can show what changed and when.
  const history = await Rule.find({ state: rule.state, instrumentType: rule.instrumentType })
    .sort({ version: -1 })
    .select('name version isActive effectiveFrom validityMonths fee updatedAt createdAt')
    .lean();

  return ok({
    rule: presentRule(rule),
    history: history.map((h) => ({
      id: String(h._id),
      name: h.name,
      version: h.version,
      isActive: h.isActive,
      effectiveFrom: h.effectiveFrom,
      validityMonths: h.validityMonths,
      baseFee: h.fee?.base,
      supersededAt: h.isActive ? undefined : h.updatedAt,
    })),
    canEdit:
      hasGlobalScope(actor.role) || (Boolean(rule.state) && rule.state === actor.state),
  });
});

export const PATCH = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();
  const actor = await requireAdmin('rules.update');

  const current = await loadRule(id, actor);
  assertRuleScopeAllowed(actor, { state: current.state, instrumentType: current.instrumentType });

  if (!current.isActive) {
    throw Conflict(
      'This version has already been superseded. Amend the version that is currently in force.',
      'ALREADY_SUPERSEDED'
    );
  }

  const body = (await req.json()) as Record<string, unknown>;
  const fields = readRuleFields(body);

  if (Object.keys(fields).length === 0) throw BadRequest('Nothing to change', 'NO_CHANGES');

  /*
   * What actually differs, for the audit entry. An administrator who nudged the
   * base fee by ₹50 should see exactly that in the trail, not "rule updated".
   */
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(fields)) {
    const before = (current as unknown as Record<string, unknown>)[key];
    const same = JSON.stringify(before) === JSON.stringify(value);
    if (!same) changes[key] = { from: before, to: value };
  }

  if (Object.keys(changes).length === 0) {
    throw BadRequest('Those values are already in force', 'NO_CHANGES');
  }

  /*
   * How much is riding on the current version, so the administrator knows the
   * blast radius before they confirm. Applications still open will be decided
   * under the successor; certificates already issued keep the old terms.
   */
  const scopeFilter: Record<string, unknown> = {};
  if (current.state) scopeFilter['jurisdiction.state'] = current.state;
  const openUnderRule = await Application.countDocuments({
    ...scopeFilter,
    status: { $in: [...OPEN_APPLICATION_STATUSES] },
  });

  const successorFields = {
    name: current.name,
    description: current.description,
    state: current.state,
    instrumentType: current.instrumentType,
    validityMonths: current.validityMonths,
    expiryAlertOffsetsDays: current.expiryAlertOffsetsDays,
    expiringSoonWindowDays: current.expiringSoonWindowDays,
    fee: current.fee,
    requiredDocuments: current.requiredDocuments,
    sla: current.sla,
    tolerances: current.tolerances,
    minEvidencePhotos: current.minEvidencePhotos,
    requireGpsEvidence: current.requireGpsEvidence,
    gpsToleranceMetres: current.gpsToleranceMetres,
    legalReference: current.legalReference,
    ...fields,
  };

  /*
   * The unique index is partial on `isActive: true`, so the old row has to be
   * stood down before the successor is written. If the create then fails, the scope
   * would be left with no active rule — `resolveRule` falls back to a broader scope
   * or the built-in baseline rather than throwing, but it is still wrong, so the
   * old version is reinstated.
   */
  current.isActive = false;
  current.updatedBy = new Types.ObjectId(actor.id);
  await current.save();

  let successor;
  try {
    successor = await Rule.create({
      ...successorFields,
      version: current.version + 1,
      isActive: true,
      effectiveFrom: fields.effectiveFrom ?? new Date(),
      createdBy: current.createdBy ?? new Types.ObjectId(actor.id),
      updatedBy: new Types.ObjectId(actor.id),
    });
  } catch (err) {
    current.isActive = true;
    await current.save();
    throw err;
  }

  await auditAction(
    { id: actor.id, role: actor.role, email: actor.email },
    'rule.amend',
    { type: 'Rule', id: successor._id, label: successor.name },
    {
      details: `Version ${current.version} superseded by ${successor.version}; changed ${Object.keys(changes).join(', ')}`,
      changes,
      headers: req.headers,
    }
  );

  return ok({
    rule: presentRule(successor),
    supersededVersion: current.version,
    changed: Object.keys(changes),
    impact: {
      openApplications: openUnderRule,
      note:
        openUnderRule > 0
          ? `${openUnderRule} open application${openUnderRule === 1 ? '' : 's'} in this scope will be decided under version ${successor.version}. Certificates already issued keep the terms they were issued under.`
          : 'No open applications were affected.',
    },
    message: `"${successor.name}" is now at version ${successor.version}.`,
  });
});

/**
 * Withdraws a rule.
 *
 * Deactivation, not deletion — the row is the record of what applied while it was
 * in force. Withdrawing a rule makes resolution fall through to the next broader
 * scope, which is a real change in what applicants are charged, so the national
 * default is protected: removing it would leave the whole country on the built-in
 * baseline constants.
 */
export const DELETE = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();
  const actor = await requireAdmin('rules.delete');

  const rule = await loadRule(id, actor);
  assertRuleScopeAllowed(actor, { state: rule.state, instrumentType: rule.instrumentType });

  if (!rule.isActive) throw Conflict('This rule is already withdrawn', 'ALREADY_INACTIVE');

  if (!rule.state && !rule.instrumentType) {
    throw BadRequest(
      'The national default cannot be withdrawn, because every other rule falls back to it. Amend it instead.',
      'CANNOT_WITHDRAW_DEFAULT'
    );
  }

  const issued = await Certificate.countDocuments({ 'appliedRuleSnapshot.ruleId': rule._id });

  rule.isActive = false;
  rule.updatedBy = new Types.ObjectId(actor.id);
  await rule.save();

  await auditAction(
    { id: actor.id, role: actor.role, email: actor.email },
    'rule.withdraw',
    { type: 'Rule', id: rule._id, label: rule.name },
    {
      details: `Withdrew version ${rule.version}; ${issued} certificate(s) were issued under it`,
      outcome: 'SUCCESS',
      headers: req.headers,
    }
  );

  return ok({
    rule: { id: String(rule._id), isActive: false, version: rule.version },
    certificatesIssuedUnderIt: issued,
    message:
      'The rule has been withdrawn. Applications in this scope now fall back to the next broader rule.',
  });
});
