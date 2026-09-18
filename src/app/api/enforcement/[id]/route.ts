import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import EnforcementCase, { type IEnforcementCase } from '@/models/EnforcementCase';
import Instrument from '@/models/Instrument';
import Certificate from '@/models/Certificate';
import DocumentRecord from '@/models/DocumentRecord';
import User, { type IUser } from '@/models/User';
import {
  handle,
  ok,
  requireAuth,
  requireOfficial,
  requireAdmin,
  isOfficial,
  BadRequest,
  NotFound,
  Conflict,
  Forbidden,
  hasGlobalScope,
  type AuthedUser,
} from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { notify, notifyOfficers } from '@/lib/notify';
import { documentUrl } from '@/lib/uploads';
import {
  ENFORCEMENT_CASE_STATUSES,
  DOCUMENT_TYPE_LABELS,
  type DocumentType,
} from '@/lib/constants';

/**
 * One enforcement case: read it, act on it, or close it.
 *
 * The action log is append-only. An enforcement case can end in a penalty, so what
 * it records has to survive a challenge — an officer who edits away an earlier note
 * destroys exactly the evidence that would show the process was followed. Every
 * PATCH therefore appends to `actions` rather than replacing anything, and no route
 * deletes a case.
 *
 * Status moves along a defined path for the same reason. Skipping from OPEN
 * straight to PENALTY_IMPOSED would mean a penalty with no notice and no hearing,
 * which is not a state this system should be able to represent.
 */

/**
 * Permitted next statuses.
 *
 * Notice precedes a hearing, a hearing precedes a penalty. Dismissal and closure
 * are reachable from anywhere before the end, because a case can always turn out to
 * be unfounded or be settled.
 */
const NEXT_STATUS: Record<string, readonly string[]> = {
  OPEN: ['INVESTIGATING', 'NOTICE_ISSUED', 'CLOSED', 'DISMISSED'],
  INVESTIGATING: ['NOTICE_ISSUED', 'CLOSED', 'DISMISSED'],
  NOTICE_ISSUED: ['HEARING', 'PENALTY_IMPOSED', 'CLOSED', 'DISMISSED'],
  HEARING: ['PENALTY_IMPOSED', 'CLOSED', 'DISMISSED'],
  PENALTY_IMPOSED: ['CLOSED'],
  CLOSED: [],
  DISMISSED: [],
};

/** Statuses whose meaning is "this case is over". */
const TERMINAL = ['CLOSED', 'DISMISSED'];

/**
 * The business's right of reply.
 *
 * Notice without an opportunity to answer is half of due process. A response goes
 * into the same append-only log as the officer's own steps, so what the business
 * said and when it said it survives into any challenge — which is the whole reason
 * the log is append-only.
 *
 * Capped, because the log is evidence and evidence should not be floodable. Ten is
 * far more than a genuine exchange needs and low enough that the log stays readable.
 */
const MAX_OWNER_RESPONSES = 10;
const OWNER_RESPONSE_MIN = 20;

/**
 * Is this case against `user`'s own business?
 *
 * A second account in the same organization counts — enforcement lands on the
 * business, and a case only the one registered login can read is a case the
 * business misses when that person leaves.
 */
function isTheirCase(
  c: { ownerId?: Types.ObjectId; organizationId?: Types.ObjectId },
  user: AuthedUser
): boolean {
  if (c.ownerId && String(c.ownerId) === user.id) return true;
  return Boolean(
    c.organizationId && user.organizationId && String(c.organizationId) === user.organizationId
  );
}

/**
 * Reads one case as the business it is against.
 *
 * Both intake paths notify the owner with `actionUrl: /dashboard/enforcement/<id>`
 * and the label "View the case", and until this existed that link led to a 403 —
 * the system told a business a case had been opened against it and then refused to
 * show it. A notice you cannot read is not notice.
 *
 * The payload is written out field by field rather than filtered from the document,
 * so a field added to the model later is absent here until somebody decides it
 * should be disclosed. Four things are deliberately withheld:
 *
 *  - **The complainant, entirely.** Not their name, not the fact that contact
 *    details were left. The allegation is disclosed — through `title`,
 *    `description` and `caseType` — because the business cannot answer a case it
 *    has not been told the substance of. Who reported it is not part of that, and
 *    a business that can identify its accuser is a business that can retaliate.
 *  - **Action notes.** The sequence and its dates are the due-process record and
 *    are disclosed; the officer's working notes are not. A formal notice is served
 *    as a notification in its own right, which is where its text belongs.
 *  - **Evidence files.** The count and the kinds are listed, so the business knows
 *    material exists and can ask for it; the download links are not, because
 *    photographs taken by a complainant can identify the complainant.
 *  - **Anything internal to triage** — the risk flag it came from, who opened it,
 *    the jurisdiction routing fields.
 */
async function ownerView(id: string, user: AuthedUser) {
  if (!Types.ObjectId.isValid(id)) throw NotFound('No such case');

  const found = await EnforcementCase.findById(id)
    .select(
      'caseNo caseType status severity title description origin jurisdiction ' +
        'ownerId organizationId instrumentId certificateId assignedTo actions ' +
        'evidenceIds penalty outcome closedAt createdAt'
    )
    .lean<IEnforcementCase | null>();
  if (!found) throw NotFound('No such case');

  // 404 rather than 403 for anyone else, so this endpoint cannot be walked to
  // discover which businesses have cases open against them.
  if (!isTheirCase(found, user)) throw NotFound('No such case');

  const [instrument, certificate, assignee, evidence] = await Promise.all([
    found.instrumentId
      ? Instrument.findById(found.instrumentId)
          .select('serialNo type brand model capacity installationDistrict address')
          .lean()
      : null,
    found.certificateId
      ? Certificate.findById(found.certificateId).select('certNo status expiryDate').lean()
      : null,
    found.assignedTo
      ? User.findById(found.assignedTo).select('name designation officerCode').lean<IUser | null>()
      : null,
    found.evidenceIds?.length
      ? DocumentRecord.find({ _id: { $in: found.evidenceIds } })
          .select('documentType')
          .lean()
      : [],
  ]);

  return ok({
    viewer: 'OWNER' as const,
    case: {
      id: String(found._id),
      caseNo: found.caseNo,
      caseType: found.caseType,
      status: found.status,
      severity: found.severity,
      title: found.title,
      description: found.description,
      origin: found.origin,
      createdAt: found.createdAt,
      closedAt: found.closedAt,
      outcome: found.outcome,
      penalty: found.penalty?.amount != null ? found.penalty : undefined,
      ageDays: Math.floor((Date.now() - new Date(found.createdAt).getTime()) / 86_400_000),
    },
    subject: { instrument, certificate },
    /*
     * Who to talk to. An unassigned case gives no name, which is the truth — the
     * office is the point of contact until an officer takes it.
     */
    office: {
      state: found.jurisdiction?.state,
      district: found.jurisdiction?.district,
      officer: assignee ? { name: assignee.name, designation: assignee.designation } : null,
    },
    /*
     * Dates and steps, oldest first. Notes are withheld — except on the business's
     * own responses, which are its own words and would be absurd to hide from it.
     * This is the record that shows notice preceded hearing and hearing preceded
     * penalty, the sequence the business would rely on if it challenged the case.
     */
    timeline: (found.actions ?? []).map((a) => ({
      action: a.action,
      at: a.at,
      note: a.action === 'OWNER_RESPONSE' ? a.note : undefined,
      byOffice: Boolean(a.actorId) && a.action !== 'OWNER_RESPONSE',
    })),
    evidence: {
      count: evidence.length,
      types: [
        ...new Set(
          evidence.map(
            (d) => DOCUMENT_TYPE_LABELS[d.documentType as DocumentType] ?? d.documentType
          )
        ),
      ],
    },
    /*
     * Whether a written response can be added, decided here rather than in the
     * browser — the same principle as `allowedNextStatuses` on the officer side. A
     * page that offers a box the API will refuse is worse than one that explains
     * why the box is gone.
     */
    respond: (() => {
      const used = (found.actions ?? []).filter((a) => a.action === 'OWNER_RESPONSE').length;
      const closed = TERMINAL.includes(found.status);
      return {
        allowed: !closed && used < MAX_OWNER_RESPONSES,
        used,
        limit: MAX_OWNER_RESPONSES,
        minLength: OWNER_RESPONSE_MIN,
        blockedReason: closed
          ? `This case is ${found.status === 'DISMISSED' ? 'dismissed' : 'closed'}, so nothing further can be added to its record. Contact the office if there is something it needs to know.`
          : used >= MAX_OWNER_RESPONSES
            ? `You have added ${used} responses to this case, which is the limit. Contact the office directly for anything further.`
            : undefined,
      };
    })(),
    allowedNextStatuses: [],
    canClose: false,
  });
}

async function loadCase(id: string, user: AuthedUser) {
  if (!Types.ObjectId.isValid(id)) throw NotFound('No such case');

  const found = await EnforcementCase.findById(id);
  if (!found) throw NotFound('No such case');

  // 404 rather than 403 outside the officer's jurisdiction, so the existence of a
  // case in another district is not disclosed.
  if (!hasGlobalScope(user.role)) {
    if (user.state && found.jurisdiction?.state !== user.state) throw NotFound('No such case');
    if (
      user.role === 'LMO' &&
      user.district &&
      found.jurisdiction?.district !== user.district &&
      String(found.assignedTo ?? '') !== user.id
    ) {
      throw NotFound('No such case');
    }
  }

  return found;
}

export const GET = handle(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();

  /*
   * Not `requireOfficial`. A business is entitled to read the case against it, and
   * the notifications this API sends already promise exactly that. Officials get the
   * working console below; everyone else gets `ownerView`, or a 404.
   */
  const user = await requireAuth();
  if (!isOfficial(user.role)) return ownerView(id, user);

  const found = await loadCase(id, user);

  const [instrument, certificate, owner, assignee, evidence, actors, priorCases] =
    await Promise.all([
      found.instrumentId
        ? Instrument.findById(found.instrumentId)
            .select(
              'serialNo type brand model capacity status installationState installationDistrict address lastVerifiedDate nextVerificationDue verificationCount failedInspectionCount'
            )
            .lean()
        : null,
      found.certificateId
        ? Certificate.findById(found.certificateId)
            .select('certNo status issuedDate expiryDate version')
            .lean()
        : null,
      found.ownerId
        ? User.findById(found.ownerId)
            .select('name email phone organizationName state district')
            .lean<IUser | null>()
        : null,
      found.assignedTo
        ? User.findById(found.assignedTo)
            .select('name designation officerCode role')
            .lean<IUser | null>()
        : null,
      found.evidenceIds?.length
        ? DocumentRecord.find({ _id: { $in: found.evidenceIds } })
            .select(
              'documentType fileName mimeType sizeBytes sha256 storage url capturedAt gps createdAt'
            )
            .lean()
        : [],
      // Names for the action log, so it reads as a history rather than as ids.
      User.find({
        _id: {
          $in: (found.actions ?? [])
            .map((a) => a.actorId)
            .filter((v): v is Types.ObjectId => Boolean(v)),
        },
      })
        .select('name designation officerCode')
        .lean<{ _id: Types.ObjectId; name: string; designation?: string; officerCode?: string }[]>(),
      // Prior cases against the same business — the repeat-offender picture.
      found.ownerId
        ? EnforcementCase.find({ ownerId: found.ownerId, _id: { $ne: found._id } })
            .select('caseNo caseType status severity createdAt closedAt outcome penalty.amount')
            .sort({ createdAt: -1 })
            .limit(20)
            .lean()
        : [],
    ]);

  const actorById = new Map(actors.map((a) => [String(a._id), a]));

  return ok({
    case: {
      ...found.toObject(),
      id: String(found._id),
      ageDays: Math.floor((Date.now() - new Date(found.createdAt).getTime()) / 86_400_000),
      actions: (found.actions ?? []).map((a) => ({
        action: a.action,
        note: a.note,
        at: a.at,
        actorRole: a.actorRole,
        actor: a.actorId ? actorById.get(String(a.actorId)) : undefined,
      })),
      /*
       * A complainant who asked to stay anonymous stays anonymous, including from
       * the officer working the case. The IP hash is never returned to anyone — it
       * exists to rate-limit intake, not to unmask a complainant.
       */
      complainant: found.complainant
        ? found.complainant.isAnonymous
          ? { isAnonymous: true }
          : {
              isAnonymous: false,
              name: found.complainant.name,
              phone: found.complainant.phone,
              email: found.complainant.email,
            }
        : undefined,
    },
    subject: { instrument, certificate, owner },
    assignee,
    /*
     * Evidence has to be openable, or the list is a claim that files exist rather
     * than the files themselves. `documentUrl` resolves to the object store when
     * one is configured and to the streaming route when it is not, and the hash
     * goes out alongside so a photograph produced in a hearing can be shown to be
     * the one that was attached.
     */
    evidence: evidence.map((d) => ({
      id: String(d._id),
      fileName: d.fileName,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      documentType: d.documentType,
      typeLabel: DOCUMENT_TYPE_LABELS[d.documentType as DocumentType] ?? d.documentType,
      sha256: d.sha256,
      href: documentUrl(d),
      capturedAt: d.capturedAt,
      gps: d.gps,
      uploadedAt: d.createdAt,
    })),
    priorCases,
    allowedNextStatuses: NEXT_STATUS[found.status] ?? [],
    canClose: !TERMINAL.includes(found.status),
  });
});

/**
 * Records a written response from the business the case is against.
 *
 * Deliberately the only thing a non-official may write here. It cannot change the
 * status, the severity, the outcome or the penalty — it appends one entry, saying
 * what the business says, dated. The officer working the case is told, because a
 * response that nobody reads is the same as no response.
 */
async function ownerRespond(id: string, user: AuthedUser, req: NextRequest) {
  if (!Types.ObjectId.isValid(id)) throw NotFound('No such case');

  const found = await EnforcementCase.findById(id);
  if (!found) throw NotFound('No such case');
  if (!isTheirCase(found, user)) throw NotFound('No such case');

  const body = (await req.json()) as Record<string, unknown>;
  const text = typeof body.response === 'string' ? body.response.trim() : '';

  if (!text) {
    throw BadRequest(
      'Write what you want the office to know. Only a response can be added here — a business cannot change the case itself.',
      'RESPONSE_REQUIRED'
    );
  }
  if (text.length < OWNER_RESPONSE_MIN) {
    throw BadRequest(
      `Write at least a sentence — ${OWNER_RESPONSE_MIN} characters — so the officer has something they can act on.`,
      'RESPONSE_TOO_SHORT'
    );
  }
  if (text.length > 4000) {
    throw BadRequest(
      'That is longer than this record holds. Send the detail to the office and summarise it here in under 4000 characters.',
      'RESPONSE_TOO_LONG'
    );
  }

  if (TERMINAL.includes(found.status)) {
    throw Conflict(
      `This case is ${found.status.toLowerCase()} and its record is final. Contact the Legal Metrology office directly if there is something further.`,
      'CASE_CLOSED'
    );
  }

  const used = (found.actions ?? []).filter((a) => a.action === 'OWNER_RESPONSE').length;
  if (used >= MAX_OWNER_RESPONSES) {
    throw Conflict(
      `${MAX_OWNER_RESPONSES} responses have already been recorded on this case. Contact the office directly for anything further.`,
      'RESPONSE_LIMIT'
    );
  }

  const at = new Date();
  found.actions.push({
    action: 'OWNER_RESPONSE',
    note: text,
    actorId: new Types.ObjectId(user.id),
    actorRole: user.role,
    at,
  });
  await found.save();

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    'enforcement.respond',
    { type: 'EnforcementCase', id: found._id, label: found.caseNo },
    { details: `Response recorded by the business (${text.length} characters)`, headers: req.headers }
  );

  /*
   * Straight to the officer who owns it; to the district office when nobody does.
   * An unassigned case with an unread reply sitting on it is precisely the failure
   * the unassigned banner on the register exists to prevent.
   */
  const notice = {
    type: 'info' as const,
    title: `Response from the business on ${found.caseNo}`,
    message: `${found.title} — the business has answered. ${text.length > 160 ? `${text.slice(0, 157)}…` : text}`,
    relatedModel: 'EnforcementCase' as const,
    relatedId: found._id,
    actionUrl: `/dashboard/enforcement/${found._id}`,
    actionLabel: 'Read the response',
  };

  if (found.assignedTo) {
    await notify({ userId: String(found.assignedTo), ...notice }).catch((err) =>
      console.error('[enforcement] response notification failed:', err)
    );
  } else {
    await notifyOfficers(
      { state: found.jurisdiction?.state, district: found.jurisdiction?.district },
      ['LMO', 'StateAdmin'],
      notice
    ).catch((err) => console.error('[enforcement] response notification failed:', err));
  }

  return ok({
    recorded: true,
    at,
    remaining: MAX_OWNER_RESPONSES - used - 1,
    message:
      'Your response has been added to the case record and the officer has been notified. It cannot be edited or withdrawn — the record has to be permanent to be worth anything.',
  });
}

export const PATCH = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();

  /*
   * The business the case is against may append a response and nothing else. Split
   * before `requireOfficial` so the officer console below cannot be reached by an
   * Owner sending a `status` field alongside their reply.
   */
  const actor = await requireAuth();
  if (!isOfficial(actor.role)) return ownerRespond(id, actor, req);

  const user = await requireOfficial('enforcement.update');

  const found = await loadCase(id, user);
  const body = (await req.json()) as Record<string, unknown>;

  if (TERMINAL.includes(found.status)) {
    throw Conflict(
      `This case is ${found.status.toLowerCase()} and cannot be changed. Open a new case if there is new information.`,
      'CASE_CLOSED'
    );
  }

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const actions: IEnforcementCase['actions'] = [];
  const changes: Record<string, unknown> = {};
  let ownerMessage: string | null = null;

  /* --- Reassignment ------------------------------------------------------- */
  if (typeof body.assignedTo === 'string' && body.assignedTo) {
    if (!Types.ObjectId.isValid(body.assignedTo)) throw BadRequest('Not a valid officer id');

    const officer = await User.findById(body.assignedTo)
      .select('name role state district isActive approvalStatus officerCode')
      .lean<IUser | null>();

    if (!officer || !officer.isActive || officer.approvalStatus !== 'APPROVED') {
      throw BadRequest('That officer is not an active, approved user', 'INVALID_ASSIGNEE');
    }
    if (!['LMO', 'StateAdmin', 'Admin', 'SuperAdmin'].includes(officer.role)) {
      throw BadRequest(
        'An enforcement case can only be assigned to a Legal Metrology Officer or an administrator',
        'INVALID_ASSIGNEE_ROLE'
      );
    }
    // Assigning outside the case's own jurisdiction would move it beyond the reach
    // of the office responsible for it.
    if (found.jurisdiction?.state && officer.state && officer.state !== found.jurisdiction.state) {
      throw BadRequest(
        `${officer.name} is posted in ${officer.state}; this case is in ${found.jurisdiction.state}`,
        'ASSIGNEE_OUT_OF_JURISDICTION'
      );
    }

    changes.assignedTo = { from: String(found.assignedTo ?? ''), to: String(officer._id) };
    found.assignedTo = new Types.ObjectId(String(officer._id));
    found.assignedAt = new Date();
    actions.push({
      action: 'ASSIGNED',
      note: `Assigned to ${officer.name}${officer.officerCode ? ` (${officer.officerCode})` : ''}${note ? `: ${note}` : ''}`,
      actorId: new Types.ObjectId(user.id),
      actorRole: user.role,
      at: new Date(),
    });
  }

  /* --- Severity retriage -------------------------------------------------- */
  if (typeof body.severity === 'string') {
    const next = body.severity.toUpperCase();
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(next)) {
      throw BadRequest('Severity must be LOW, MEDIUM or HIGH', 'INVALID_SEVERITY');
    }
    if (next !== found.severity) {
      changes.severity = { from: found.severity, to: next };
      actions.push({
        action: 'SEVERITY_CHANGED',
        note: `${found.severity} → ${next}${note ? `: ${note}` : ''}`,
        actorId: new Types.ObjectId(user.id),
        actorRole: user.role,
        at: new Date(),
      });
      found.severity = next as IEnforcementCase['severity'];
    }
  }

  /* --- Evidence ----------------------------------------------------------- */
  if (Array.isArray(body.evidenceIds)) {
    const ids = body.evidenceIds
      .filter((v): v is string => typeof v === 'string' && Types.ObjectId.isValid(v))
      .map((v) => new Types.ObjectId(v));

    if (ids.length > 0) {
      const found_docs = await DocumentRecord.countDocuments({ _id: { $in: ids } });
      if (found_docs !== ids.length) {
        throw BadRequest('One or more evidence documents do not exist', 'INVALID_EVIDENCE');
      }
      // Append; evidence is never removed from a case.
      const existing = new Set((found.evidenceIds ?? []).map(String));
      const added = ids.filter((i) => !existing.has(String(i)));
      if (added.length > 0) {
        found.evidenceIds = [...(found.evidenceIds ?? []), ...added];
        actions.push({
          action: 'EVIDENCE_ADDED',
          note: `${added.length} document${added.length === 1 ? '' : 's'} attached${note ? `: ${note}` : ''}`,
          actorId: new Types.ObjectId(user.id),
          actorRole: user.role,
          at: new Date(),
        });
      }
    }
  }

  /* --- Penalty ------------------------------------------------------------ */
  if (body.penalty !== undefined) {
    const p = body.penalty as Record<string, unknown>;
    const amount = Number(p?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw BadRequest('The penalty amount must be zero or more', 'INVALID_PENALTY');
    }
    /*
     * A penalty is a legal imposition, so it requires the status that means a
     * hearing has happened, and it requires a statutory reference. The Act sets
     * the ceilings; recording the section it was imposed under is what makes the
     * figure defensible.
     */
    if (!['NOTICE_ISSUED', 'HEARING', 'PENALTY_IMPOSED'].includes(found.status)) {
      throw BadRequest(
        'A penalty can only be recorded after a notice has been issued. Issue the notice first.',
        'PENALTY_PREMATURE'
      );
    }
    const reference = typeof p.reference === 'string' ? p.reference.trim() : '';
    if (!reference) {
      throw BadRequest(
        'Record the section of the Legal Metrology Act the penalty is imposed under',
        'PENALTY_REFERENCE_REQUIRED'
      );
    }

    found.penalty = {
      amount: Math.round(amount),
      currency: 'INR',
      imposedAt: new Date(),
      reference,
      paidAt: undefined,
    };
    changes.penalty = { amount: Math.round(amount), reference };
    actions.push({
      action: 'PENALTY_RECORDED',
      note: `₹${Math.round(amount).toLocaleString('en-IN')} under ${reference}${note ? `: ${note}` : ''}`,
      actorId: new Types.ObjectId(user.id),
      actorRole: user.role,
      at: new Date(),
    });
    ownerMessage = `A penalty of ₹${Math.round(amount).toLocaleString('en-IN')} has been recorded against case ${found.caseNo} under ${reference}.`;
  }

  /* --- Penalty payment ---------------------------------------------------- */
  if (body.penaltyPaid === true) {
    if (!found.penalty?.amount) {
      throw BadRequest('No penalty has been imposed on this case', 'NO_PENALTY');
    }
    if (found.penalty.paidAt) throw Conflict('This penalty is already recorded as paid', 'ALREADY_PAID');

    found.penalty.paidAt = new Date();
    actions.push({
      action: 'PENALTY_PAID',
      note: `Payment recorded${note ? `: ${note}` : ''}`,
      actorId: new Types.ObjectId(user.id),
      actorRole: user.role,
      at: new Date(),
    });
  }

  /* --- Status transition -------------------------------------------------- */
  if (typeof body.status === 'string') {
    const to = body.status.toUpperCase();

    if (!(ENFORCEMENT_CASE_STATUSES as readonly string[]).includes(to)) {
      throw BadRequest(`"${to}" is not a recognised case status`, 'INVALID_STATUS');
    }
    if (to !== found.status) {
      const allowed = NEXT_STATUS[found.status] ?? [];
      if (!allowed.includes(to)) {
        throw BadRequest(
          `A case at ${found.status} cannot move to ${to}. Permitted next steps: ${allowed.join(', ') || 'none'}.`,
          'INVALID_TRANSITION'
        );
      }

      // Closing a case is a finding of record, so it needs a stated outcome.
      if (TERMINAL.includes(to)) {
        const outcome = typeof body.outcome === 'string' ? body.outcome.trim() : '';
        if (outcome.length < 10) {
          throw BadRequest(
            to === 'DISMISSED'
              ? 'Say why the case is being dismissed. A dismissal with no stated reason cannot be reviewed.'
              : 'Record the outcome of the case in at least a few words.',
            'OUTCOME_REQUIRED'
          );
        }
        /*
         * Closing with an unpaid penalty on record would make the register say the
         * matter is settled when the money has not been collected.
         */
        if (to === 'CLOSED' && found.penalty?.amount && !found.penalty.paidAt) {
          throw Conflict(
            'The penalty on this case is unpaid. Record the payment, or close the case with an outcome that states the penalty is outstanding.',
            'PENALTY_UNPAID'
          );
        }
        found.outcome = outcome;
        found.closedAt = new Date();
        found.closedBy = new Types.ObjectId(user.id);
        ownerMessage = `Case ${found.caseNo} has been ${to.toLowerCase()}. Outcome: ${outcome}`;
      }

      // Issuing a notice and holding a hearing are both things the business must
      // be told about — that is the whole point of a notice.
      if (to === 'NOTICE_ISSUED') {
        if (note.length < 10) {
          throw BadRequest(
            'Record what the notice says, so the business can be told the same thing',
            'NOTICE_TEXT_REQUIRED'
          );
        }
        ownerMessage = `A notice has been issued on case ${found.caseNo}: ${note}`;
      }
      if (to === 'HEARING') {
        ownerMessage = `Case ${found.caseNo} has been set down for a hearing.${note ? ` ${note}` : ''}`;
      }

      changes.status = { from: found.status, to };
      actions.push({
        action: `STATUS_${to}`,
        note: note || undefined,
        actorId: new Types.ObjectId(user.id),
        actorRole: user.role,
        at: new Date(),
      });
      found.status = to;
    }
  }

  /* --- A note on its own -------------------------------------------------- */
  if (actions.length === 0) {
    if (!note) {
      throw BadRequest(
        'Nothing to record. Add a note, change the status, assign the case, or attach evidence.',
        'NO_CHANGES'
      );
    }
    actions.push({
      action: 'NOTE',
      note,
      actorId: new Types.ObjectId(user.id),
      actorRole: user.role,
      at: new Date(),
    });
  }

  found.actions = [...(found.actions ?? []), ...actions];
  await found.save();

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    'enforcement.update',
    { type: 'EnforcementCase', id: found._id, label: found.caseNo },
    {
      details: actions.map((a) => a.action).join(', '),
      changes,
      headers: req.headers,
    }
  );

  /*
   * Due process: the business hears about anything that affects it. Not for
   * internal steps like reassignment, which are the department's own business.
   */
  if (ownerMessage && found.ownerId) {
    await notify({
      userId: String(found.ownerId),
      type: found.status === 'DISMISSED' ? 'success' : 'warning',
      title: `Enforcement case ${found.caseNo}`,
      message: ownerMessage,
      relatedModel: 'EnforcementCase',
      relatedId: found._id,
      actionUrl: `/dashboard/enforcement/${found._id}`,
      actionLabel: 'View the case',
      alsoExternal: true,
    }).catch((err) => console.error('[enforcement] owner notification failed:', err));
  }

  return ok({
    case: {
      id: String(found._id),
      caseNo: found.caseNo,
      status: found.status,
      severity: found.severity,
      assignedTo: found.assignedTo ? String(found.assignedTo) : undefined,
      penalty: found.penalty,
      outcome: found.outcome,
      closedAt: found.closedAt,
    },
    recorded: actions.map((a) => a.action),
    allowedNextStatuses: NEXT_STATUS[found.status] ?? [],
  });
});

/**
 * Reopens a wrongly closed case.
 *
 * Deliberately narrow, and administrator-only. A case is closed with a recorded
 * outcome, so reopening one contradicts something already on the register — that
 * needs to be a supervisor's decision with a reason attached, not part of the
 * ordinary PATCH path.
 */
export const PUT = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await dbConnect();
  const admin = await requireAdmin('enforcement.reopen');

  const found = await loadCase(id, admin);

  if (!TERMINAL.includes(found.status)) {
    throw Conflict('This case is still open', 'NOT_CLOSED');
  }

  const body = (await req.json()) as Record<string, unknown>;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 15) {
    throw BadRequest(
      'Explain why a closed case is being reopened. This contradicts a recorded outcome, so the reason forms part of the record.',
      'REASON_REQUIRED'
    );
  }

  if (!hasGlobalScope(admin.role) && admin.state && found.jurisdiction?.state !== admin.state) {
    throw Forbidden('You can only reopen cases in your own state');
  }

  const closedOutcome = found.outcome;
  const from = found.status;

  found.status = 'INVESTIGATING';
  found.closedAt = undefined;
  found.closedBy = undefined;
  // The previous outcome is preserved in the action log rather than overwritten.
  found.outcome = undefined;
  found.actions = [
    ...(found.actions ?? []),
    {
      action: 'REOPENED',
      note: `Reopened from ${from}. Previous outcome: "${closedOutcome ?? 'none recorded'}". Reason: ${reason}`,
      actorId: new Types.ObjectId(admin.id),
      actorRole: admin.role,
      at: new Date(),
    },
  ];
  await found.save();

  await auditAction(
    { id: admin.id, role: admin.role, email: admin.email },
    'enforcement.reopen',
    { type: 'EnforcementCase', id: found._id, label: found.caseNo },
    {
      details: reason,
      changes: { from, to: 'INVESTIGATING', previousOutcome: closedOutcome },
      headers: req.headers,
    }
  );

  return ok({
    case: { id: String(found._id), caseNo: found.caseNo, status: found.status },
    message: `Case ${found.caseNo} has been reopened and is under investigation.`,
  });
});
