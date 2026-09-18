import mongoose, { Schema, Model, Document, Types } from 'mongoose';
import { CERTIFICATE_EVENT_TYPES } from '@/lib/constants';

/**
 * Append-only certificate history.
 *
 * Powers the public Trust Center (spec §32/§40/§41): a citizen scanning a QR
 * should see not just "valid/invalid" but *what has happened* to this
 * certificate — issued, renewed, suspended, superseded. Nothing in this
 * collection is ever updated or deleted.
 */
export interface ICertificateEvent extends Document {
  certificateId: Types.ObjectId;
  certNo: string;
  instrumentId?: Types.ObjectId;

  eventType: string;
  /** Short public-facing description. Safe to show without login. */
  summary: string;
  /** Internal detail — never returned by the public verify endpoint. */
  internalNote?: string;

  fromStatus?: string;
  toStatus?: string;

  actorId?: Types.ObjectId;
  actorRole?: string;
  /** True when the event was produced by a scheduled job rather than a person. */
  isSystem: boolean;

  /** Whether this event is safe to display on the public trust page. */
  isPublic: boolean;

  occurredAt: Date;
  createdAt: Date;
}

const CertificateEventSchema = new Schema<ICertificateEvent>(
  {
    certificateId: { type: Schema.Types.ObjectId, ref: 'Certificate', required: true, index: true },
    certNo: { type: String, required: true, index: true },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', index: true },

    eventType: { type: String, enum: CERTIFICATE_EVENT_TYPES, required: true, index: true },
    summary: { type: String, required: true },
    internalNote: { type: String },

    fromStatus: { type: String },
    toStatus: { type: String },

    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    isSystem: { type: Boolean, default: false },

    isPublic: { type: Boolean, default: true, index: true },

    occurredAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const CertificateEvent: Model<ICertificateEvent> =
  (mongoose.models.CertificateEvent as Model<ICertificateEvent>) ||
  mongoose.model<ICertificateEvent>('CertificateEvent', CertificateEventSchema);

export default CertificateEvent;
