import { Types } from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import Complaint, { type IComplaint, type IComplaintEvidence } from '@/models/Complaint';
import { generateComplaintNo } from '@/lib/ids';
import { sha256Hex, clientIpFromHeaders, hashRequesterIp } from '@/lib/utils';
import { isCloudinaryConfigured } from '@/lib/uploads';
import { BadRequest } from '@/lib/rbac';
import { notifyOfficers } from '@/lib/notify';
import { isValidDistrict } from '@/lib/districts';
import {
  ALLOWED_COMPLAINT_MIME_TYPES,
  MAX_COMPLAINT_UPLOAD_BYTES,
  MAX_COMPLAINT_EVIDENCE_FILES,
  COMPLAINT_TYPES,
  COMPLAINT_STATUS_LABELS,
  COMPLAINT_STATUS_PUBLIC_NOTE,
  INDIAN_STATES,
  normalizeComplaintNo,
  type ComplaintStatus,
  type ComplaintType,
} from '@/lib/constants';

/**
 * Public complaint intake.
 *
 * A citizen filing a complaint is the only unauthenticated write in the system,
 * so everything a session would normally establish has to be re-established from
 * the request body — and none of it can be trusted. Every field is validated
 * here rather than in the route, because the same rules have to hold whatever
 * calls this.
 */

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

function evidenceKind(mime: string): IComplaintEvidence['kind'] {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return 'document';
}

function assertAcceptableEvidence(file: File): void {
  if (!file || typeof file.size !== 'number' || file.size === 0) {
    throw BadRequest('One of the attached files is empty');
  }
  if (file.size > MAX_COMPLAINT_UPLOAD_BYTES) {
    throw BadRequest(
      `"${file.name}" is ${(file.size / 1_048_576).toFixed(1)} MB. The limit is ${
        MAX_COMPLAINT_UPLOAD_BYTES / 1_048_576
      } MB per file.`
    );
  }
  if (
    !ALLOWED_COMPLAINT_MIME_TYPES.includes(
      file.type as (typeof ALLOWED_COMPLAINT_MIME_TYPES)[number]
    )
  ) {
    throw BadRequest(
      `"${file.name}" is a ${file.type || 'unknown'} file. Attach photos (JPEG, PNG, WebP), a video (MP4, MOV, WebM) or a PDF.`
    );
  }
}

/**
 * Stores one attachment.
 *
 * Mirrors `storeFile` in `uploads.ts` — same hash, same Cloudinary-or-inline
 * fallback — but writes an embedded subdocument instead of a `DocumentRecord`,
 * which requires an uploader this path does not have.
 */
async function storeEvidence(file: File): Promise<IComplaintEvidence> {
  assertAcceptableEvidence(file);

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = sha256Hex(buffer);
  const kind = evidenceKind(file.type);

  if (isCloudinaryConfigured()) {
    try {
      const uploaded = await new Promise<{ secure_url: string }>((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            {
              folder: 'vtula/complaints',
              // Cloudinary rejects a video sent as `image`, which is how a
              // perfectly valid clip would otherwise fail at the last step.
              resource_type: kind === 'video' ? 'video' : 'auto',
            },
            (err, result) => {
              if (err || !result) reject(err ?? new Error('upload failed'));
              else resolve(result as { secure_url: string });
            }
          )
          .end(buffer);
      });

      return {
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        sha256,
        storage: 'cloudinary',
        url: uploaded.secure_url,
        kind,
        uploadedAt: new Date(),
      };
    } catch (err) {
      // Falls through to inline rather than losing the complaint: the evidence
      // is the reason the person bothered to file it.
      console.error('[complaints] cloudinary upload failed, storing inline', err);
    }
  }

  return {
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    sha256,
    storage: 'inline',
    data: buffer.toString('base64'),
    kind,
    uploadedAt: new Date(),
  };
}

/* ------------------------------------------------------------------ *
 * Filing
 * ------------------------------------------------------------------ */

export interface FileComplaintInput {
  complainant: {
    name: string;
    phone: string;
    email?: string;
    address?: string;
    isAnonymousToTrader?: boolean;
  };
  against: {
    businessName: string;
    ownerName?: string;
    phone?: string;
    address: string;
    state: string;
    district: string;
    pincode?: string;
    landmark?: string;
    instrumentDescription?: string;
    certNo?: string;
  };
  complaintType: string;
  description: string;
  incidentDate?: string;
  gps?: { lat: number; lng: number; accuracyMetres?: number };
  files?: File[];
  headers?: Headers;
}

const PHONE_RE = /^[6-9]\d{9}$/;

/**
 * Anonymous intake ceiling, per source per day.
 *
 * An open write endpoint with file upload needs a floor under it. Matched to the
 * enforcement route's public complaint limit, and counted on the salted IP hash
 * that is stored anyway — no second record of who filed what.
 */
const MAX_COMPLAINTS_PER_SOURCE_PER_DAY = 5;

function cleanPhone(raw: string): string {
  // Accepts the shapes people actually type: +91, 0-prefixed, spaced, hyphenated.
  return raw.replace(/[\s-]/g, '').replace(/^(\+91|0091|91(?=\d{10}$)|0)/, '');
}

export async function fileComplaint(input: FileComplaintInput): Promise<IComplaint> {
  const name = input.complainant?.name?.trim();
  const phone = cleanPhone(input.complainant?.phone ?? '');

  if (!name || name.length < 3) {
    throw BadRequest('Please enter your full name so the officer can contact you.');
  }
  if (!PHONE_RE.test(phone)) {
    throw BadRequest('Please enter a valid 10-digit Indian mobile number.');
  }

  const email = input.complainant.email?.trim().toLowerCase() || undefined;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw BadRequest('That email address does not look valid.');
  }

  const businessName = input.against?.businessName?.trim();
  const address = input.against?.address?.trim();
  const state = input.against?.state?.trim();
  const district = input.against?.district?.trim();

  if (!businessName) throw BadRequest('Please tell us the name of the shop or business.');
  if (!address || address.length < 8) {
    throw BadRequest('Please give the address of the premises, so an officer can find it.');
  }
  if (!state || !INDIAN_STATES.includes(state as (typeof INDIAN_STATES)[number])) {
    throw BadRequest('Please choose the state from the list.');
  }
  /*
   * Checked against the real district list, not merely for non-emptiness. The
   * complaint is routed to officers by an exact match on these two fields — a
   * free-typed district would file the complaint into a jurisdiction whose
   * officers' queues never match it, and nobody would ever see it.
   */
  if (!district || !isValidDistrict(state, district)) {
    throw BadRequest('Please choose the district from the list.');
  }

  if (!COMPLAINT_TYPES.includes(input.complaintType as ComplaintType)) {
    throw BadRequest('Please choose what the complaint is about.');
  }

  const description = input.description?.trim();
  if (!description || description.length < 20) {
    throw BadRequest(
      'Please describe what happened in at least a couple of sentences — an officer has to act on this.'
    );
  }
  if (description.length > 5000) {
    throw BadRequest('Please keep the description under 5000 characters.');
  }

  const files = (input.files ?? []).filter((f) => f && f.size > 0);
  if (files.length > MAX_COMPLAINT_EVIDENCE_FILES) {
    throw BadRequest(`Please attach at most ${MAX_COMPLAINT_EVIDENCE_FILES} files.`);
  }

  const submitterHash = input.headers
    ? hashRequesterIp(clientIpFromHeaders(input.headers))
    : undefined;

  /*
   * Rate limit checked before the files are read, not after. Reading six 25 MB
   * uploads and then refusing the complaint would make the limit itself the
   * cheapest way to exhaust the server.
   */
  if (submitterHash) {
    const since = new Date(Date.now() - 86_400_000);
    const recent = await Complaint.countDocuments({
      submitterHash,
      createdAt: { $gte: since },
    });
    if (recent >= MAX_COMPLAINTS_PER_SOURCE_PER_DAY) {
      throw BadRequest(
        `You have already filed ${recent} complaints today. If you have more to report, please contact the district Legal Metrology office directly.`
      );
    }
  }

  const evidence: IComplaintEvidence[] = [];
  for (const file of files) {
    evidence.push(await storeEvidence(file));
  }

  const complaintNo = await generateComplaintNo();
  const now = new Date();

  const complaint = await Complaint.create({
    complaintNo,
    complainant: {
      name,
      phone,
      email,
      address: input.complainant.address?.trim() || undefined,
      isAnonymousToTrader: Boolean(input.complainant.isAnonymousToTrader),
    },
    against: {
      businessName,
      ownerName: input.against.ownerName?.trim() || undefined,
      phone: input.against.phone ? cleanPhone(input.against.phone) : undefined,
      address,
      state,
      district,
      pincode: input.against.pincode?.trim() || undefined,
      landmark: input.against.landmark?.trim() || undefined,
      instrumentDescription: input.against.instrumentDescription?.trim() || undefined,
      certNo: input.against.certNo?.trim().toUpperCase() || undefined,
    },
    complaintType: input.complaintType,
    description,
    incidentDate: input.incidentDate ? new Date(input.incidentDate) : undefined,
    gps: input.gps,
    evidence,
    status: 'SUBMITTED',
    // A tampered seal or a forged certificate is an offence in progress, not a
    // measurement dispute, so it does not wait its turn in the queue.
    priority:
      input.complaintType === 'TAMPERED_SEAL' || input.complaintType === 'EXPIRED_CERTIFICATE'
        ? 'HIGH'
        : 'NORMAL',
    statusHistory: [
      {
        to: 'SUBMITTED',
        publicNote: COMPLAINT_STATUS_PUBLIC_NOTE.SUBMITTED,
        actorRole: 'PUBLIC',
        at: now,
      },
    ],
    submitterHash,
  });

  // Officers in the district hear about it immediately; without this the
  // complaint sits in a list nobody has a reason to open.
  await notifyOfficers(
    { state, district },
    ['LMO', 'StateAdmin', 'Admin'],
    {
      type: 'warning',
      title: `New public complaint ${complaintNo}`,
      message: `${businessName}, ${district}: ${description.slice(0, 140)}${
        description.length > 140 ? '…' : ''
      }`,
      actionUrl: `/dashboard/complaints/${String(complaint._id)}`,
      actionLabel: 'Open complaint',
      /*
       * `notifyOfficers` appends the recipient id to this key. Without that a
       * dedupeKey shared by two officers would silence the second one — `notify`
       * matches on the key alone.
       */
      dedupeKey: `complaint-new:${String(complaint._id)}`,
    }
  ).catch((err) => console.error('[complaints] officer notification failed', err));

  return complaint;
}

/* ------------------------------------------------------------------ *
 * Public tracking
 * ------------------------------------------------------------------ */

export interface PublicComplaintView {
  complaintNo: string;
  status: ComplaintStatus;
  statusLabel: string;
  statusNote: string;
  complaintType: string;
  filedOn: string;
  businessName: string;
  district: string;
  state: string;
  description: string;
  evidenceCount: number;
  resolutionNote?: string;
  resolvedAt?: string;
  assignedToOffice?: string;
  timeline: { status: ComplaintStatus; label: string; note?: string; at: string }[];
}

/**
 * Looks up a complaint for the person who filed it.
 *
 * Requires the reference **and** the phone number. The reference alone is a
 * sequential number: anyone who filed one complaint could otherwise walk the
 * series and read every other complainant's name, address and allegations.
 */
export async function trackComplaint(
  reference: string,
  phone: string
): Promise<PublicComplaintView | null> {
  const complaintNo = normalizeComplaintNo(reference ?? '');
  const cleaned = cleanPhone(phone ?? '');
  if (!complaintNo || !cleaned) return null;

  const complaint = await Complaint.findOne({
    complaintNo,
    'complainant.phone': cleaned,
  }).lean<IComplaint>();

  if (!complaint) return null;

  return toPublicView(complaint);
}

export function toPublicView(complaint: IComplaint): PublicComplaintView {
  const status = complaint.status;

  return {
    complaintNo: complaint.complaintNo,
    status,
    statusLabel: COMPLAINT_STATUS_LABELS[status],
    statusNote: COMPLAINT_STATUS_PUBLIC_NOTE[status],
    complaintType: complaint.complaintType,
    filedOn: new Date(complaint.createdAt).toISOString(),
    businessName: complaint.against.businessName,
    district: complaint.against.district,
    state: complaint.against.state,
    description: complaint.description,
    evidenceCount: complaint.evidence?.length ?? 0,
    resolutionNote: complaint.resolutionNote,
    resolvedAt: complaint.resolvedAt ? new Date(complaint.resolvedAt).toISOString() : undefined,
    /*
     * The office, never the officer. A complainant is entitled to know their
     * report reached someone with authority; naming the individual who is about
     * to inspect the premises they complained about is a different matter.
     */
    assignedToOffice: complaint.assignedTo
      ? `${complaint.against.district} Legal Metrology Office`
      : undefined,
    timeline: (complaint.statusHistory ?? []).map((h) => ({
      status: h.to,
      label: COMPLAINT_STATUS_LABELS[h.to] ?? h.to,
      note: h.publicNote,
      at: new Date(h.at).toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Officer-side transitions
 * ------------------------------------------------------------------ */

/** Which statuses may follow which. Mirrors the application state machine's intent. */
const COMPLAINT_TRANSITIONS: Record<ComplaintStatus, ComplaintStatus[]> = {
  SUBMITTED: ['UNDER_REVIEW', 'ASSIGNED', 'REJECTED', 'WITHDRAWN'],
  UNDER_REVIEW: ['ASSIGNED', 'REJECTED', 'WITHDRAWN'],
  ASSIGNED: ['FIELD_VISIT_DONE', 'UNDER_REVIEW', 'REJECTED', 'WITHDRAWN'],
  FIELD_VISIT_DONE: ['ACTION_TAKEN', 'RESOLVED', 'REJECTED'],
  ACTION_TAKEN: ['RESOLVED'],
  RESOLVED: [],
  REJECTED: [],
  WITHDRAWN: [],
};

export function canTransitionComplaint(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return (COMPLAINT_TRANSITIONS[from] ?? []).includes(to);
}

export function nextComplaintStatuses(from: ComplaintStatus): ComplaintStatus[] {
  return COMPLAINT_TRANSITIONS[from] ?? [];
}

export interface TransitionComplaintInput {
  complaint: IComplaint & { save: () => Promise<unknown>; _id: Types.ObjectId };
  to: ComplaintStatus;
  actor: { id: string; role: string };
  internalNote?: string;
  publicNote?: string;
  assignTo?: string;
}

export async function transitionComplaint(input: TransitionComplaintInput): Promise<IComplaint> {
  const { complaint, to, actor } = input;
  const from = complaint.status;

  if (from === to) throw BadRequest(`This complaint is already ${COMPLAINT_STATUS_LABELS[to]}.`);
  if (!canTransitionComplaint(from, to)) {
    throw BadRequest(
      `A complaint cannot move from ${COMPLAINT_STATUS_LABELS[from]} to ${COMPLAINT_STATUS_LABELS[to]}.`
    );
  }
  if ((to === 'REJECTED' || to === 'RESOLVED') && !input.publicNote?.trim()) {
    throw BadRequest(
      'Write a note for the complainant. Closing a complaint without telling the person who filed it why is not a resolution.'
    );
  }

  complaint.status = to;

  if (to === 'ASSIGNED' && input.assignTo) {
    complaint.assignedTo = new Types.ObjectId(input.assignTo);
    complaint.assignedAt = new Date();
  }
  if (to === 'RESOLVED' || to === 'REJECTED') {
    complaint.resolutionNote = input.publicNote?.trim();
    complaint.resolvedAt = new Date();
  }

  complaint.statusHistory = [
    ...(complaint.statusHistory ?? []),
    {
      from,
      to,
      internalNote: input.internalNote?.trim() || undefined,
      // Falls back to the standard wording so the tracker is never blank.
      publicNote: input.publicNote?.trim() || COMPLAINT_STATUS_PUBLIC_NOTE[to],
      actorId: new Types.ObjectId(actor.id),
      actorRole: actor.role,
      at: new Date(),
    },
  ];

  await complaint.save();
  return complaint;
}
