import mongoose, { Schema, Model } from 'mongoose';
import {
  APPLICATION_STATUSES,
  DOCUMENT_TYPES,
  FEE_STATUSES,
  VERIFICATION_TYPES,
  type ApplicationStatus,
  type FeeStatus,
  type VerificationType,
} from '@/lib/constants';

/**
 * A verification application — the workflow object that moves an instrument
 * through the statutory process.
 *
 * Changes from the previous shape:
 *  - `status` now uses the full state machine from the spec instead of six
 *    ad-hoc values. Transitions are validated in `src/lib/workflow.ts`.
 *  - the mutable embedded `inspectionData` blob is gone; inspections live in
 *    their own versioned collection (`Inspection`) and are referenced here.
 *  - `statusHistory` records every transition with actor and reason, so the
 *    application carries its own chain of custody.
 *  - payment fields are written **only** by the server after verifying the
 *    Razorpay signature. Previously the client could POST `feeStatus: 'Paid'`.
 */

export interface IApplicationStatusEntry {
  from?: string;
  to: string;
  actorId?: mongoose.Types.ObjectId;
  actorRole?: string;
  reason?: string;
  isSystem: boolean;
  at: Date;
}

export interface IApplicationQuery {
  raisedBy: mongoose.Types.ObjectId;
  raisedAt: Date;
  /** What the officer needs from the applicant. */
  message: string;
  /** Document types the officer specifically asked for. */
  requestedDocuments: string[];
  dueBy?: Date;
  resolvedAt?: Date;
  response?: string;
  responseDocumentIds: mongoose.Types.ObjectId[];
}

export interface IApplication {
  _id: mongoose.Types.ObjectId;
  applicationNo: string;
  instrumentId: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;

  type: VerificationType;
  status: ApplicationStatus;

  /** Jurisdiction copied from the instrument at submission, for routing. */
  jurisdiction: { state: string; district: string };

  submittedDate?: Date;
  scheduledDate?: Date;
  completedDate?: Date;
  /** SLA target derived from the applicable rule. */
  dueDate?: Date;

  /** The rule snapshot applied to this application, for explainability. */
  appliedRuleId?: mongoose.Types.ObjectId;
  appliedRuleSnapshot?: {
    validityMonths: number;
    feeBase: number;
    requiredDocuments: string[];
    legalReference?: string;
  };

  /** Fee is always computed server-side from the rule. */
  feeAmount: number;
  feePaid: number;
  feeStatus: FeeStatus;
  paymentId?: string;
  orderId?: string;
  paymentVerifiedAt?: Date;
  paymentSignature?: string;

  assignedTo?: mongoose.Types.ObjectId;
  assignedType?: 'LMO' | 'GATC' | 'GATCTechnician';
  scheduleId?: mongoose.Types.ObjectId;

  inspectionLocation: string;
  /** Owner's requested inspection date, if they expressed a preference. */
  preferredDate?: Date;

  documentIds: mongoose.Types.ObjectId[];
  /** Legacy inline attachments from before document storage existed. */
  attachments: { name: string; url: string; type: string }[];

  /** Current (non-superseded) inspection, and the full version chain. */
  currentInspectionId?: mongoose.Types.ObjectId;
  inspectionIds: mongoose.Types.ObjectId[];

  certificateId?: mongoose.Types.ObjectId;

  statusHistory: IApplicationStatusEntry[];
  queries: IApplicationQuery[];

  /** Final decision, recorded separately from the status for auditability. */
  decision?: {
    outcome: 'APPROVED' | 'REJECTED';
    decidedBy: mongoose.Types.ObjectId;
    decidedByRole: string;
    decidedAt: Date;
    /** Mandatory justification — a rejection with no reason is not acceptable. */
    justification: string;
    /** Statutory clause the decision rests on. */
    legalReference?: string;
  };

  /** Advisory priority from the risk engine. Never used to auto-decide. */
  priorityScore: number;
  priorityReasons: string[];

  remarks: string;
  nextVerificationDue?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const ApplicationSchema = new Schema<IApplication>(
  {
    applicationNo: { type: String, unique: true, required: true },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },

    type: { type: String, enum: VERIFICATION_TYPES, required: true },
    status: {
      type: String,
      enum: APPLICATION_STATUSES,
      default: 'DRAFT',
      index: true,
    },

    jurisdiction: {
      state: { type: String, required: true, index: true },
      district: { type: String, required: true, index: true },
    },

    submittedDate: { type: Date },
    scheduledDate: { type: Date },
    completedDate: { type: Date },
    dueDate: { type: Date, index: true },

    appliedRuleId: { type: Schema.Types.ObjectId, ref: 'Rule' },
    appliedRuleSnapshot: {
      validityMonths: { type: Number },
      feeBase: { type: Number },
      requiredDocuments: [{ type: String }],
      legalReference: { type: String },
    },

    feeAmount: { type: Number, default: 0, min: 0 },
    feePaid: { type: Number, default: 0, min: 0 },
    feeStatus: { type: String, enum: FEE_STATUSES, default: 'Unpaid', index: true },
    paymentId: { type: String },
    orderId: { type: String, index: true, sparse: true },
    paymentVerifiedAt: { type: Date },
    paymentSignature: { type: String, select: false },

    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedType: { type: String, enum: ['LMO', 'GATC', 'GATCTechnician'] },
    scheduleId: { type: Schema.Types.ObjectId, ref: 'Schedule' },

    inspectionLocation: { type: String, required: true },
    preferredDate: { type: Date },

    documentIds: [{ type: Schema.Types.ObjectId, ref: 'DocumentRecord' }],
    attachments: [
      {
        name: { type: String },
        url: { type: String },
        type: { type: String },
      },
    ],

    currentInspectionId: { type: Schema.Types.ObjectId, ref: 'Inspection' },
    inspectionIds: [{ type: Schema.Types.ObjectId, ref: 'Inspection' }],

    certificateId: { type: Schema.Types.ObjectId, ref: 'Certificate' },

    statusHistory: [
      {
        from: { type: String },
        to: { type: String, required: true },
        actorId: { type: Schema.Types.ObjectId, ref: 'User' },
        actorRole: { type: String },
        reason: { type: String, trim: true },
        isSystem: { type: Boolean, default: false },
        at: { type: Date, default: Date.now },
      },
    ],

    queries: [
      {
        raisedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        raisedAt: { type: Date, default: Date.now },
        message: { type: String, required: true, trim: true },
        requestedDocuments: [{ type: String, enum: DOCUMENT_TYPES }],
        dueBy: { type: Date },
        resolvedAt: { type: Date },
        response: { type: String, trim: true },
        responseDocumentIds: [{ type: Schema.Types.ObjectId, ref: 'DocumentRecord' }],
      },
    ],

    decision: {
      outcome: { type: String, enum: ['APPROVED', 'REJECTED'] },
      decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      decidedByRole: { type: String },
      decidedAt: { type: Date },
      justification: { type: String, trim: true },
      legalReference: { type: String, trim: true },
    },

    priorityScore: { type: Number, default: 0, index: true },
    priorityReasons: [{ type: String }],

    remarks: { type: String, default: '' },
    nextVerificationDue: { type: Date },
  },
  { timestamps: true }
);

ApplicationSchema.index({ ownerId: 1, status: 1 });
ApplicationSchema.index({ assignedTo: 1, status: 1 });
ApplicationSchema.index({ 'jurisdiction.state': 1, 'jurisdiction.district': 1, status: 1 });
ApplicationSchema.index({ status: 1, priorityScore: -1 });
ApplicationSchema.index({ instrumentId: 1, createdAt: -1 });

const Application: Model<IApplication> =
  mongoose.models.Application || mongoose.model<IApplication>('Application', ApplicationSchema);
export default Application;
