import mongoose, { Schema, Model, Document, Types } from 'mongoose';
import { DOCUMENT_TYPES } from '@/lib/constants';

/**
 * A stored document or piece of inspection evidence.
 *
 * Spec §19 requires every uploaded file to carry an integrity hash, an uploader
 * and a version so that evidence is defensible. The previous implementation
 * stored base64 data-URLs directly inside the application document, which both
 * breaks the 16 MB BSON limit and leaves no integrity record.
 */
export interface IDocumentRecord extends Document {
  /** Original file name as uploaded. */
  fileName: string;
  mimeType: string;
  sizeBytes: number;

  /** SHA-256 of the file bytes, hex encoded — tamper evidence. */
  sha256: string;

  /** Where the bytes live. `url` for remote storage, `data` for inline fallback. */
  storage: 'cloudinary' | 'inline';
  url?: string;
  /** Base64 payload, only used when no object store is configured. */
  data?: string;

  documentType: string;

  /** Ownership / linkage. */
  uploadedBy: Types.ObjectId;
  organizationId?: Types.ObjectId;
  instrumentId?: Types.ObjectId;
  applicationId?: Types.ObjectId;
  inspectionId?: Types.ObjectId;
  certificateId?: Types.ObjectId;
  enforcementCaseId?: Types.ObjectId;

  /** Evidence metadata (photos captured in the field). */
  capturedAt?: Date;
  gps?: { lat: number; lng: number; accuracyMetres?: number };

  /** Versioning — a re-upload supersedes the previous document. */
  version: number;
  supersedesId?: Types.ObjectId;
  isSuperseded: boolean;

  /** Officer review of a submitted document. */
  reviewStatus: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  reviewNote?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const DocumentRecordSchema = new Schema<IDocumentRecord>(
  {
    fileName: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true, index: true },

    storage: { type: String, enum: ['cloudinary', 'inline'], default: 'inline' },
    url: { type: String },
    data: { type: String, select: false },

    documentType: { type: String, enum: DOCUMENT_TYPES, default: 'OTHER', index: true },

    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', index: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', index: true },
    inspectionId: { type: Schema.Types.ObjectId, ref: 'Inspection', index: true },
    certificateId: { type: Schema.Types.ObjectId, ref: 'Certificate', index: true },
    enforcementCaseId: { type: Schema.Types.ObjectId, ref: 'EnforcementCase', index: true },

    capturedAt: { type: Date },
    gps: {
      lat: { type: Number },
      lng: { type: Number },
      accuracyMetres: { type: Number },
    },

    version: { type: Number, default: 1 },
    supersedesId: { type: Schema.Types.ObjectId, ref: 'DocumentRecord' },
    isSuperseded: { type: Boolean, default: false, index: true },

    reviewStatus: { type: String, enum: ['PENDING', 'ACCEPTED', 'REJECTED'], default: 'PENDING' },
    reviewNote: { type: String, trim: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

const DocumentRecord: Model<IDocumentRecord> =
  (mongoose.models.DocumentRecord as Model<IDocumentRecord>) ||
  mongoose.model<IDocumentRecord>('DocumentRecord', DocumentRecordSchema);

export default DocumentRecord;
