import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Instrument from '@/models/Instrument';
import InstrumentEvent from '@/models/InstrumentEvent';
// Imported for its side effect of registering the model, so `populate()` of
// `currentCertificateId` works in a cold process that has not touched it yet.
import '@/models/Certificate';
import User from '@/models/User';
import {
  handle,
  ok,
  requireAuth,
  scopeFilter,
  BadRequest,
  Conflict,
  isOfficial,
} from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { persistFlag } from '@/lib/risk';
import { isValidLatLng, isPlausibleIndianCoordinate } from '@/lib/geo';
import {
  INSTRUMENT_TYPES,
  INSTRUMENT_STATUSES,
  INDIAN_STATES,
  type InstrumentStatus,
} from '@/lib/constants';

/**
 * Instruments — the register that everything else hangs off.
 *
 * What this replaces:
 *  - GET had the same `if (role === 'Owner')` scoping hole as the other lists:
 *    "Admin and LMO can see all" with no jurisdiction clause, and an
 *    unrecognised role falling through to `{}`.
 *  - POST validated nothing beyond presence. `type` and `installationState` were
 *    free text against schemas that now carry enums, GPS coordinates were stored
 *    unchecked, and the duplicate check was `findOne({ serialNo })` — a *global*
 *    uniqueness rule that rejected a legitimate registration whenever two
 *    manufacturers reused a serial number.
 *  - DELETE hard-deleted the row. An instrument is the subject of a legal
 *    history: certificates, inspections and enforcement records all point at it.
 *    Deletion is now decommissioning, in `PATCH /api/instruments/[id]`.
 */

export const GET = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const sp = req.nextUrl.searchParams;

  const scope = scopeFilter(user, {
    ownerField: 'ownerId',
    stateField: 'installationState',
    districtField: 'installationDistrict',
  });

  const query: Record<string, unknown> = { ...scope };

  const statusParam = sp.get('status');
  if (statusParam && statusParam !== 'all') {
    const wanted = statusParam
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is InstrumentStatus => (INSTRUMENT_STATUSES as readonly string[]).includes(s));
    if (wanted.length > 0) query.status = { $in: wanted };
  }

  const type = sp.get('type');
  if (type && type !== 'all') query.type = type;

  if (sp.get('includeDecommissioned') !== 'true') query.isDecommissioned = { $ne: true };

  // `dueWithin=<days>` powers the renewal reminder lists.
  const dueWithin = Number(sp.get('dueWithin'));
  if (Number.isFinite(dueWithin) && dueWithin > 0) {
    query.nextVerificationDue = { $lte: new Date(Date.now() + dueWithin * 86_400_000) };
  }

  const search = sp.get('search')?.trim();
  if (search) {
    const rx = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { serialNo: { $regex: rx, $options: 'i' } },
      { serialNoNormalized: { $regex: rx.replace(/[\s-]/g, '').toUpperCase(), $options: 'i' } },
      { brand: { $regex: rx, $options: 'i' } },
      { model: { $regex: rx, $options: 'i' } },
    ];
  }

  const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 50));
  const page = Math.max(1, Number(sp.get('page')) || 1);

  const [instruments, total] = await Promise.all([
    Instrument.find(query)
      .populate('currentCertificateId', 'certNo issuedDate expiryDate status')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Instrument.countDocuments(query),
  ]);

  if (isOfficial(user.role)) {
    await Instrument.populate(instruments, {
      path: 'ownerId',
      select: 'name organizationName phone',
    });
  }

  const rows = instruments.map((i) => ({
    ...i,
    daysToDue: i.nextVerificationDue
      ? Math.ceil((new Date(i.nextVerificationDue).getTime() - Date.now()) / 86_400_000)
      : null,
  }));

  const counts = await Instrument.aggregate<{ _id: string; count: number }>([
    { $match: { ...scope, isDecommissioned: { $ne: true } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  return ok({
    instruments: rows,
    total,
    page,
    limit,
    countsByStatus: Object.fromEntries(counts.map((c) => [c._id, c.count])),
  });
});

export const POST = handle(async (req: NextRequest) => {
  const user = await requireAuth();

  if (user.role !== 'Owner') {
    throw BadRequest(
      'Only a business owner account can register an instrument. An officer registering on a business’s behalf is a separate, audited flow.',
      'OWNER_ONLY'
    );
  }

  const body = (await req.json()) as Record<string, unknown>;

  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');

  const type = str('type');
  const brand = str('brand');
  const model = str('model');
  const serialNo = str('serialNo');
  const capacity = str('capacity');
  const installationState = str('installationState');
  const installationDistrict = str('installationDistrict');
  const address = str('address');

  const missing = Object.entries({
    type,
    brand,
    model,
    serialNo,
    capacity,
    installationState,
    installationDistrict,
    address,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw BadRequest(`Missing required field(s): ${missing.join(', ')}`, 'MISSING_FIELDS');
  }

  // Validated against the same enums the schema carries, so the failure is a
  // clear 400 rather than a Mongoose ValidationError surfaced as a 500.
  if (!(INSTRUMENT_TYPES as readonly string[]).includes(type)) {
    throw BadRequest(`"${type}" is not a recognised instrument category`, 'INVALID_TYPE');
  }
  if (!(INDIAN_STATES as readonly string[]).includes(installationState)) {
    throw BadRequest(`"${installationState}" is not a recognised state or union territory`, 'INVALID_STATE');
  }

  let gpsCoordinates: { lat: number; lng: number } | undefined;
  const rawGps = body.gpsCoordinates as { lat?: unknown; lng?: unknown } | undefined;
  if (rawGps && (rawGps.lat != null || rawGps.lng != null)) {
    const candidate = { lat: Number(rawGps.lat), lng: Number(rawGps.lng) };
    if (!isValidLatLng(candidate)) {
      throw BadRequest('The GPS coordinates are not valid latitude/longitude values', 'INVALID_GPS');
    }
    if (!isPlausibleIndianCoordinate(candidate)) {
      throw BadRequest(
        'Those GPS coordinates fall outside India. Capture the location again at the installation site.',
        'GPS_OUT_OF_BOUNDS'
      );
    }
    gpsCoordinates = candidate;
  }

  const manufactureYear = Number(body.manufactureYear);
  const thisYear = new Date().getFullYear();
  if (body.manufactureYear != null && body.manufactureYear !== '') {
    if (!Number.isInteger(manufactureYear) || manufactureYear < 1900 || manufactureYear > thisYear) {
      throw BadRequest(`Manufacture year must be between 1900 and ${thisYear}`, 'INVALID_YEAR');
    }
  }

  const serialNoNormalized = serialNo.replace(/[\s-]/g, '').toUpperCase();

  // The same physical device may only be registered once. Scoped to brand +
  // model + serial, because a serial number is only unique within a maker's line.
  const duplicate = await Instrument.findOne({ brand, model, serialNoNormalized })
    .select('_id ownerId installationDistrict installationState status')
    .lean();

  if (duplicate) {
    const isMine = String(duplicate.ownerId) === user.id;

    // A second business claiming a registered device is a signal worth recording
    // — it is how a stolen or double-sold instrument shows up.
    if (!isMine) {
      await persistFlag({
        flagType: 'DUPLICATE_SERIAL',
        level: 'HIGH',
        score: 70,
        title: `Duplicate registration attempted for ${brand} ${model} ${serialNo}`,
        reasons: [
          `Instrument ${brand} ${model} (serial ${serialNo}) is already registered to another business.`,
          `A second registration was attempted from ${installationDistrict}, ${installationState}.`,
        ],
        recommendedAction:
          'Confirm which business holds the instrument. If it changed hands, the new owner should file a transfer rather than a fresh registration.',
        evidence: {
          registeredTo: String(duplicate.ownerId),
          registeredIn: `${duplicate.installationDistrict}, ${duplicate.installationState}`,
          attemptedBy: user.id,
          attemptedIn: `${installationDistrict}, ${installationState}`,
        },
        dedupeKey: `dup-registration:${duplicate._id}:${user.id}`,
        instrumentId: duplicate._id,
        ownerId: new Types.ObjectId(user.id),
      }).catch((err) => console.error('[instruments] duplicate flag failed', err));
    }

    throw Conflict(
      isMine
        ? 'You have already registered this instrument.'
        : 'This instrument is already registered to another business. If it has changed hands, file an ownership transfer instead of a new registration — the department will verify the claim.',
      'INSTRUMENT_ALREADY_REGISTERED'
    );
  }

  const owner = await User.findById(user.id).select('name organizationName organizationId').lean<{
    name: string;
    organizationName?: string;
    organizationId?: Types.ObjectId;
  }>();

  const now = new Date();
  const installationDate = parseDate(body.installationDate);

  const instrument = await Instrument.create({
    ownerId: new Types.ObjectId(user.id),
    organizationId: owner?.organizationId,

    type,
    brand,
    model,
    serialNo,
    serialNoNormalized,
    capacity,
    accuracyClass: str('accuracyClass'),
    modelApprovalNo: str('modelApprovalNo') || undefined,
    manufactureYear: Number.isInteger(manufactureYear) ? manufactureYear : undefined,

    installationState,
    installationDistrict,
    address,
    gpsCoordinates,

    photoIds: (Array.isArray(body.photoIds) ? (body.photoIds as string[]) : [])
      .filter((p) => Types.ObjectId.isValid(p))
      .map((p) => new Types.ObjectId(p)),
    photos: Array.isArray(body.photos) ? (body.photos as string[]).slice(0, 10) : [],

    installationDate,
    status: 'REGISTERED',

    // The passport starts here: the first ownership and location entries are the
    // beginning of a history that must never have a gap.
    ownershipHistory: [
      {
        ownerId: new Types.ObjectId(user.id),
        organizationId: owner?.organizationId,
        ownerName: owner?.organizationName || owner?.name || 'Registered owner',
        from: installationDate ?? now,
        note: 'Initial registration',
      },
    ],
    locationHistory: [
      {
        address,
        installationState,
        installationDistrict,
        gpsCoordinates,
        from: installationDate ?? now,
        note: 'Initial installation',
      },
    ],
  });

  await Promise.all([
    InstrumentEvent.create({
      instrumentId: instrument._id,
      eventType: 'REGISTERED',
      title: `${type} registered`,
      description: `${brand} ${model}, serial ${serialNo}, ${capacity} — installed at ${address}, ${installationDistrict}.`,
      actorId: new Types.ObjectId(user.id),
      actorRole: user.role,
      occurredAt: now,
    }),
    auditAction(
      { id: user.id, role: user.role, email: user.email },
      'instrument.create',
      { type: 'Instrument', id: instrument._id, label: `${brand} ${model} ${serialNo}` },
      { details: `${type} in ${installationDistrict}, ${installationState}`, headers: req.headers }
    ),
  ]);

  return ok({ instrument: instrument.toObject() }, 201);
});

/**
 * Legacy delete-by-query-string, kept only to answer honestly.
 *
 * The old handler hard-deleted the instrument row. Certificates, inspections,
 * schedules and enforcement records all reference it, so that silently orphaned
 * a legal history. Retiring an instrument is a status change, not a deletion.
 */
export const DELETE = handle(async (req: NextRequest) => {
  await requireAuth();
  const id = req.nextUrl.searchParams.get('id');

  throw BadRequest(
    `An instrument cannot be deleted — its certificates and inspection records are a legal history. Decommission it instead: PATCH /api/instruments/${id ?? '<id>'} with { "decommission": true, "reason": "…" }.`,
    'USE_DECOMMISSION'
  );
});

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
