import mongoose, { Schema, Model, Document, Types } from 'mongoose';

/**
 * A snapshot of an organisation's Compliance Health Score.
 *
 * Spec: businesses should see a single, explainable number rather than a wall of
 * statuses. `breakdown` carries the component contributions so the score can
 * always be justified — it is never an opaque figure.
 */
export interface IComplianceScoreComponent {
  key: string;
  label: string;
  /** Points earned for this component. */
  earned: number;
  /** Points available for this component. */
  possible: number;
  detail: string;
}

export interface IComplianceScore extends Document {
  organizationId?: Types.ObjectId;
  ownerId: Types.ObjectId;

  /** 0-100. */
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E';

  breakdown: IComplianceScoreComponent[];

  /** Counters used to compute the score, kept for display. */
  stats: {
    totalInstruments: number;
    verifiedInstruments: number;
    expiringSoon: number;
    expired: number;
    openRiskFlags: number;
    openEnforcementCases: number;
    lateRenewals: number;
    onTimeRenewals: number;
  };

  /** Concrete, ordered next steps the business can act on. */
  recommendations: string[];

  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ComplianceScoreSchema = new Schema<IComplianceScore>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    score: { type: Number, required: true, min: 0, max: 100 },
    grade: { type: String, enum: ['A', 'B', 'C', 'D', 'E'], required: true },

    breakdown: [
      {
        key: { type: String, required: true },
        label: { type: String, required: true },
        earned: { type: Number, required: true },
        possible: { type: Number, required: true },
        detail: { type: String, default: '' },
      },
    ],

    stats: {
      totalInstruments: { type: Number, default: 0 },
      verifiedInstruments: { type: Number, default: 0 },
      expiringSoon: { type: Number, default: 0 },
      expired: { type: Number, default: 0 },
      openRiskFlags: { type: Number, default: 0 },
      openEnforcementCases: { type: Number, default: 0 },
      lateRenewals: { type: Number, default: 0 },
      onTimeRenewals: { type: Number, default: 0 },
    },

    recommendations: { type: [String], default: [] },

    computedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

ComplianceScoreSchema.index({ ownerId: 1, computedAt: -1 });

const ComplianceScore: Model<IComplianceScore> =
  (mongoose.models.ComplianceScore as Model<IComplianceScore>) ||
  mongoose.model<IComplianceScore>('ComplianceScore', ComplianceScoreSchema);

export default ComplianceScore;
