import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Instrument from '@/models/Instrument';
import InstrumentEvent from '@/models/InstrumentEvent';
import Application from '@/models/Application';
import Certificate from '@/models/Certificate';
import Inspection from '@/models/Inspection';
import DocumentRecord from '@/models/DocumentRecord';
import RiskFlag from '@/models/RiskFlag';
import {
  handle,
  ok,
  requireAuth,
  NotFound,
  BadRequest,
  Conflict,
  isOfficial,
  canAccessRecord,
} from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { documentUrl } from '@/lib/uploads';
import { resolveRule } from '@/lib/rules';
import { effectiveStatus } from '@/lib/certificates';
import { isValidLatLng, isPlausibleIndianCoordinate, formatCoordinate } from '@/lib/geo';
import { INDIAN_STATES, OPEN_APPLICATION_STATUSES } from '@/lib/constants';

/**
 * The instrument's **digital passport** (spec §9).
 *
 * The spec's central architectural claim is that the instrument, not the
 * certificate, is the record of truth — one continuous history across owners,
 * locations, inspections, certificates and enforcement. Nothing in the previous
 * codebase surfaced that: there was no detail endpoint and no timeline, so an
 * instrument was only ever a row in a list.
 */

export const GET = handle(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const user = await requireAuth();

  if (!Types.ObjectId.isValid(id)) throw NotFound('No such instrument');

  const instrument = await Instrument.findById(id)
    .populate('ownerId', 'name organizationName phone email')
    .populate('currentCertificateId', 'certNo issuedDate expiryDate status version');

  if (!instrument) throw NotFound('No such instrument');

  // 404 rather than 403 for an out-of-jurisdiction id, so ids stay
  // non-enumerable.
  if (
    !canAccessRecord(user, {
      ownerId: instrument.ownerId?._id ?? instrument.ownerId,
      state: instrument.installationState,
      district: instrument.installationDistrict,
    })
  ) {
    throw NotFound('No such instrument');
  }

  const [timeline, applications, certificates, inspections, photos, riskFlags, rule] =
    await Promise.all([
      InstrumentEvent.find({ instrumentId: instrument._id })
        .sort({ occurredAt: -1 })
        .limit(200)
        .populate('actorId', 'name role designation')
        .lean(),
      Application.find({ instrumentId: instrument._id })
        .select('applicationNo type status submittedDate completedDate feeAmount feeStatus dueDate')
        .sort({ createdAt: -1 })
        .lean(),
      Certificate.find({ instrumentId: instrument._id })
        .select('certNo issuedDate expiryDate status version supersedesId supersededById verificationCount')
        .sort({ issuedDate: -1 })
        .lean(),
      Inspection.find({ instrumentId: instrument._id, isSubmitted: true })
        // `sealDetails.sealNo`, not `sealNo` — projecting the flat name silently
        // returned nothing, so the passport could never show the seal that makes
        // the instrument legal to use (Act 2009 s.24).
        .select(
          'inspectionNo inspectedAt result version isSuperseded sealDetails readings gpsDriftMetres'
        )
        .sort({ inspectedAt: -1 })
        .lean(),
      DocumentRecord.find({ _id: { $in: instrument.photoIds ?? [] } })
        .select('_id fileName mimeType storage url documentType createdAt')
        .lean(),
      // Internal advisory signals stay internal.
      isOfficial(user.role)
        ? RiskFlag.find({
            instrumentId: instrument._id,
            status: { $in: ['OPEN', 'REVIEWING', 'CONFIRMED'] },
          })
            .select('flagType level score title reasons recommendedAction status detectedAt')
            .lean()
        : [],
      resolveRule(instrument.installationState, instrument.type),
    ]);

  const current = certificates.find((c) => String(c._id) === String(instrument.currentCertificateId));

  return ok({
    instrument: {
      ...instrument.toObject(),
      gpsLabel: formatCoordinate(instrument.gpsCoordinates),
      daysToDue: instrument.nextVerificationDue
        ? Math.ceil((new Date(instrument.nextVerificationDue).getTime() - Date.now()) / 86_400_000)
        : null,
    },
    // The passport's headline verdict, derived rather than read, so it cannot sit
    // stale between alert sweeps.
    verification: current
      ? {
          certNo: current.certNo,
          expiryDate: current.expiryDate,
          status: effectiveStatus(current as Parameters<typeof effectiveStatus>[0]),
        }
      : null,
    timeline,
    applications,
    certificates,
    inspections,
    photos: photos.map((p) => ({ ...p, href: documentUrl(p) })),
    // Legacy inline photo URLs from before document storage existed.
    legacyPhotos: instrument.photos ?? [],
    riskFlags,
    applicableRule: {
      name: rule.name,
      matchedScope: rule.matchedScope,
      validityMonths: rule.validityMonths,
      requiredDocuments: rule.requiredDocuments,
      legalReference: rule.legalReference,
      tolerances: rule.tolerances,
    },
  });
});

/**
 * Owner edits, a location change, and decommissioning.
 *
 * Identity fields (`type`, `brand`, `model`, `serialNo`) are deliberately **not**
 * editable: they are what a certificate was issued against and what a QR scan
 * matches. Changing them after the fact would silently invalidate the paper
 * trail. A wrongly-entered instrument is decommissioned and re-registered.
 */
export const PATCH = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const user = await requireAuth();

  if (!Types.ObjectId.isValid(id)) throw NotFound('No such instrument');

  const instrument = await Instrument.findById(id);
  if (!instrument) throw NotFound('No such instrument');

  if (String(instrument.ownerId) !== user.id) {
    throw BadRequest('Only the registered owner can update an instrument', 'OWNER_ONLY');
  }

  const body = (await req.json()) as {
    accuracyClass?: string;
    modelApprovalNo?: string;
    capacity?: string;
    installationDate?: string;
    photoIds?: string[];
    /** A move: all three parts are required together. */
    address?: string;
    installationState?: string;
    installationDistrict?: string;
    gpsCoordinates?: { lat?: unknown; lng?: unknown };
    moveNote?: string;
    /** Retirement. */
    decommission?: boolean;
    reason?: string;
  };

  /* --- Decommissioning ---------------------------------------------------- */
  if (body.decommission === true) {
    if (instrument.isDecommissioned) {
      throw Conflict('This instrument is already decommissioned', 'ALREADY_DECOMMISSIONED');
    }

    const reason = body.reason?.trim();
    if (!reason || reason.length < 5) {
      throw BadRequest(
        'Give a reason for decommissioning — it becomes part of the instrument’s permanent record',
        'REASON_REQUIRED'
      );
    }

    const openApplication = await Application.findOne({
      instrumentId: instrument._id,
      status: {
        $in: [...OPEN_APPLICATION_STATUSES],
      },
    }).select('applicationNo status');

    if (openApplication) {
      throw Conflict(
        `Application ${openApplication.applicationNo} is still open (${openApplication.status}). Withdraw it before decommissioning the instrument.`,
        'OPEN_APPLICATION'
      );
    }

    instrument.isDecommissioned = true;
    instrument.decommissionedAt = new Date();
    instrument.decommissionReason = reason;
    instrument.status = 'DECOMMISSIONED';
    // Close the open ownership and location entries so the history has no
    // dangling "still here" record.
    const now = new Date();
    const lastOwner = instrument.ownershipHistory?.at(-1);
    if (lastOwner && !lastOwner.to) lastOwner.to = now;
    const lastLocation = instrument.locationHistory?.at(-1);
    if (lastLocation && !lastLocation.to) lastLocation.to = now;
    instrument.markModified('ownershipHistory');
    instrument.markModified('locationHistory');

    await instrument.save();

    // Any live certificate for a retired instrument is no longer meaningful, so
    // the public verify page must not keep reporting it as valid for trade.
    await Certificate.updateMany(
      { instrumentId: instrument._id, status: { $in: ['ACTIVE', 'EXPIRING_SOON'] } },
      { status: 'SUPERSEDED' }
    );

    await Promise.all([
      InstrumentEvent.create({
        instrumentId: instrument._id,
        eventType: 'DECOMMISSIONED',
        title: 'Instrument decommissioned',
        description: reason,
        actorId: new Types.ObjectId(user.id),
        actorRole: user.role,
      }),
      auditAction(
        { id: user.id, role: user.role, email: user.email },
        'instrument.decommission',
        { type: 'Instrument', id: instrument._id, label: `${instrument.brand} ${instrument.model} ${instrument.serialNo}` },
        { details: reason, headers: req.headers }
      ),
    ]);

    return ok({ instrument: { id: String(instrument._id), status: instrument.status } });
  }

  if (instrument.isDecommissioned) {
    throw BadRequest('A decommissioned instrument cannot be edited', 'DECOMMISSIONED');
  }

  const changes: Record<string, unknown> = {};

  if (typeof body.accuracyClass === 'string') {
    instrument.accuracyClass = body.accuracyClass.trim();
    changes.accuracyClass = instrument.accuracyClass;
  }
  if (typeof body.modelApprovalNo === 'string') {
    instrument.modelApprovalNo = body.modelApprovalNo.trim() || undefined;
    changes.modelApprovalNo = instrument.modelApprovalNo;
  }
  if (typeof body.capacity === 'string' && body.capacity.trim()) {
    // Capacity determines the tolerance band, so a change is recorded rather
    // than applied quietly.
    changes.capacity = { from: instrument.capacity, to: body.capacity.trim() };
    instrument.capacity = body.capacity.trim();
  }
  if (body.installationDate !== undefined) {
    const d = body.installationDate ? new Date(body.installationDate) : undefined;
    instrument.installationDate = d && !Number.isNaN(d.getTime()) ? d : undefined;
    changes.installationDate = instrument.installationDate;
  }
  if (Array.isArray(body.photoIds)) {
    instrument.photoIds = body.photoIds
      .filter((p) => Types.ObjectId.isValid(p))
      .map((p) => new Types.ObjectId(p));
    changes.photoIds = instrument.photoIds.length;
  }

  /* --- A move: recorded as a location-history entry, not an overwrite ----- */
  const movingParts = [body.address, body.installationState, body.installationDistrict].filter(
    (v) => typeof v === 'string' && v.trim()
  );

  if (movingParts.length > 0) {
    if (movingParts.length < 3) {
      throw BadRequest(
        'A location change needs the address, state and district together — a partial move cannot be recorded',
        'INCOMPLETE_LOCATION'
      );
    }
    const state = body.installationState!.trim();
    const district = body.installationDistrict!.trim();
    const address = body.address!.trim();

    if (!(INDIAN_STATES as readonly string[]).includes(state)) {
      throw BadRequest(`"${state}" is not a recognised state or union territory`, 'INVALID_STATE');
    }

    let gps: { lat: number; lng: number } | undefined;
    if (body.gpsCoordinates && (body.gpsCoordinates.lat != null || body.gpsCoordinates.lng != null)) {
      const candidate = { lat: Number(body.gpsCoordinates.lat), lng: Number(body.gpsCoordinates.lng) };
      if (!isValidLatLng(candidate) || !isPlausibleIndianCoordinate(candidate)) {
        throw BadRequest('The GPS coordinates for the new location are not valid', 'INVALID_GPS');
      }
      gps = candidate;
    }

    const now = new Date();
    const previous = instrument.locationHistory?.at(-1);
    if (previous && !previous.to) previous.to = now;

    instrument.locationHistory = [
      ...(instrument.locationHistory ?? []),
      {
        address,
        installationState: state,
        installationDistrict: district,
        gpsCoordinates: gps,
        from: now,
        note: body.moveNote?.trim(),
      },
    ];
    instrument.markModified('locationHistory');

    const jurisdictionChanged =
      state !== instrument.installationState || district !== instrument.installationDistrict;

    instrument.address = address;
    instrument.installationState = state;
    instrument.installationDistrict = district;
    instrument.gpsCoordinates = gps;

    changes.location = { address, state, district, jurisdictionChanged };

    await InstrumentEvent.create({
      instrumentId: instrument._id,
      eventType: 'LOCATION_CHANGED',
      title: jurisdictionChanged
        ? `Moved to ${district}, ${state}`
        : 'Installation address updated',
      description: body.moveNote?.trim() || `Now installed at ${address}.`,
      actorId: new Types.ObjectId(user.id),
      actorRole: user.role,
      changes: {
        from: previous
          ? `${previous.address}, ${previous.installationDistrict}`
          : undefined,
        to: `${address}, ${district}`,
      },
    });
  }

  if (Object.keys(changes).length === 0) {
    throw BadRequest('Nothing to update', 'NO_CHANGES');
  }

  await instrument.save();

  await Promise.all([
    InstrumentEvent.create({
      instrumentId: instrument._id,
      eventType: 'UPDATED',
      title: 'Registration details updated',
      description: `Changed: ${Object.keys(changes).join(', ')}.`,
      actorId: new Types.ObjectId(user.id),
      actorRole: user.role,
      changes,
    }),
    auditAction(
      { id: user.id, role: user.role, email: user.email },
      'instrument.update',
      { type: 'Instrument', id: instrument._id, label: `${instrument.brand} ${instrument.model} ${instrument.serialNo}` },
      { details: `Updated ${Object.keys(changes).join(', ')}`, changes, headers: req.headers }
    ),
  ]);

  return ok({ instrument: instrument.toObject() });
});
