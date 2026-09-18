import mongoose, { Schema, Model, Document, Types } from 'mongoose';
import { INSTRUMENT_EVENT_TYPES } from '@/lib/constants';

/**
 * Append-only instrument timeline — the "Digital Passport" (spec §9).
 *
 * The central architectural point of the spec is that the **instrument**, not
 * the certificate, is the record of truth: it has a continuous history across
 * owners, locations, inspections and certificates. This collection is that
 * history.
 */
export interface IInstrumentEvent extends Document {
  instrumentId: Types.ObjectId;
  eventType: string;

  title: string;
  description?: string;

  /** Optional links to whatever produced the event. */
  applicationId?: Types.ObjectId;
  inspectionId?: Types.ObjectId;
  certificateId?: Types.ObjectId;
  scheduleId?: Types.ObjectId;
  enforcementCaseId?: Types.ObjectId;

  actorId?: Types.ObjectId;
  actorRole?: string;
  isSystem: boolean;

  /** Arbitrary before/after payload for ownership and location changes. */
  changes?: Record<string, unknown>;

  occurredAt: Date;
  createdAt: Date;
}

const InstrumentEventSchema = new Schema<IInstrumentEvent>(
  {
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
    eventType: { type: String, enum: INSTRUMENT_EVENT_TYPES, required: true, index: true },

    title: { type: String, required: true },
    description: { type: String },

    applicationId: { type: Schema.Types.ObjectId, ref: 'Application' },
    inspectionId: { type: Schema.Types.ObjectId, ref: 'Inspection' },
    certificateId: { type: Schema.Types.ObjectId, ref: 'Certificate' },
    scheduleId: { type: Schema.Types.ObjectId, ref: 'Schedule' },
    enforcementCaseId: { type: Schema.Types.ObjectId, ref: 'EnforcementCase' },

    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    isSystem: { type: Boolean, default: false },

    changes: { type: Schema.Types.Mixed },

    occurredAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

InstrumentEventSchema.index({ instrumentId: 1, occurredAt: -1 });

const InstrumentEvent: Model<IInstrumentEvent> =
  (mongoose.models.InstrumentEvent as Model<IInstrumentEvent>) ||
  mongoose.model<IInstrumentEvent>('InstrumentEvent', InstrumentEventSchema);

export default InstrumentEvent;
