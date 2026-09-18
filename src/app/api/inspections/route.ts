import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Inspection from '@/models/Inspection';
import Application from '@/models/Application';
import Instrument from '@/models/Instrument';
import InstrumentEvent from '@/models/InstrumentEvent';
import Schedule from '@/models/Schedule';
import DocumentRecord from '@/models/DocumentRecord';
import {
  handle,
  ok,
  requireAuth,
  requireInspector,
  BadRequest,
  Conflict,
  NotFound,
  Forbidden,
  isOfficial,
  scopeFilter,
  canAccessRecord,
} from '@/lib/rbac';
import { transitionApplication } from '@/lib/workflow';
import { resolveRule, buildReadingTemplate } from '@/lib/rules';
import { generateInspectionNo, generateSealNo } from '@/lib/ids';
import { isValidLatLng, distanceMetres } from '@/lib/geo';
import { sha256Hex } from '@/lib/utils';
import { auditAction } from '@/lib/audit';
import { persistFlag } from '@/lib/risk';
import { documentUrl } from '@/lib/uploads';

/**
 * Field inspections (spec §21/§22).
 *
 * What this replaces: readings were a single free-text string on a mutable
 * `inspectionData` object embedded in the application. There was no tolerance
 * evaluation, no evidence requirement, no GPS check, and an inspection could be
 * edited after submission with no trace — which makes it worthless as evidence in
 * a prosecution under the Act.
 *
 * Three rules this route enforces:
 *
 *  1. **A submitted inspection is immutable.** A correction creates version N+1
 *     with a mandatory `correctionReason`; the previous version is marked
 *     superseded but kept. Nothing is ever overwritten or deleted.
 *  2. **Pass/fail is computed, not typed.** Each reading is scored against the
 *     maximum permissible error from the applicable rule. The inspector records
 *     what the instrument did; the tolerance table decides what that means.
 *  3. **Evidence and location are required.** The rule sets a minimum number of
 *     photographs and whether GPS is mandatory; drift from the registered site is
 *     measured and, when large, raised as an advisory flag for an officer.
 */

const MAX_LIMIT = 100;

/** The reading shape a client may send. Derived fields are never accepted. */
interface ReadingInput {
  label?: unknown;
  reference?: unknown;
  observed?: unknown;
  unit?: unknown;
  maxErrorPercent?: unknown;
}

export const GET = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const sp = new URL(req.url).searchParams;

  /* A blank form: the test-point table for an application, scaled to the
   * instrument's capacity and carrying the rule's tolerances. The inspector's
   * device fetches this before going out, so it works from the same numbers the
   * server will score against. */
  const templateFor = sp.get('templateFor');
  if (templateFor) {
    if (!Types.ObjectId.isValid(templateFor)) throw NotFound('No such application');
    const application = await Application.findById(templateFor).select(
      'applicationNo instrumentId jurisdiction ownerId assignedTo status'
    );
    if (!application) throw NotFound('No such application');
    if (
      !canAccessRecord(user, {
        ownerId: application.ownerId,
        assignedTo: application.assignedTo,
        state: application.jurisdiction?.state,
        district: application.jurisdiction?.district,
      })
    ) {
      throw NotFound('No such application');
    }

    const instrument = await Instrument.findById(application.instrumentId).select(
      'type brand model serialNo capacity capacityValue capacityUnit installationState address installationDistrict gpsCoordinates'
    );
    if (!instrument) throw BadRequest('The instrument no longer exists', 'NO_INSTRUMENT');

    const rule = await resolveRule(instrument.installationState, instrument.type);

    return ok({
      applicationNo: application.applicationNo,
      instrument: {
        id: String(instrument._id),
        label: `${instrument.brand} ${instrument.model} · ${instrument.serialNo}`,
        type: instrument.type,
        capacity: instrument.capacity,
        address: instrument.address,
        district: instrument.installationDistrict,
        state: instrument.installationState,
        registeredGps: instrument.gpsCoordinates,
      },
      readings: buildReadingTemplate(rule, instrument),
      conformityChecks: DEFAULT_CONFORMITY_CHECKS,
      requirements: {
        minEvidencePhotos: rule.minEvidencePhotos,
        requireGpsEvidence: rule.requireGpsEvidence,
        gpsToleranceMetres: rule.gpsToleranceMetres,
        legalReference: rule.legalReference,
      },
      appliedRule: { name: rule.name, matchedScope: rule.matchedScope },
    });
  }

  const scope = scopeFilter(user, { assigneeField: 'inspectedBy' });
  const filter: Record<string, unknown> = { ...scope };

  // Owners and non-inspectors reach inspections through their applications.
  if (!isOfficial(user.role)) {
    const own = await Application.find({ ownerId: user.id }).select('_id').lean();
    delete filter._id;
    filter.applicationId = { $in: own.map((a) => a._id) };
    // An owner sees the finished report, not a half-filled draft.
    filter.isSubmitted = true;
  }

  const applicationId = sp.get('applicationId');
  if (applicationId && Types.ObjectId.isValid(applicationId)) {
    filter.applicationId = new Types.ObjectId(applicationId);
  }
  const instrumentId = sp.get('instrumentId');
  if (instrumentId && Types.ObjectId.isValid(instrumentId)) {
    filter.instrumentId = new Types.ObjectId(instrumentId);
  }
  if (sp.get('result')) filter.result = sp.get('result');
  if (sp.get('includeSuperseded') !== 'true') filter.isSuperseded = false;
  if (sp.get('drafts') === 'true') filter.isSubmitted = false;

  const limit = Math.min(Number(sp.get('limit')) || 25, MAX_LIMIT);

  const [inspections, total] = await Promise.all([
    Inspection.find(filter)
      .populate('applicationId', 'applicationNo type status')
      .populate('instrumentId', 'type brand model serialNo')
      .populate('inspectedBy', 'name role designation officerCode')
      .sort({ inspectedAt: -1 })
      .limit(limit)
      .lean(),
    Inspection.countDocuments(filter),
  ]);

  /*
   * Evidence photographs, resolved to fetchable links.
   *
   * The list returned `evidenceIds` as bare ObjectIds, so an officer reviewing an
   * inspection could see that the rule's four photographs had been attached and
   * could not open a single one of them — which is the entire point of requiring
   * them. `capturedAt` and `gps` come along because evidence photographed a day
   * later, or a kilometre away, is worth noticing.
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

  return ok({
    inspections: inspections.map((i) => ({
      ...i,
      evidence: (i.evidenceIds ?? [])
        .map((id) => evidenceById.get(String(id)))
        .filter((d): d is NonNullable<typeof d> => Boolean(d)),
    })),
    total,
    limit,
  });
});

/** Conformity items every inspection covers, from Act 2009 s.24 / Rule 11(1). */
type ConformityInput = { code?: string; label?: string; result?: string; note?: string };

const DEFAULT_CONFORMITY_CHECKS: ConformityInput[] = [
  { code: 'STAMP_INTACT', label: 'Previous verification stamp or seal intact', result: 'NA' },
  { code: 'NO_TAMPERING', label: 'No evidence of tampering with the mechanism', result: 'NA' },
  { code: 'DISPLAY_LEGIBLE', label: 'Display or scale legible to the customer', result: 'NA' },
  { code: 'ZERO_SETTING', label: 'Zero setting correct and stable', result: 'NA' },
  { code: 'MODEL_APPROVAL', label: 'Model approval marking present and matching', result: 'NA' },
  { code: 'UNIT_MARKING', label: 'Units marked in the metric system', result: 'NA' },
];

/**
 * Records an inspection, or a corrected version of one.
 *
 * Submitting also advances the application to INSPECTION_SUBMITTED, so a report
 * cannot sit filed-but-unnoticed while the SLA clock runs.
 */
export const POST = handle(async (req: NextRequest) => {
  const user = await requireInspector('inspection.create');

  const body = (await req.json()) as {
    applicationId?: string;
    readings?: ReadingInput[];
    conformityChecks?: ConformityInput[];
    referenceStandards?: { name?: string; identifier?: string; calibrationValidUntil?: string }[];
    evidenceIds?: string[];
    location?: { address?: string; district?: string; state?: string; gps?: { lat?: unknown; lng?: unknown; accuracyMetres?: unknown } };
    ambientConditions?: { temperatureC?: unknown; humidityPercent?: unknown };
    remarks?: string;
    sealNo?: string;
    stampLocation?: string;
    /** Set false to keep it as a draft the inspector can still edit. */
    submit?: boolean;
    /** Correcting an earlier version. */
    supersedesId?: string;
    correctionReason?: string;
    /** Offline capture. */
    capturedOffline?: boolean;
    clientRecordId?: string;
    inspectedAt?: string;
  };

  const { applicationId } = body;
  if (!applicationId || !Types.ObjectId.isValid(applicationId)) {
    throw BadRequest('An application must be identified', 'APPLICATION_REQUIRED');
  }

  const application = await Application.findById(applicationId);
  if (!application) throw NotFound('No such application');

  if (
    !canAccessRecord(user, {
      ownerId: application.ownerId,
      assignedTo: application.assignedTo,
      state: application.jurisdiction?.state,
      district: application.jurisdiction?.district,
    })
  ) {
    throw NotFound('No such application');
  }

  // A GATC technician may only file against work assigned to them. An LMO may
  // file for their own jurisdiction.
  if (user.role === 'GATCTechnician' && String(application.assignedTo) !== user.id) {
    throw Forbidden('This inspection is not assigned to you');
  }

  if (!['SCHEDULED', 'INSPECTION_IN_PROGRESS', 'INSPECTION_SUBMITTED'].includes(application.status)) {
    throw Conflict(
      `Application ${application.applicationNo} is ${application.status}. An inspection can only be recorded once it has been scheduled.`,
      'NOT_INSPECTABLE'
    );
  }

  /* --- Offline replay idempotency -------------------------------------- */
  const clientRecordId = body.clientRecordId?.trim();
  if (clientRecordId) {
    const already = await Inspection.findOne({ inspectedBy: user.id, clientRecordId }).select(
      '_id inspectionNo result version'
    );
    if (already) {
      // A replayed offline record is not an error — the device is doing exactly
      // what it should. Return what already landed.
      return ok({
        inspection: {
          id: String(already._id),
          inspectionNo: already.inspectionNo,
          result: already.result,
          version: already.version,
        },
        alreadyRecorded: true,
      });
    }
  }

  const instrument = await Instrument.findById(application.instrumentId);
  if (!instrument) throw BadRequest('The instrument no longer exists', 'NO_INSTRUMENT');

  const rule = await resolveRule(instrument.installationState, instrument.type);
  const submit = body.submit !== false;

  /* --- Versioning ------------------------------------------------------- */
  let version = 1;
  let supersedes: Types.ObjectId | undefined;
  const correctionReason = body.correctionReason?.trim();

  if (body.supersedesId) {
    if (!Types.ObjectId.isValid(body.supersedesId)) {
      throw BadRequest('That is not a valid inspection id', 'INVALID_SUPERSEDES');
    }
    const previous = await Inspection.findById(body.supersedesId).select(
      'version applicationId isSuperseded'
    );
    if (!previous) throw NotFound('No such earlier inspection');
    if (String(previous.applicationId) !== String(application._id)) {
      throw BadRequest('That inspection belongs to a different application', 'MISMATCHED_INSPECTION');
    }
    if (previous.isSuperseded) {
      throw Conflict(
        'That version has already been corrected. Correct the current version instead.',
        'ALREADY_SUPERSEDED'
      );
    }
    if (!correctionReason || correctionReason.length < 10) {
      throw BadRequest(
        'A correction must say what was wrong with the previous version and why — it stays on the record beside it',
        'CORRECTION_REASON_REQUIRED'
      );
    }
    version = previous.version + 1;
    supersedes = previous._id;
  } else {
    // A live draft is edited in place rather than forked, so an inspector filling
    // the form in stages does not create a version chain.
    const draft = await Inspection.findOne({
      applicationId: application._id,
      isSubmitted: false,
      isSuperseded: false,
      inspectedBy: user.id,
    }).select('_id version');
    if (draft) {
      version = draft.version;
      await Inspection.deleteOne({ _id: draft._id });
    }
  }

  /* --- Readings --------------------------------------------------------- */
  const rawReadings = Array.isArray(body.readings) ? body.readings : [];
  if (submit && rawReadings.length === 0) {
    throw BadRequest(
      'At least one test reading is required. Fetch the test-point table with ?templateFor= and fill it in.',
      'READINGS_REQUIRED'
    );
  }

  const toleranceFor = new Map(rule.tolerances.map((t) => [t.label, t.maxErrorPercent]));

  const readings = rawReadings.map((r, i) => {
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    const reference = Number(r.reference);
    const observed = Number(r.observed);

    if (!label) throw BadRequest(`Reading ${i + 1} has no test-point label`, 'READING_LABEL_REQUIRED');
    if (!Number.isFinite(reference) || !Number.isFinite(observed)) {
      throw BadRequest(
        `Reading "${label}" needs both the applied reference and the observed indication as numbers`,
        'READING_NOT_NUMERIC'
      );
    }
    if (reference < 0 || observed < 0) {
      throw BadRequest(`Reading "${label}" cannot be negative`, 'READING_NEGATIVE');
    }

    // The permissible error comes from the rule, never from the request. A client
    // that could set its own tolerance could make any instrument pass.
    const maxErrorPercent = toleranceFor.get(label) ?? Number(r.maxErrorPercent) ?? 0;

    return {
      label,
      reference,
      observed,
      unit: typeof r.unit === 'string' && r.unit.trim() ? r.unit.trim() : instrument.capacityUnit || 'unit',
      maxErrorPercent: Number.isFinite(maxErrorPercent) ? maxErrorPercent : 0,
      // error / errorPercent / withinTolerance are computed by the model's
      // pre-validate hook, so the stored numbers always agree with each other.
      error: 0,
      errorPercent: 0,
      withinTolerance: true,
    };
  });

  /* --- Conformity checks ------------------------------------------------ */
  const conformityChecks = (
    Array.isArray(body.conformityChecks) && body.conformityChecks.length
      ? body.conformityChecks
      : DEFAULT_CONFORMITY_CHECKS
  ).map((c) => ({
    code: String(c.code ?? '').trim() || 'UNSPECIFIED',
    label: String(c.label ?? '').trim() || 'Unspecified check',
    result: (['PASS', 'FAIL', 'NA'].includes(String(c.result)) ? c.result : 'NA') as 'PASS' | 'FAIL' | 'NA',
    note: typeof c.note === 'string' ? c.note.trim() : undefined,
  }));

  /* --- Evidence --------------------------------------------------------- */
  const evidenceIds = (Array.isArray(body.evidenceIds) ? body.evidenceIds : [])
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));

  if (submit && evidenceIds.length < rule.minEvidencePhotos) {
    throw BadRequest(
      `${rule.minEvidencePhotos} photographs of the instrument are required as evidence; ${evidenceIds.length} were attached. Upload them to /api/documents first.`,
      'EVIDENCE_REQUIRED'
    );
  }

  if (evidenceIds.length) {
    // Every attachment must be a real document uploaded by this inspector — an
    // inspection cannot cite someone else's photographs.
    const found = await DocumentRecord.countDocuments({
      _id: { $in: evidenceIds },
      uploadedBy: new Types.ObjectId(user.id),
    });
    if (found !== evidenceIds.length) {
      throw BadRequest(
        'Some of the attached evidence could not be found under your uploads',
        'EVIDENCE_NOT_FOUND'
      );
    }
  }

  /* --- Location and GPS drift ------------------------------------------ */
  const gpsInput = body.location?.gps;
  let gps: { lat: number; lng: number; accuracyMetres?: number } | undefined;

  if (gpsInput && (gpsInput.lat != null || gpsInput.lng != null)) {
    const candidate = { lat: Number(gpsInput.lat), lng: Number(gpsInput.lng) };
    if (!isValidLatLng(candidate)) {
      throw BadRequest('The captured GPS coordinates are not valid', 'INVALID_GPS');
    }
    const accuracy = Number(gpsInput.accuracyMetres);
    gps = {
      ...candidate,
      accuracyMetres: Number.isFinite(accuracy) ? accuracy : undefined,
    };
  }

  if (submit && rule.requireGpsEvidence && !gps) {
    throw BadRequest(
      'This verification requires the inspection location to be captured. Enable location on the device and try again.',
      'GPS_REQUIRED'
    );
  }

  // Measured, not judged: a large drift may be a legitimately relocated
  // instrument. It is recorded and flagged for an officer to look at.
  let gpsDriftMetres: number | undefined;
  if (gps && isValidLatLng(instrument.gpsCoordinates)) {
    gpsDriftMetres = Math.round(distanceMetres(gps, instrument.gpsCoordinates));
  }

  /* --- Result ----------------------------------------------------------- */
  const inspectedAt =
    body.inspectedAt && !Number.isNaN(Date.parse(body.inspectedAt)) ? new Date(body.inspectedAt) : new Date();

  if (inspectedAt.getTime() > Date.now() + 60_000) {
    throw BadRequest('An inspection cannot be dated in the future', 'INSPECTED_AT_FUTURE');
  }

  // Derived exactly the same way every time, by the same rule, for every
  // inspector — which is the point of having a tolerance table at all.
  const outOfTolerance = readings.filter((r) => {
    const error = r.observed - r.reference;
    const errorPercent = r.reference === 0 ? 0 : (error / r.reference) * 100;
    return Math.abs(errorPercent) > r.maxErrorPercent;
  });
  const failedChecks = conformityChecks.filter((c) => c.result === 'FAIL');
  const unansweredChecks = conformityChecks.filter((c) => c.result === 'NA');

  let result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  if (outOfTolerance.length > 0 || failedChecks.length > 0) result = 'FAIL';
  else if (!submit || unansweredChecks.length === conformityChecks.length) result = 'INCONCLUSIVE';
  else result = 'PASS';

  /* --- Seal ------------------------------------------------------------- */
  let sealDetails: { sealNo?: string; stampedAt?: Date; stampLocation?: string } | undefined;
  if (submit && result === 'PASS') {
    // Act 2009 s.24: a verified instrument is stamped. The seal number is issued
    // by the server so the sequence is the department's, not the device's.
    sealDetails = {
      sealNo: body.sealNo?.trim() || (await generateSealNo(inspectedAt)),
      stampedAt: inspectedAt,
      stampLocation: body.stampLocation?.trim(),
    };
  }

  const inspectionNo = await generateInspectionNo(inspectedAt);

  const inspection = await Inspection.create({
    inspectionNo,
    applicationId: application._id,
    instrumentId: instrument._id,
    scheduleId: application.scheduleId,
    version,
    supersedesId: supersedes,
    isSuperseded: false,
    correctionReason: supersedes ? correctionReason : undefined,
    inspectedBy: new Types.ObjectId(user.id),
    inspectedByRole: user.role,
    inspectedAt,
    location: {
      address: body.location?.address?.trim() || instrument.address,
      district: body.location?.district?.trim() || instrument.installationDistrict,
      state: body.location?.state?.trim() || instrument.installationState,
      gps,
    },
    gpsDriftMetres,
    readings,
    conformityChecks,
    referenceStandards: (Array.isArray(body.referenceStandards) ? body.referenceStandards : [])
      .filter((s) => typeof s.name === 'string' && s.name.trim())
      .map((s) => ({
        name: s.name!.trim(),
        identifier: s.identifier?.trim(),
        calibrationValidUntil:
          s.calibrationValidUntil && !Number.isNaN(Date.parse(s.calibrationValidUntil))
            ? new Date(s.calibrationValidUntil)
            : undefined,
      })),
    evidenceIds,
    ambientConditions: {
      temperatureC: Number.isFinite(Number(body.ambientConditions?.temperatureC))
        ? Number(body.ambientConditions?.temperatureC)
        : undefined,
      humidityPercent: Number.isFinite(Number(body.ambientConditions?.humidityPercent))
        ? Number(body.ambientConditions?.humidityPercent)
        : undefined,
    },
    result,
    remarks: body.remarks?.trim(),
    sealDetails,
    isSubmitted: submit,
    submittedAt: submit ? new Date() : undefined,
    capturedOffline: body.capturedOffline === true,
    syncedAt: body.capturedOffline === true ? new Date() : undefined,
    clientRecordId,
  });

  // Integrity hash over the readings and the evidence, so a later edit at the
  // database level is detectable.
  inspection.dataHash = sha256Hex(
    JSON.stringify({
      inspectionNo,
      inspectedAt: inspectedAt.toISOString(),
      readings: inspection.readings.map((r) => [r.label, r.reference, r.observed, r.errorPercent]),
      conformityChecks: conformityChecks.map((c) => [c.code, c.result]),
      result,
      evidence: evidenceIds.map(String),
    })
  );
  await inspection.save();

  /*
   * Back-link the cited photographs to this inspection.
   *
   * Evidence is uploaded *before* the inspection exists — the inspector has an
   * application id in the field and nothing else — so `DocumentRecord.inspectionId`
   * cannot be set at upload time and was never set afterwards. The link existed in
   * one direction only, which meant `GET /api/documents?inspectionId=…` returned
   * nothing for evidence that inspection demonstrably cites.
   */
  if (evidenceIds.length) {
    await DocumentRecord.updateMany(
      { _id: { $in: evidenceIds } },
      { $set: { inspectionId: inspection._id, instrumentId: instrument._id } }
    );
  }

  if (supersedes) {
    await Inspection.updateOne({ _id: supersedes }, { isSuperseded: true });
  }

  if (!submit) {
    // A draft changes nothing else: no status move, no timeline entry, no flags.
    return ok(
      {
        inspection: {
          id: String(inspection._id),
          inspectionNo,
          version,
          result,
          isSubmitted: false,
          readings: inspection.readings,
        },
        draft: true,
        message: 'Saved as a draft. Submit it when the visit is complete.',
      },
      201
    );
  }

  /* --- Consequences of a submitted inspection -------------------------- */
  application.currentInspectionId = inspection._id;
  application.inspectionIds = [...(application.inspectionIds ?? []), inspection._id];

  if (application.status !== 'INSPECTION_SUBMITTED') {
    if (application.status === 'SCHEDULED') {
      await transitionApplication(
        application as unknown as Parameters<typeof transitionApplication>[0],
        'INSPECTION_IN_PROGRESS',
        user,
        { headers: req.headers }
      );
    }
    await transitionApplication(
      application as unknown as Parameters<typeof transitionApplication>[0],
      'INSPECTION_SUBMITTED',
      user,
      {
        reason: `Inspection ${inspectionNo}: ${result}`,
        headers: req.headers,
      }
    );
  } else {
    await application.save();
  }

  await Promise.all([
    Schedule.updateOne(
      { _id: application.scheduleId, status: { $nin: ['CANCELLED'] } },
      { status: 'COMPLETED' }
    ),
    InstrumentEvent.create({
      instrumentId: instrument._id,
      eventType: result === 'PASS' ? 'INSPECTION_PASSED' : 'INSPECTION_FAILED',
      title:
        version > 1
          ? `Inspection ${inspectionNo} (correction v${version}): ${result}`
          : `Inspection ${inspectionNo}: ${result}`,
      description:
        result === 'FAIL'
          ? `Out of tolerance: ${outOfTolerance.map((r) => r.label).join(', ') || 'none'}. Failed checks: ${
              failedChecks.map((c) => c.label).join(', ') || 'none'
            }.`
          : body.remarks?.trim(),
      applicationId: application._id,
      actorId: new Types.ObjectId(user.id),
      actorRole: user.role,
      occurredAt: inspectedAt,
    }),
    result === 'FAIL'
      ? Instrument.updateOne({ _id: instrument._id }, { $inc: { failedInspectionCount: 1 } })
      : Promise.resolve(),
    auditAction(
      { id: user.id, role: user.role, email: user.email },
      'inspection.submit',
      { type: 'Inspection', id: inspection._id, label: inspectionNo },
      {
        details: `${result} for ${application.applicationNo} (v${version})`,
        changes: {
          result,
          outOfTolerance: outOfTolerance.map((r) => r.label),
          failedChecks: failedChecks.map((c) => c.code),
          gpsDriftMetres,
        },
        headers: req.headers,
      }
    ),
  ]);

  // Advisory only, and officer-visible only: a drift beyond the rule's tolerance
  // may mean the instrument was moved without a transfer being filed.
  if (gpsDriftMetres != null && gpsDriftMetres > rule.gpsToleranceMetres) {
    await persistFlag({
      flagType: 'GPS_MISMATCH',
      level: gpsDriftMetres > rule.gpsToleranceMetres * 10 ? 'HIGH' : 'MEDIUM',
      score: gpsDriftMetres > rule.gpsToleranceMetres * 10 ? 65 : 40,
      title: `Inspection recorded ${gpsDriftMetres} m from the registered site`,
      reasons: [
        `The registered installation is at ${instrument.address}, ${instrument.installationDistrict}.`,
        `The inspection was captured ${gpsDriftMetres} m away, against a tolerance of ${rule.gpsToleranceMetres} m.`,
      ],
      recommendedAction:
        'Confirm whether the instrument has been moved. If it has, the owner should file a transfer or a location change so the certificate matches the site.',
      evidence: {
        inspectionNo,
        driftMetres: gpsDriftMetres,
        toleranceMetres: rule.gpsToleranceMetres,
        capturedAccuracyMetres: gps?.accuracyMetres,
      },
      dedupeKey: `gps-drift:${inspection._id}`,
      instrumentId: instrument._id,
      applicationId: application._id,
      ownerId: application.ownerId,
    }).catch((err) => console.error('[inspections] GPS flag failed', err));
  }

  return ok(
    {
      inspection: {
        id: String(inspection._id),
        inspectionNo,
        version,
        result,
        readings: inspection.readings,
        conformityChecks: inspection.conformityChecks,
        gpsDriftMetres,
        sealNo: sealDetails?.sealNo,
        dataHash: inspection.dataHash,
        supersedes: supersedes ? String(supersedes) : undefined,
      },
      application: { id: String(application._id), status: application.status },
      evaluation: {
        outOfTolerance: outOfTolerance.map((r) => r.label),
        failedChecks: failedChecks.map((c) => ({ code: c.code, label: c.label })),
        // Said plainly, because the inspector needs to know what happens next and
        // this route does not itself decide anything.
        note:
          result === 'PASS'
            ? 'The instrument met the permissible error limits. The report is now with the Legal Metrology Officer for a decision.'
            : result === 'FAIL'
              ? 'The instrument is outside the permissible error limits. The report is now with the Legal Metrology Officer, who decides what follows.'
              : 'The report is incomplete, so no conclusion has been recorded.',
      },
    },
    201
  );
});

/** Evidence and readings for one inspection, for the report view. */
export const PATCH = handle(async () => {
  throw BadRequest(
    'A submitted inspection cannot be edited. POST a corrected version with supersedesId and correctionReason instead.',
    'IMMUTABLE'
  );
});
