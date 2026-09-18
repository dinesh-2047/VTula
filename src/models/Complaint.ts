import mongoose, { Schema, Model, Document, Types } from 'mongoose';
import {
  COMPLAINT_TYPES,
  COMPLAINT_STATUSES,
  COMPLAINT_PRIORITIES,
  type ComplaintStatus,
} from '@/lib/constants';

/**
 * A complaint filed by a member of the public.
 *
 * The only record in this system created by someone with no account. That single
 * fact drives most of the design here:
 *
 *  - **Evidence is embedded, not filed as a `DocumentRecord`.** That model
 *    requires an `uploadedBy` user and is served through an authorisation-gated
 *    route; a complainant has neither a user id nor a session. Rather than
 *    loosening a model that guards prosecution evidence, a complaint carries its
 *    own attachments with the same integrity fields (`sha256`, size, mime).
 *
 *  - **The reference number is the credential.** `VT-CMP-YYYY-NNNNNN` plus the
 *    phone number used to file is what lets someone check their own complaint
 *    back. It is deliberately not enough to read anybody else's: the tracking
 *    lookup requires both, and returns only the public projection.
 *
 *  - **Two parties are recorded in full.** The complainant, and the trader
 *    complained about. The old enforcement flow only ever knew about the trader,
 *    which meant an officer could not call the person who reported the problem.
 *
 *  - **`statusHistory` is append-only** and carries a public note per entry, so
 *    the citizen-facing tracker is rendered from the same record the officer
 *    writes rather than from a second, drifting summary.
 */

export interface IComplaintEvidence {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256 of the bytes, hex. Tamper evidence, same as `DocumentRecord`. */
  sha256: string;
  storage: 'cloudinary' | 'inline';
  url?: string;
  /** Base64 payload when no object store is configured. */
  data?: string;
  kind: 'image' | 'video' | 'document';
  uploadedAt: Date;
}

export interface IComplaintStatusEntry {
  from?: ComplaintStatus;
  to: ComplaintStatus;
  /** Shown to the officer only. */
  internalNote?: string;
  /** Shown to the complainant on the public tracker. */
  publicNote?: string;
  actorId?: Types.ObjectId;
  actorRole?: string;
  at: Date;
}

export interface IComplaint extends Document {
  complaintNo: string;

  /* ---- Who is complaining ---- */
  complainant: {
    name: string;
    phone: string;
    email?: string;
    address?: string;
    /** Withholds the name from the trader. The department still sees it. */
    isAnonymousToTrader: boolean;
  };

  /* ---- Who is being complained about ---- */
  against: {
    businessName: string;
    ownerName?: string;
    phone?: string;
    /** Shop / premises address where the instrument is. */
    address: string;
    state: string;
    district: string;
    pincode?: string;
    landmark?: string;
    /** Free text — a citizen will not know the instrument's registered type. */
    instrumentDescription?: string;
    /** If the trader displays one and the complainant could read it. */
    certNo?: string;
  };

  /* ---- The complaint itself ---- */
  complaintType: string;
  description: string;
  incidentDate?: Date;
  /** Captured from the browser when permitted — puts the report on a map. */
  gps?: { lat: number; lng: number; accuracyMetres?: number };

  evidence: IComplaintEvidence[];

  /* ---- Departmental handling ---- */
  status: ComplaintStatus;
  priority: string;
  statusHistory: IComplaintStatusEntry[];

  assignedTo?: Types.ObjectId;
  assignedAt?: Date;

  /** Set when an officer escalates the complaint into a formal case. */
  enforcementCaseId?: Types.ObjectId;
  /** Resolved by an officer once the premises are identified in the register. */
  instrumentId?: Types.ObjectId;
  certificateId?: Types.ObjectId;

  /** Closing statement shown to the complainant. */
  resolutionNote?: string;
  resolvedAt?: Date;

  /**
   * Salted hash of the submitting IP, never the IP.
   *
   * Same reasoning as the public verification log: repeated abusive filing has
   * to be visible to enforcement without the department accumulating a record of
   * who reported which shop.
   */
  submitterHash?: string;

  createdAt: Date;
  updatedAt: Date;
}

const EvidenceSchema = new Schema<IComplaintEvidence>(
  {
    fileName: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    storage: { type: String, enum: ['cloudinary', 'inline'], default: 'inline' },
    url: { type: String },
    data: { type: String },
    kind: { type: String, enum: ['image', 'video', 'document'], default: 'image' },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const ComplaintSchema = new Schema<IComplaint>(
  {
    complaintNo: { type: String, required: true, unique: true, index: true },

    complainant: {
      name: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true, index: true },
      email: { type: String, trim: true, lowercase: true },
      address: { type: String, trim: true },
      isAnonymousToTrader: { type: Boolean, default: false },
    },

    against: {
      businessName: { type: String, required: true, trim: true },
      ownerName: { type: String, trim: true },
      phone: { type: String, trim: true },
      address: { type: String, required: true, trim: true },
      state: { type: String, required: true, trim: true, index: true },
      district: { type: String, required: true, trim: true, index: true },
      pincode: { type: String, trim: true },
      landmark: { type: String, trim: true },
      instrumentDescription: { type: String, trim: true },
      certNo: { type: String, trim: true, uppercase: true },
    },

    complaintType: { type: String, enum: COMPLAINT_TYPES, required: true, index: true },
    description: { type: String, required: true, trim: true },
    incidentDate: { type: Date },
    gps: {
      lat: { type: Number },
      lng: { type: Number },
      accuracyMetres: { type: Number },
    },

    evidence: { type: [EvidenceSchema], default: [] },

    status: {
      type: String,
      enum: COMPLAINT_STATUSES,
      default: 'SUBMITTED',
      index: true,
    },
    priority: { type: String, enum: COMPLAINT_PRIORITIES, default: 'NORMAL', index: true },

    statusHistory: [
      {
        from: { type: String },
        to: { type: String, required: true },
        internalNote: { type: String, trim: true },
        publicNote: { type: String, trim: true },
        actorId: { type: Schema.Types.ObjectId, ref: 'User' },
        actorRole: { type: String },
        at: { type: Date, default: Date.now },
      },
    ],

    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    assignedAt: { type: Date },

    enforcementCaseId: { type: Schema.Types.ObjectId, ref: 'EnforcementCase' },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument' },
    certificateId: { type: Schema.Types.ObjectId, ref: 'Certificate' },

    resolutionNote: { type: String, trim: true },
    resolvedAt: { type: Date },

    submitterHash: { type: String, index: true },
  },
  { timestamps: true }
);

/** The officer queue: open complaints in a jurisdiction, oldest first. */
ComplaintSchema.index({ 'against.state': 1, 'against.district': 1, status: 1, createdAt: -1 });

/** Tracking lookup — reference plus the phone that filed it. */
ComplaintSchema.index({ complaintNo: 1, 'complainant.phone': 1 });

const Complaint: Model<IComplaint> =
  (mongoose.models.Complaint as Model<IComplaint>) ||
  mongoose.model<IComplaint>('Complaint', ComplaintSchema);

export default Complaint;
