import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import DocumentRecord from '@/models/DocumentRecord';
import Application from '@/models/Application';
import Instrument from '@/models/Instrument';
import EnforcementCase from '@/models/EnforcementCase';
import User from '@/models/User';
import {
  handle,
  ok,
  requireAuth,
  BadRequest,
  NotFound,
  isOfficial,
  hasGlobalScope,
  canAccessRecord,
} from '@/lib/rbac';
import { storeFile, documentUrl, isCloudinaryConfigured } from '@/lib/uploads';
import { auditAction } from '@/lib/audit';
import { isValidLatLng } from '@/lib/geo';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, type DocumentType } from '@/lib/constants';

/**
 * Uploading and listing documents and inspection evidence.
 *
 * Nothing in the codebase could accept a file before this route existed. The
 * inspection route requires a minimum number of evidence photographs and tells
 * the caller to "upload them to /api/documents first"; the application form asks
 * for ownership proof and invoices. Both had nowhere to send bytes, and the old
 * field app worked around it by base64-encoding photos into the application
 * document itself — which breaks MongoDB's 16 MB limit and leaves evidence with
 * no integrity hash.
 *
 * Every upload is attributed, hashed (SHA-256 of the bytes) and versioned by
 * `storeFile`, so a photograph produced in a dispute can be shown to be the one
 * that was taken.
 */

/**
 * Who may attach a file to an enforcement case, and read it back afterwards.
 *
 * An officer whose jurisdiction covers the case, and the business the case is
 * against. The second one matters: a case can end in a penalty, and a business
 * that cannot put its own documents on the record has been given a notice it
 * cannot answer.
 */
async function canReachEnforcementCase(
  user: Awaited<ReturnType<typeof requireAuth>>,
  caseId: Types.ObjectId | string
): Promise<boolean> {
  const found = await EnforcementCase.findById(caseId).select('ownerId assignedTo jurisdiction');
  if (!found) return false;

  if (String(found.ownerId ?? '') === user.id) return true;
  if (!isOfficial(user.role)) return false;
  if (hasGlobalScope(user.role)) return true;

  if (user.state && found.jurisdiction?.state !== user.state) return false;
  if (
    user.role === 'LMO' &&
    user.district &&
    found.jurisdiction?.district !== user.district &&
    String(found.assignedTo ?? '') !== user.id
  ) {
    return false;
  }
  return true;
}

/** A document is reachable if you can reach the thing it is attached to. */
async function canReach(
  user: Awaited<ReturnType<typeof requireAuth>>,
  doc: {
    uploadedBy: Types.ObjectId;
    applicationId?: Types.ObjectId;
    instrumentId?: Types.ObjectId;
    enforcementCaseId?: Types.ObjectId;
  }
): Promise<boolean> {
  if (String(doc.uploadedBy) === user.id) return true;

  if (doc.enforcementCaseId && (await canReachEnforcementCase(user, doc.enforcementCaseId))) {
    return true;
  }

  if (doc.applicationId) {
    const app = await Application.findById(doc.applicationId).select(
      'ownerId assignedTo jurisdiction'
    );
    if (
      app &&
      canAccessRecord(user, {
        ownerId: app.ownerId,
        assignedTo: app.assignedTo,
        state: app.jurisdiction?.state,
        district: app.jurisdiction?.district,
      })
    ) {
      return true;
    }
  }

  if (doc.instrumentId) {
    const inst = await Instrument.findById(doc.instrumentId).select(
      'ownerId installationState installationDistrict'
    );
    if (
      inst &&
      canAccessRecord(user, {
        ownerId: inst.ownerId,
        state: inst.installationState,
        district: inst.installationDistrict,
      })
    ) {
      return true;
    }
  }

  return false;
}

export const POST = handle(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireAuth();

  const form = await req.formData().catch(() => null);
  if (!form) {
    throw BadRequest(
      'Send the file as multipart/form-data with a "file" field',
      'EXPECTED_MULTIPART'
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    throw BadRequest('No file was attached to the request', 'FILE_REQUIRED');
  }

  const rawType = String(form.get('documentType') ?? 'OTHER').toUpperCase();
  const documentType = ((DOCUMENT_TYPES as readonly string[]).includes(rawType)
    ? rawType
    : 'OTHER') as DocumentType;

  const applicationId = String(form.get('applicationId') ?? '').trim();
  const instrumentId = String(form.get('instrumentId') ?? '').trim();
  const inspectionId = String(form.get('inspectionId') ?? '').trim();
  const enforcementCaseId = String(form.get('enforcementCaseId') ?? '').trim();
  const supersedesId = String(form.get('supersedesId') ?? '').trim();

  // A document must attach to something, or it is an orphan nobody will ever find.
  if (!applicationId && !instrumentId && !inspectionId && !enforcementCaseId) {
    throw BadRequest(
      'Say what this document belongs to: an application, an instrument, an inspection or an enforcement case',
      'ATTACHMENT_REQUIRED'
    );
  }

  /*
   * Uploading against a record you cannot reach would let anyone attach files to
   * anyone's application — checked before a single byte is stored.
   */
  if (applicationId) {
    if (!Types.ObjectId.isValid(applicationId)) throw NotFound('No such application');
    const app = await Application.findById(applicationId).select(
      'ownerId assignedTo jurisdiction status'
    );
    if (
      !app ||
      !canAccessRecord(user, {
        ownerId: app.ownerId,
        assignedTo: app.assignedTo,
        state: app.jurisdiction?.state,
        district: app.jurisdiction?.district,
      })
    ) {
      throw NotFound('No such application');
    }
  }

  if (instrumentId) {
    if (!Types.ObjectId.isValid(instrumentId)) throw NotFound('No such instrument');
    const inst = await Instrument.findById(instrumentId).select(
      'ownerId installationState installationDistrict'
    );
    if (
      !inst ||
      !canAccessRecord(user, {
        ownerId: inst.ownerId,
        state: inst.installationState,
        district: inst.installationDistrict,
      })
    ) {
      throw NotFound('No such instrument');
    }
  }

  if (enforcementCaseId) {
    if (!Types.ObjectId.isValid(enforcementCaseId)) throw NotFound('No such enforcement case');
    if (!(await canReachEnforcementCase(user, enforcementCaseId))) {
      throw NotFound('No such enforcement case');
    }
  }

  // Field evidence carries where and when it was taken; the inspection route
  // compares it against the instrument's registered position.
  let gps: { lat: number; lng: number; accuracyMetres?: number } | undefined;
  const lat = Number(form.get('lat'));
  const lng = Number(form.get('lng'));
  if (Number.isFinite(lat) && Number.isFinite(lng) && isValidLatLng({ lat, lng })) {
    const accuracy = Number(form.get('accuracyMetres'));
    gps = { lat, lng, accuracyMetres: Number.isFinite(accuracy) ? accuracy : undefined };
  }

  const capturedRaw = String(form.get('capturedAt') ?? '').trim();
  const capturedAt = capturedRaw && !Number.isNaN(Date.parse(capturedRaw)) ? new Date(capturedRaw) : undefined;

  const owner = await User.findById(user.id).select('organizationId').lean<{
    organizationId?: Types.ObjectId;
  }>();

  const doc = await storeFile({
    file,
    documentType,
    uploadedBy: user.id,
    organizationId: owner?.organizationId ? String(owner.organizationId) : undefined,
    applicationId: applicationId || undefined,
    instrumentId: instrumentId || undefined,
    inspectionId: inspectionId || undefined,
    enforcementCaseId: enforcementCaseId || undefined,
    capturedAt,
    gps,
    supersedesId: supersedesId && Types.ObjectId.isValid(supersedesId) ? supersedesId : undefined,
  });

  // Linked from the application so the officer's checklist can find it without a
  // separate query.
  if (applicationId) {
    await Application.updateOne(
      { _id: applicationId },
      { $addToSet: { documentIds: doc._id } }
    );
  }
  if (instrumentId && documentType === 'OTHER') {
    await Instrument.updateOne({ _id: instrumentId }, { $addToSet: { photoIds: doc._id } });
  }

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    'document.upload',
    { type: 'DocumentRecord', id: doc._id, label: doc.fileName },
    {
      details: `${DOCUMENT_TYPE_LABELS[documentType]}, ${(doc.sizeBytes / 1024).toFixed(0)} KB, sha256 ${doc.sha256.slice(0, 12)}…`,
      headers: req.headers,
    }
  );

  return ok(
    {
      document: {
        id: String(doc._id),
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        documentType: doc.documentType,
        typeLabel: DOCUMENT_TYPE_LABELS[documentType],
        sha256: doc.sha256,
        version: doc.version,
        href: documentUrl(doc),
        storage: doc.storage,
        capturedAt: doc.capturedAt,
        gps: doc.gps,
      },
      // Worth surfacing: inline storage is a development fallback, not a place to
      // keep a state's evidence.
      storageWarning: isCloudinaryConfigured()
        ? undefined
        : 'Object storage is not configured, so this file is held in the database. Configure Cloudinary before real use.',
    },
    201
  );
});

/** Documents attached to one application, instrument, inspection or enforcement case. */
export const GET = handle(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireAuth();
  const sp = req.nextUrl.searchParams;

  const applicationId = sp.get('applicationId');
  const instrumentId = sp.get('instrumentId');
  const inspectionId = sp.get('inspectionId');
  const enforcementCaseId = sp.get('enforcementCaseId');

  const query: Record<string, unknown> = {};
  if (applicationId && Types.ObjectId.isValid(applicationId)) query.applicationId = applicationId;
  else if (instrumentId && Types.ObjectId.isValid(instrumentId)) query.instrumentId = instrumentId;
  else if (inspectionId && Types.ObjectId.isValid(inspectionId)) query.inspectionId = inspectionId;
  else if (enforcementCaseId && Types.ObjectId.isValid(enforcementCaseId)) {
    query.enforcementCaseId = enforcementCaseId;
  } else {
    throw BadRequest(
      'Name the application, instrument, inspection or enforcement case whose documents you want',
      'FILTER_REQUIRED'
    );
  }

  if (sp.get('includeSuperseded') !== 'true') query.isSuperseded = { $ne: true };

  const documents = await DocumentRecord.find(query)
    .select('-data')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  if (documents.length === 0) return ok({ documents: [], total: 0 });

  // One reachability check for the parent record covers the whole set, since they
  // all hang off the same thing.
  if (!(await canReach(user, documents[0]))) {
    throw NotFound('No documents found');
  }

  return ok({
    documents: documents.map((d) => ({
      id: String(d._id),
      fileName: d.fileName,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      documentType: d.documentType,
      typeLabel: DOCUMENT_TYPE_LABELS[d.documentType as DocumentType] ?? d.documentType,
      sha256: d.sha256,
      version: d.version,
      isSuperseded: d.isSuperseded,
      href: documentUrl(d),
      capturedAt: d.capturedAt,
      gps: d.gps,
      uploadedAt: d.createdAt,
      // The review verdict is the officer's, so only officers see the note.
      reviewStatus: d.reviewStatus,
      reviewNote: isOfficial(user.role) ? d.reviewNote : undefined,
    })),
    total: documents.length,
  });
});
