import mongoose, { Schema, Model, Document, Types } from 'mongoose';
import { DOCUMENT_TYPES, INSTRUMENT_TYPES } from '@/lib/constants';

/**
 * Regulatory rule configuration.
 *
 * The spec is explicit that validity periods, fees, required documents and SLA
 * targets must be **configuration, not code** — rules differ per state and
 * change when the law changes. Previously the certificate validity was
 * hardcoded to `+1 year` inside the task route and fees lived in a literal map.
 *
 * Resolution is most-specific-first:
 *   (state, instrumentType) > (state, null) > (null, instrumentType) > (null, null)
 * The `null/null` row is the national default and is seeded automatically.
 */

export interface IRuleFee {
  /** Base statutory fee in INR. */
  base: number;
  /** Multiplier applied for a periodic re-verification (e.g. 0.75 = 25% off). */
  reverificationMultiplier: number;
  /** Multiplier applied for a post-repair verification. */
  repairMultiplier: number;
  /** Multiplier applied for an ownership/location transfer. */
  transferMultiplier: number;
}

export interface IRuleTolerance {
  /** Human label for the test point, e.g. "25% of Max". */
  label: string;
  /** Maximum permissible error as a percentage of the applied load. */
  maxErrorPercent: number;
}

export interface IRule extends Document {
  name: string;
  description?: string;

  /** Scope — `null` means "applies to all". */
  state: string | null;
  instrumentType: string | null;

  /** Certificate validity in months (spec: configurable per category/state). */
  validityMonths: number;

  /** Days before expiry at which reminders fire. */
  expiryAlertOffsetsDays: number[];

  /** Days before expiry at which a certificate is marked EXPIRING_SOON. */
  expiringSoonWindowDays: number;

  fee: IRuleFee;

  /** Document types that must be attached before an application may be submitted. */
  requiredDocuments: string[];

  /** Target working days for each SLA stage. */
  sla: {
    reviewDays: number;
    schedulingDays: number;
    decisionDays: number;
  };

  /** Test points / tolerance table used by the inspection form. */
  tolerances: IRuleTolerance[];

  /** Minimum number of evidence photos an inspector must capture. */
  minEvidencePhotos: number;

  /** Whether an inspection must carry GPS coordinates. */
  requireGpsEvidence: boolean;

  /** Metres of allowed drift between the registered site and inspection GPS. */
  gpsToleranceMetres: number;

  /** Legal citation shown to users so decisions are explainable. */
  legalReference?: string;

  isActive: boolean;
  version: number;
  effectiveFrom: Date;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const RuleSchema = new Schema<IRule>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    state: { type: String, default: null, index: true },
    instrumentType: { type: String, enum: [...INSTRUMENT_TYPES, null], default: null, index: true },

    validityMonths: { type: Number, required: true, default: 12, min: 1, max: 120 },

    expiryAlertOffsetsDays: { type: [Number], default: [60, 30, 7] },
    expiringSoonWindowDays: { type: Number, default: 60, min: 1 },

    fee: {
      base: { type: Number, required: true, default: 500, min: 0 },
      reverificationMultiplier: { type: Number, default: 0.75, min: 0 },
      repairMultiplier: { type: Number, default: 0.9, min: 0 },
      transferMultiplier: { type: Number, default: 0.5, min: 0 },
    },

    requiredDocuments: {
      type: [String],
      enum: DOCUMENT_TYPES,
      default: ['OWNERSHIP_PROOF'],
    },

    sla: {
      reviewDays: { type: Number, default: 3, min: 1 },
      schedulingDays: { type: Number, default: 7, min: 1 },
      decisionDays: { type: Number, default: 3, min: 1 },
    },

    tolerances: [
      {
        label: { type: String, required: true },
        maxErrorPercent: { type: Number, required: true },
      },
    ],

    minEvidencePhotos: { type: Number, default: 2, min: 0 },
    requireGpsEvidence: { type: Boolean, default: true },
    gpsToleranceMetres: { type: Number, default: 500, min: 0 },

    legalReference: { type: String, trim: true },

    isActive: { type: Boolean, default: true, index: true },
    version: { type: Number, default: 1 },
    effectiveFrom: { type: Date, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One active rule per (state, instrumentType) scope.
RuleSchema.index({ state: 1, instrumentType: 1, isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

const Rule: Model<IRule> =
  (mongoose.models.Rule as Model<IRule>) || mongoose.model<IRule>('Rule', RuleSchema);

export default Rule;
