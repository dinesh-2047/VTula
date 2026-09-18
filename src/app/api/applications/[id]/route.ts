import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Application from '@/models/Application';
import Instrument from '@/models/Instrument';
import Inspection from '@/models/Inspection';
import Certificate from '@/models/Certificate';
import Schedule from '@/models/Schedule';
import DocumentRecord from '@/models/DocumentRecord';
import RiskFlag from '@/models/RiskFlag';
import { handle, ok, requireAuth, BadRequest, NotFound, isOfficial } from '@/lib/rbac';
import { findApplicationForUser, availableTransitions } from '@/lib/workflow';
import { resolveRule } from '@/lib/rules';
import { documentUrl } from '@/lib/uploads';
import { auditAction } from '@/lib/audit';
import { OWNER_ACTION_STATUSES } from '@/lib/constants';

/**
 * A single application, with everything the detail page needs in one request.
 *
 * There was no detail endpoint before — the applications list page held all the
 * data it could show, so an owner had no way to see the status history, the
 * officer's query, the inspection readings or the applicable rule.
 *
 * `findApplicationForUser` does the scoping, and returns null (→ 404) rather
 * than 403 for an out-of-jurisdiction id so ids are not enumerable.
 */

export const GET = handle(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const user = await requireAuth();

  const app = await findApplicationForUser(id, user);
  if (!app) throw NotFound('No such application');

  const [instrument, inspections, certificate, schedule, documents, riskFlags] = await Promise.all([
    Instrument.findById(app.instrumentId).lean(),
    /*
     * An owner sees the finished report, not a half-filled draft.
     *
     * This was an unfiltered `find`, so a business could read an inspection while
     * the officer was still typing it — the detail page even renders a `draft`
     * badge, which is how visible the leak was. Worse, the page takes
     * `currentInspection` as the first non-superseded row and feeds its result into
     * the decision panel, so a draft could stand in for the signed report and tell
     * a deciding officer the instrument had passed before anyone had said so.
     *
     * `/api/inspections` has filtered this for non-officials from the start; the
     * detail route, which is where the decision is actually made, did not.
     */
    Inspection.find({
      applicationId: app._id,
      ...(isOfficial(user.role) ? {} : { isSubmitted: true }),
    })
      .sort({ version: -1 })
      .lean(),
    app.certificateId ? Certificate.findById(app.certificateId).lean() : null,
    app.scheduleId
      ? Schedule.findById(app.scheduleId).populate('assignedTo', 'name role designation phone').lean()
      : Schedule.findOne({ applicationId: app._id })
          .sort({ createdAt: -1 })
          .populate('assignedTo', 'name role designation phone')
          .lean(),
    DocumentRecord.find({ _id: { $in: app.documentIds ?? [] } })
      .select('_id fileName mimeType sizeBytes documentType storage url sha256 version isSuperseded createdAt')
      .lean(),
    // Risk flags are an internal advisory signal — an owner must not see the
    // department's suspicion list about their own file.
    isOfficial(user.role)
      ? RiskFlag.find({ applicationId: app._id, status: { $in: ['OPEN', 'REVIEWING', 'CONFIRMED'] } })
          .select('flagType level score title reasons recommendedAction status detectedAt')
          .lean()
      : [],
  ]);

  const rule = instrument
    ? await resolveRule(instrument.installationState, instrument.type)
    : null;

  /*
   * Inspection evidence, resolved to fetchable links.
   *
   * `evidenceIds` came back as bare ObjectIds, so the officer deciding the
   * application could see that the rule's mandatory photographs had been attached
   * and could not open a single one of them — which is the entire purpose of
   * requiring them. The requirement is enforced at submission by
   * `POST /api/inspections` and was then unreachable at the only point where it
   * matters. `/api/inspections` carries a comment about having fixed exactly this
   * for its list; the detail route, which is where the decision is made, still had
   * the bug.
   *
   * `capturedAt` and `gps` come along because a photograph taken a day later, or a
   * kilometre from the registered site, is worth an officer noticing.
   */
  const citedEvidence = [
    ...new Set(inspections.flatMap((i) => (i.evidenceIds ?? []).map(String))),
  ];
  const evidenceDocs = citedEvidence.length
    ? await DocumentRecord.find({ _id: { $in: citedEvidence } })
        .select('_id fileName mimeType sizeBytes documentType storage url sha256 capturedAt gps')
        .lean()
    : [];
  const evidenceById = new Map(
    evidenceDocs.map((d) => [String(d._id), { ...d, id: String(d._id), href: documentUrl(d) }])
  );

  await Application.populate(app, [
    { path: 'assignedTo', select: 'name role designation phone' },
    { path: 'ownerId', select: 'name email phone organizationName' },
    { path: 'statusHistory.actorId', select: 'name role' },
    { path: 'queries.raisedBy', select: 'name role designation' },
    { path: 'decision.decidedBy', select: 'name role designation officerCode' },
  ]);

  return ok({
    application: app.toObject(),
    instrument,
    inspections: inspections.map((i) => ({
      ...i,
      evidence: (i.evidenceIds ?? [])
        .map((eid) => evidenceById.get(String(eid)))
        .filter((d): d is NonNullable<typeof d> => Boolean(d)),
    })),
    certificate,
    schedule,
    documents: documents.map((d) => ({ ...d, href: documentUrl(d) })),
    riskFlags,
    // The rule is returned so the UI can explain *why* the fee and validity are
    // what they are, rather than showing an unexplained number.
    appliedRule: rule
      ? {
          name: rule.name,
          matchedScope: rule.matchedScope,
          validityMonths: rule.validityMonths,
          requiredDocuments: rule.requiredDocuments,
          sla: rule.sla,
          legalReference: rule.legalReference,
        }
      : null,
    availableTransitions: availableTransitions(app, user),
  });
});

/**
 * Owner edits to a draft, and the owner's response to an officer's query.
 *
 * Officers do not edit application content here — they act through
 * `POST /api/applications/[id]/transition`, which records who changed what.
 */
export const PATCH = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const user = await requireAuth();

  const app = await findApplicationForUser(id, user);
  if (!app) throw NotFound('No such application');

  if (String(app.ownerId) !== user.id) {
    throw BadRequest('Only the applicant can edit an application', 'OWNER_ONLY');
  }
  if (!OWNER_ACTION_STATUSES.includes(app.status)) {
    throw BadRequest(
      `An application at status ${app.status} can no longer be edited. Contact the reviewing officer.`,
      'NOT_EDITABLE'
    );
  }

  const body = (await req.json()) as {
    inspectionLocation?: string;
    preferredDate?: string;
    remarks?: string;
    documentIds?: string[];
    /** Response to the most recent open query. */
    queryResponse?: string;
    queryResponseDocumentIds?: string[];
  };

  const changes: Record<string, unknown> = {};

  if (typeof body.inspectionLocation === 'string' && body.inspectionLocation.trim()) {
    app.inspectionLocation = body.inspectionLocation.trim();
    changes.inspectionLocation = app.inspectionLocation;
  }
  if (body.preferredDate !== undefined) {
    const d = body.preferredDate ? new Date(body.preferredDate) : undefined;
    app.preferredDate = d && !Number.isNaN(d.getTime()) ? d : undefined;
    changes.preferredDate = app.preferredDate;
  }
  if (typeof body.remarks === 'string') {
    app.remarks = body.remarks.trim();
    changes.remarks = app.remarks;
  }
  if (Array.isArray(body.documentIds)) {
    app.documentIds = body.documentIds
      .filter((d) => Types.ObjectId.isValid(d))
      .map((d) => new Types.ObjectId(d));
    changes.documentIds = app.documentIds.length;
  }

  if (body.queryResponse?.trim()) {
    const open = [...(app.queries ?? [])].reverse().find((q) => !q.resolvedAt);
    if (!open) throw BadRequest('There is no open query to respond to', 'NO_OPEN_QUERY');

    open.response = body.queryResponse.trim();
    open.responseDocumentIds = (body.queryResponseDocumentIds ?? [])
      .filter((d) => Types.ObjectId.isValid(d))
      .map((d) => new Types.ObjectId(d));
    open.resolvedAt = new Date();
    app.markModified('queries');
    changes.queryResponse = open.response;
  }

  if (Object.keys(changes).length === 0) {
    throw BadRequest('Nothing to update', 'NO_CHANGES');
  }

  await app.save();

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    'application.update',
    { type: 'Application', id: app._id, label: app.applicationNo },
    { details: `Updated ${Object.keys(changes).join(', ')}`, changes, headers: req.headers }
  );

  return ok({ application: { id: String(app._id), status: app.status } });
});
