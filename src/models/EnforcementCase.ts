import mongoose, { Schema, Model, Document, Types } from 'mongoose';
import { ENFORCEMENT_CASE_STATUSES, ENFORCEMENT_CASE_TYPES } from '@/lib/constants';

/**
 * An enforcement case (spec: enforcementCases).
 *
 * Covers the "what happens when something is actually wrong" half of the
 * problem statement, which had no implementation at all: public complaints
 * against an instrument, expired-certificate follow-ups, tampered seals and
 * repeat offenders.
 */
export interface IEnforcementCase extends Document {
  caseNo: string;
  caseType: string;
  status: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';

  /** Subject of the case. */
  instrumentId?: Types.ObjectId;
  organizationId?: Types.ObjectId;
  ownerId?: Types.ObjectId;
  certificateId?: Types.ObjectId;

  title: string;
  description: string;

  /** Where the case came from. */
  origin: 'PUBLIC_COMPLAINT' | 'RISK_FLAG' | 'INSPECTION' | 'OFFICER' | 'SYSTEM';
  riskFlagId?: Types.ObjectId;

  /** Complainant details — optional, complaints may be anonymous. */
  complainant?: {
    name?: string;
    phone?: string;
    email?: string;
    isAnonymous: boolean;
    /**
     * Salted hash of the filing IP, never the address itself.
     *
     * Two jobs: it rate-limits anonymous intake, and it lets an officer see that
     * nine "unrelated" complaints against a competitor came from one source. A
     * hash rather than the address because an anonymous complainant was promised
     * anonymity, and this is enough to correlate without identifying.
     */
    ipHash?: string;
  };

  jurisdiction: {
    state?: string;
    district?: string;
  };

  assignedTo?: Types.ObjectId;
  assignedAt?: Date;

  /** Case actions, append-only. */
  actions: {
    action: string;
    note?: string;
    actorId?: Types.ObjectId;
    actorRole?: string;
    at: Date;
  }[];

  evidenceIds: Types.ObjectId[];

  penalty?: {
    amount?: number;
    currency: string;
    imposedAt?: Date;
    reference?: string;
    paidAt?: Date;
  };

  outcome?: string;
  closedAt?: Date;
  closedBy?: Types.ObjectId;

  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const EnforcementCaseSchema = new Schema<IEnforcementCase>(
  {
    caseNo: { type: String, required: true, unique: true, index: true },
    caseType: { type: String, enum: ENFORCEMENT_CASE_TYPES, required: true, index: true },
    status: { type: String, enum: ENFORCEMENT_CASE_STATUSES, default: 'OPEN', index: true },
    severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM', index: true },

    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    certificateId: { type: Schema.Types.ObjectId, ref: 'Certificate', index: true },

    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },

    origin: {
      type: String,
      enum: ['PUBLIC_COMPLAINT', 'RISK_FLAG', 'INSPECTION', 'OFFICER', 'SYSTEM'],
      default: 'OFFICER',
    },
    riskFlagId: { type: Schema.Types.ObjectId, ref: 'RiskFlag' },

    complainant: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      isAnonymous: { type: Boolean, default: false },
      ipHash: { type: String, index: true },
    },

    jurisdiction: {
      state: { type: String, index: true },
      district: { type: String, index: true },
    },

    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    assignedAt: { type: Date },

    actions: [
      {
        action: { type: String, required: true },
        note: { type: String, trim: true },
        actorId: { type: Schema.Types.ObjectId, ref: 'User' },
        actorRole: { type: String },
        at: { type: Date, default: Date.now },
      },
    ],

    evidenceIds: [{ type: Schema.Types.ObjectId, ref: 'DocumentRecord' }],

    penalty: {
      amount: { type: Number, min: 0 },
      currency: { type: String, default: 'INR' },
      imposedAt: { type: Date },
      reference: { type: String, trim: true },
      paidAt: { type: Date },
    },

    outcome: { type: String, trim: true },
    closedAt: { type: Date },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const EnforcementCase: Model<IEnforcementCase> =
  (mongoose.models.EnforcementCase as Model<IEnforcementCase>) ||
  mongoose.model<IEnforcementCase>('EnforcementCase', EnforcementCaseSchema);

export default EnforcementCase;
