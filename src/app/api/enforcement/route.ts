import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import EnforcementCase from '@/models/EnforcementCase';
import RiskFlag from '@/models/RiskFlag';
import Instrument from '@/models/Instrument';
import Certificate from '@/models/Certificate';
import {
  handle,
  ok,
  requireOfficial,
  optionalAuth,
  scopeFilter,
  isOfficial,
  hasGlobalScope,
  BadRequest,
  NotFound,
  HttpError,
} from '@/lib/rbac';
import { auditAction, writeAudit } from '@/lib/audit';
import { generateEnforcementCaseNo, normalizeCertNo } from '@/lib/ids';
import { clientIpFromHeaders, hashRequesterIp } from '@/lib/utils';
import { notify, notifyOfficers } from '@/lib/notify';
import {
  ENFORCEMENT_CASE_STATUSES,
  ENFORCEMENT_CASE_TYPES,
} from '@/lib/constants';

/**
 * Enforcement cases: the "what happens when something is actually wrong" half of
 * the problem statement.
 *
 * The model existed and nothing read or wrote it, so the system could detect a
 * cloned seal and had nowhere to record what was done about it. Two intake paths,
 * with deliberately different trust levels:
 *
 *  - **An officer** opens a case against an instrument they have jurisdiction over,
 *    optionally from a confirmed risk flag.
 *  - **A member of the public** reports a suspect weighing machine without an
 *    account. This is the path the spec's QR verification story ends at: a customer
 *    scans a fuel dispenser, sees the certificate is expired, and needs somewhere
 *    to say so. It is unauthenticated by design, so it is rate-limited by IP hash
 *    and it may only reference an instrument that actually exists — a complaint
 *    against a made-up serial number is not intake, it is noise.
 *
 * A public complainant never chooses the jurisdiction, severity, or case type
 * beyond "complaint". Those are derived from the referenced record, because a
 * complainant naming their own district would route cases away from the office that
 * should see them.
 */

export const dynamic = 'force-dynamic';

/** Anonymous intake ceiling per source per day. */
const MAX_PUBLIC_COMPLAINTS_PER_IP_PER_DAY = 5;

/** Severity is not in `constants.ts` — it is declared inline on the model. */
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
type Severity = (typeof SEVERITIES)[number];

export const GET = handle(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireOfficial('enforcement.list');
  const sp = req.nextUrl.searchParams;

  const query: Record<string, unknown> = scopeFilter(user, {
    stateField: 'jurisdiction.state',
    districtField: 'jurisdiction.district',
    assigneeField: 'assignedTo',
  });

  /*
   * Looking a case up by its number.
   *
   * A public complainant is handed `VT-ENF-YYYY-NNNNNN` and told to quote it, and
   * every officer notification carries one. Without somewhere to type that number
   * both of those are promises the system cannot keep — an officer taking the call
   * had no way to find the case being quoted at them.
   *
   * Anchored at the start so the unique index on `caseNo` is used rather than a
   * collection scan, and the input is escaped because it arrives from a query
   * string: an unescaped `.*` here would be a full scan on demand.
   */
  const search = (sp.get('search') ?? '').trim().toUpperCase();
  if (search) {
    query.caseNo = { $regex: `^${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
  }

  /*
   * A number is looked up because somebody wants *that* case, which is very often
   * one that has already been closed — so a search with no explicit status asked
   * for searches everything. Without this, quoting the number of a closed case
   * returns nothing and reads as "no such case".
   */
  const status = sp.get('status') ?? (search ? 'all' : 'open');
  if (status === 'open') {
    // Everything still requiring work — the four terminal-ish states are excluded.
    query.status = { $nin: ['CLOSED', 'DISMISSED'] };
  } else if (status === 'closed') {
    query.status = { $in: ['CLOSED', 'DISMISSED'] };
  } else if (status !== 'all') {
    if (!(ENFORCEMENT_CASE_STATUSES as readonly string[]).includes(status)) {
      throw BadRequest(
        `Unknown status "${status}". Use one of ${ENFORCEMENT_CASE_STATUSES.join(', ')}, or open/closed/all.`,
        'INVALID_STATUS'
      );
    }
    query.status = status;
  }

  const caseType = sp.get('caseType');
  if (caseType && caseType !== 'all') {
    if (!(ENFORCEMENT_CASE_TYPES as readonly string[]).includes(caseType)) {
      throw BadRequest(`Unknown case type "${caseType}"`, 'INVALID_CASE_TYPE');
    }
    query.caseType = caseType;
  }

  const severityFilter = sp.get('severity');
  if (severityFilter && severityFilter !== 'all') {
    if (!(SEVERITIES as readonly string[]).includes(severityFilter)) {
      throw BadRequest(`Unknown severity "${severityFilter}"`, 'INVALID_SEVERITY');
    }
    query.severity = severityFilter;
  }

  if (sp.get('mine') === 'true') query.assignedTo = new Types.ObjectId(user.id);
  if (sp.get('unassigned') === 'true') query.assignedTo = { $exists: false };

  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(sp.get('limit') ?? 25) || 25));

  const [cases, total, byStatus, bySeverity, unassigned] = await Promise.all([
    EnforcementCase.find(query)
      // Highest severity first, then oldest, so a HIGH case cannot sit behind a
      // pile of newer LOW ones.
      .sort({ severity: -1, createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('assignedTo', 'name officerCode designation')
      .populate('instrumentId', 'serialNo type brand model installationDistrict')
      .lean(),
    EnforcementCase.countDocuments(query),
    EnforcementCase.aggregate([
      { $match: scopeFilter(user, { stateField: 'jurisdiction.state', districtField: 'jurisdiction.district' }) },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    EnforcementCase.aggregate([
      {
        $match: {
          ...scopeFilter(user, { stateField: 'jurisdiction.state', districtField: 'jurisdiction.district' }),
          status: { $nin: ['CLOSED', 'DISMISSED'] },
        },
      },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]),
    EnforcementCase.countDocuments({
      ...scopeFilter(user, { stateField: 'jurisdiction.state', districtField: 'jurisdiction.district' }),
      status: { $nin: ['CLOSED', 'DISMISSED'] },
      assignedTo: { $exists: false },
    }),
  ]);

  return ok({
    cases: cases.map((c) => ({
      ...c,
      id: String(c._id),
      // The action log can be long; the list only needs its shape.
      actionCount: c.actions?.length ?? 0,
      lastAction: c.actions?.[c.actions.length - 1],
      actions: undefined,
      ageDays: Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86_400_000),
      // A complainant's contact details are not list data.
      complainant: c.complainant
        ? { isAnonymous: c.complainant.isAnonymous, hasContact: Boolean(c.complainant.phone || c.complainant.email) }
        : undefined,
    })),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    summary: {
      byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
      bySeverity: Object.fromEntries(bySeverity.map((r) => [r._id, r.count])),
      unassigned,
    },
    filters: {
      statuses: ENFORCEMENT_CASE_STATUSES,
      caseTypes: ENFORCEMENT_CASE_TYPES,
      severities: SEVERITIES,
    },
  });
});

export const POST = handle(async (req: NextRequest) => {
  await dbConnect();

  // Public intake is a real path, so authentication is optional here and the two
  // branches below are kept strictly apart.
  const actor = await optionalAuth();
  const body = (await req.json()) as Record<string, unknown>;

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  if (title.length < 5) {
    throw BadRequest('Give the case a short title describing the problem', 'TITLE_REQUIRED');
  }
  if (description.length < 20) {
    throw BadRequest(
      'Describe what is wrong in at least a sentence, so an officer can act on it',
      'DESCRIPTION_REQUIRED'
    );
  }

  /* --- Resolve the subject, and derive jurisdiction from it ---------------- */
  let instrument = null;
  let certificate = null;

  if (typeof body.certNo === 'string' && body.certNo.trim()) {
    certificate = await Certificate.findOne({ certNo: normalizeCertNo(body.certNo) })
      .select('certNo instrumentId ownerId organizationId instrumentSnapshot status')
      .lean();
    if (!certificate) {
      throw NotFound(
        'No certificate with that number. Check the number on the sticker, or report the instrument by its serial number instead.'
      );
    }
    instrument = await Instrument.findById(certificate.instrumentId)
      .select('serialNo ownerId organizationId installationState installationDistrict')
      .lean();
  } else if (typeof body.instrumentId === 'string' && Types.ObjectId.isValid(body.instrumentId)) {
    instrument = await Instrument.findById(body.instrumentId)
      .select('serialNo ownerId organizationId installationState installationDistrict')
      .lean();
    if (!instrument) throw NotFound('No such instrument');
  } else if (typeof body.serialNo === 'string' && body.serialNo.trim()) {
    instrument = await Instrument.findOne({
      serialNoNormalized: body.serialNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
    })
      .select('serialNo ownerId organizationId installationState installationDistrict')
      .lean();
    if (!instrument) {
      throw NotFound(
        'No instrument is registered with that serial number. An unregistered instrument is itself a violation — report it to your district Legal Metrology office.'
      );
    }
  }

  const isPublic = !actor || !isOfficial(actor.role);

  /* --- Public complaint --------------------------------------------------- */
  if (isPublic) {
    if (!instrument) {
      throw BadRequest(
        'Name the instrument you are reporting — by certificate number, or by the serial number on its sticker.',
        'SUBJECT_REQUIRED'
      );
    }

    const ipHash = hashRequesterIp(clientIpFromHeaders(req.headers));
    if (ipHash) {
      const recent = await EnforcementCase.countDocuments({
        'complainant.ipHash': ipHash,
        createdAt: { $gte: new Date(Date.now() - 86_400_000) },
      });
      if (recent >= MAX_PUBLIC_COMPLAINTS_PER_IP_PER_DAY) {
        throw new HttpError(
          429,
          'Several reports have already been filed from here today. If this is urgent, contact your district Legal Metrology office directly.',
          'RATE_LIMITED'
        );
      }
    }

    const isAnonymous = body.isAnonymous === true || (!body.contactPhone && !body.contactEmail);

    const created = await EnforcementCase.create({
      caseNo: await generateEnforcementCaseNo(),
      caseType: 'PUBLIC_COMPLAINT',
      // A complainant does not get to set severity; an officer triages it.
      severity: 'MEDIUM',
      status: 'OPEN',
      origin: 'PUBLIC_COMPLAINT',

      instrumentId: instrument._id,
      certificateId: certificate?._id,
      ownerId: instrument.ownerId,
      organizationId: instrument.organizationId,

      title,
      description,

      // Derived, never accepted from the request.
      jurisdiction: {
        state: instrument.installationState,
        district: instrument.installationDistrict,
      },

      complainant: {
        name: isAnonymous ? undefined : typeof body.contactName === 'string' ? body.contactName.trim() : undefined,
        phone: isAnonymous ? undefined : typeof body.contactPhone === 'string' ? body.contactPhone.trim() : undefined,
        email: isAnonymous ? undefined : typeof body.contactEmail === 'string' ? body.contactEmail.trim() : undefined,
        isAnonymous,
        ipHash,
      },

      actions: [
        {
          action: 'FILED',
          note: isAnonymous ? 'Filed anonymously by a member of the public.' : 'Filed by a member of the public.',
          at: new Date(),
        },
      ],

      createdBy: actor ? new Types.ObjectId(actor.id) : undefined,
    });

    await writeAudit({
      action: 'enforcement.complaint',
      userId: actor?.id,
      userRole: actor?.role,
      resourceType: 'EnforcementCase',
      resourceId: created._id,
      resourceLabel: created.caseNo,
      outcome: 'SUCCESS',
      details: `Public complaint against instrument ${instrument.serialNo} in ${instrument.installationDistrict ?? 'an unrecorded district'}`,
      headers: req.headers,
    });

    /*
     * Tell the officers who cover that district. A complaint that lands in a
     * collection nobody is watching is a complaint dropped on the floor, and the
     * public path is exactly the one with no officer already attached to it.
     */
    await notifyOfficers(
      { state: instrument.installationState, district: instrument.installationDistrict },
      ['LMO', 'StateAdmin'],
      {
        type: 'warning',
        title: `New public complaint: ${created.caseNo}`,
        message: `${title} — instrument ${instrument.serialNo}${instrument.installationDistrict ? ` in ${instrument.installationDistrict}` : ''}. Unassigned.`,
        relatedModel: 'EnforcementCase',
        relatedId: created._id,
        actionUrl: `/dashboard/enforcement/${created._id}`,
        actionLabel: 'Triage the complaint',
      }
    ).catch((err) => console.error('[enforcement] officer notification failed:', err));

    /*
     * The response is deliberately thin. A complainant gets their reference number
     * and nothing about the business, the instrument's owner, or the case's
     * internal state — that is not theirs to see, and echoing it back would make
     * this endpoint a lookup tool for anyone who can guess a serial number.
     */
    return ok(
      {
        caseNo: created.caseNo,
        status: 'OPEN',
        message: `Your report has been recorded as ${created.caseNo} and sent to the Legal Metrology office for ${instrument.installationDistrict ?? instrument.installationState ?? 'this area'}. Keep this reference.`,
      },
      201
    );
  }

  /* --- Officer-opened case ------------------------------------------------ */
  const caseType = String(body.caseType ?? 'OTHER').toUpperCase();
  if (!(ENFORCEMENT_CASE_TYPES as readonly string[]).includes(caseType)) {
    throw BadRequest(
      `Unknown case type "${caseType}". Use one of ${ENFORCEMENT_CASE_TYPES.join(', ')}.`,
      'INVALID_CASE_TYPE'
    );
  }

  const severityInput = String(body.severity ?? 'MEDIUM').toUpperCase();
  if (!(SEVERITIES as readonly string[]).includes(severityInput)) {
    throw BadRequest('Severity must be LOW, MEDIUM or HIGH', 'INVALID_SEVERITY');
  }
  const severity = severityInput as Severity;

  // A case opened from a confirmed risk flag carries the flag's evidence forward.
  let riskFlag = null;
  if (typeof body.riskFlagId === 'string' && Types.ObjectId.isValid(body.riskFlagId)) {
    riskFlag = await RiskFlag.findById(body.riskFlagId);
    if (!riskFlag) throw NotFound('No such risk flag');
    if (riskFlag.status !== 'CONFIRMED') {
      throw BadRequest(
        'Confirm the risk flag before opening a case from it, so the case rests on a finding rather than on a detector output.',
        'FLAG_NOT_CONFIRMED'
      );
    }
    if (!instrument && riskFlag.instrumentId) {
      instrument = await Instrument.findById(riskFlag.instrumentId)
        .select('serialNo ownerId organizationId installationState installationDistrict')
        .lean();
    }
  }

  if (!instrument) {
    throw BadRequest(
      'Name the instrument this case is about, by id, serial number or certificate number',
      'SUBJECT_REQUIRED'
    );
  }

  /*
   * An officer may only open a case in their own jurisdiction. 404 rather than 403
   * for an instrument elsewhere, consistent with the rest of the API.
   */
  if (!hasGlobalScope(actor!.role)) {
    if (actor!.state && instrument.installationState !== actor!.state) {
      throw NotFound('No such instrument');
    }
    if (actor!.role === 'LMO' && actor!.district && instrument.installationDistrict !== actor!.district) {
      throw NotFound('No such instrument');
    }
  }

  const created = await EnforcementCase.create({
    caseNo: await generateEnforcementCaseNo(),
    caseType,
    severity,
    status: 'OPEN',
    origin: riskFlag ? 'RISK_FLAG' : 'OFFICER',
    riskFlagId: riskFlag?._id,

    instrumentId: instrument._id,
    certificateId: certificate?._id ?? riskFlag?.certificateId,
    ownerId: instrument.ownerId,
    organizationId: instrument.organizationId,

    title,
    description: riskFlag
      ? `${description}\n\nRisk finding carried forward: ${riskFlag.title}\n${(riskFlag.reasons ?? []).map((r) => `• ${r}`).join('\n')}`
      : description,

    jurisdiction: {
      state: instrument.installationState,
      district: instrument.installationDistrict,
    },

    // Whoever opens a case owns it until it is reassigned, so it never starts
    // life in an unassigned pile.
    assignedTo: new Types.ObjectId(actor!.id),
    assignedAt: new Date(),

    actions: [
      {
        action: 'OPENED',
        note: riskFlag ? `Opened from confirmed risk flag: ${riskFlag.title}` : 'Opened by officer.',
        actorId: new Types.ObjectId(actor!.id),
        actorRole: actor!.role,
        at: new Date(),
      },
    ],

    createdBy: new Types.ObjectId(actor!.id),
  });

  await auditAction(
    { id: actor!.id, role: actor!.role, email: actor!.email },
    'enforcement.open',
    { type: 'EnforcementCase', id: created._id, label: created.caseNo },
    {
      details: `${caseType} (${severity}) against instrument ${instrument.serialNo}${riskFlag ? ` from risk flag ${riskFlag._id}` : ''}`,
      headers: req.headers,
    }
  );

  /*
   * The business is told a case has been opened. Enforcement without notice is
   * not due process, and the owner needs the chance to respond.
   */
  if (instrument.ownerId) {
    await notify({
      userId: String(instrument.ownerId),
      type: severity === 'HIGH' ? 'error' : 'warning',
      title: `Enforcement case ${created.caseNo} opened`,
      message: `A case has been opened concerning instrument ${instrument.serialNo}: ${title}. The Legal Metrology office will contact you.`,
      relatedModel: 'EnforcementCase',
      relatedId: created._id,
      actionUrl: `/dashboard/enforcement/${created._id}`,
      actionLabel: 'View the case',
      alsoExternal: true,
    }).catch((err) => console.error('[enforcement] owner notification failed:', err));
  }

  return ok({ case: { ...created.toObject(), id: String(created._id) } }, 201);
});
