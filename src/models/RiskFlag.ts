import mongoose, { Schema, Model, Document, Types } from 'mongoose';
import { RISK_FLAG_STATUSES, RISK_FLAG_TYPES, RISK_LEVELS } from '@/lib/constants';

/**
 * An explainable risk / anomaly flag.
 *
 * The spec is emphatic that the system may only ever *recommend* — it must not
 * decide. Every flag therefore carries `reasons` (the human-readable evidence
 * that produced it) and `recommendedAction`, and requires an officer to
 * confirm or dismiss it. Nothing downstream auto-rejects on a flag.
 */
export interface IRiskFlag extends Document {
  flagType: string;
  level: string;
  /** 0-100 contribution to the priority score. Advisory only. */
  score: number;

  /** Target of the flag — at least one is set. */
  instrumentId?: Types.ObjectId;
  applicationId?: Types.ObjectId;
  certificateId?: Types.ObjectId;
  organizationId?: Types.ObjectId;
  ownerId?: Types.ObjectId;

  title: string;
  /** Plain-language bullet points explaining exactly why this was flagged. */
  reasons: string[];
  /** What a human is advised to do. Never executed automatically. */
  recommendedAction: string;

  /** Machine-readable evidence for the officer to inspect. */
  evidence?: Record<string, unknown>;

  status: string;
  /** Officer resolution. */
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  reviewNote?: string;

  /** Stable key so the detector does not create duplicate flags each run. */
  dedupeKey: string;

  detectedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RiskFlagSchema = new Schema<IRiskFlag>(
  {
    flagType: { type: String, enum: RISK_FLAG_TYPES, required: true, index: true },
    level: { type: String, enum: RISK_LEVELS, default: 'MEDIUM', index: true },
    score: { type: Number, default: 0, min: 0, max: 100 },

    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', index: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', index: true },
    certificateId: { type: Schema.Types.ObjectId, ref: 'Certificate', index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    title: { type: String, required: true },
    reasons: { type: [String], default: [] },
    recommendedAction: { type: String, required: true },

    evidence: { type: Schema.Types.Mixed },

    status: { type: String, enum: RISK_FLAG_STATUSES, default: 'OPEN', index: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String, trim: true },

    dedupeKey: { type: String, required: true, unique: true, index: true },

    detectedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

const RiskFlag: Model<IRiskFlag> =
  (mongoose.models.RiskFlag as Model<IRiskFlag>) ||
  mongoose.model<IRiskFlag>('RiskFlag', RiskFlagSchema);

export default RiskFlag;
