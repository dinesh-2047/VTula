import mongoose, { Schema, Model, Document, Types } from 'mongoose';

/**
 * A single field inspection, stored as an immutable version.
 *
 * Spec §21/§22: an inspection record must never be silently edited. A
 * correction creates a **new version** that supersedes the previous one, so the
 * chain of custody is intact. The previous implementation embedded a mutable
 * `inspectionData` object on the application with readings as one free-text
 * string, which satisfied neither requirement.
 */

export interface IInspectionReading {
  /** Test point label, e.g. "25% of Max". */
  label: string;
  /** Reference / applied load, in the instrument's unit. */
  reference: number;
  /** Observed indication. */
  observed: number;
  unit: string;
  /** observed - reference. Computed on save. */
  error: number;
  /** Error as a percentage of the reference. Computed on save. */
  errorPercent: number;
  /** Maximum permissible error from the applicable rule. */
  maxErrorPercent: number;
  /** Whether this reading is inside tolerance. Computed on save. */
  withinTolerance: boolean;
}

export interface IConformityCheck {
  code: string;
  label: string;
  result: 'PASS' | 'FAIL' | 'NA';
  note?: string;
}

export interface IInspection extends Document {
  inspectionNo: string;
  applicationId: Types.ObjectId;
  instrumentId: Types.ObjectId;
  scheduleId?: Types.ObjectId;

  /** Immutable versioning. */
  version: number;
  supersedesId?: Types.ObjectId;
  isSuperseded: boolean;
  /** Reason the previous version was corrected — required for a v2+. */
  correctionReason?: string;

  inspectedBy: Types.ObjectId;
  inspectedByRole: string;
  inspectedAt: Date;

  /** Where the inspection actually happened. */
  location: {
    address?: string;
    district?: string;
    state?: string;
    gps?: { lat: number; lng: number; accuracyMetres?: number };
  };

  /** Distance between the registered site and the captured GPS, in metres. */
  gpsDriftMetres?: number;

  readings: IInspectionReading[];
  conformityChecks: IConformityCheck[];

  /** Reference standards / equipment used, for traceability. */
  referenceStandards?: {
    name: string;
    identifier?: string;
    calibrationValidUntil?: Date;
  }[];

  evidenceIds: Types.ObjectId[];

  ambientConditions?: {
    temperatureC?: number;
    humidityPercent?: number;
  };

  result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  remarks?: string;

  /** Seal / stamp details when the instrument passes (Act 2009 §24). */
  sealDetails?: {
    sealNo?: string;
    stampedAt?: Date;
    stampLocation?: string;
  };

  /** Set once the inspector submits; a submitted inspection is read-only. */
  isSubmitted: boolean;
  submittedAt?: Date;

  /** Filled in when the inspection was captured offline and synced later. */
  capturedOffline: boolean;
  syncedAt?: Date;
  /** Client-generated idempotency key so an offline replay cannot duplicate. */
  clientRecordId?: string;

  /** Integrity hash over the readings + evidence hashes. */
  dataHash?: string;

  createdAt: Date;
  updatedAt: Date;
}

const InspectionSchema = new Schema<IInspection>(
  {
    inspectionNo: { type: String, required: true, unique: true, index: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true, index: true },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
    scheduleId: { type: Schema.Types.ObjectId, ref: 'Schedule' },

    version: { type: Number, default: 1 },
    supersedesId: { type: Schema.Types.ObjectId, ref: 'Inspection' },
    isSuperseded: { type: Boolean, default: false, index: true },
    correctionReason: { type: String, trim: true },

    inspectedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    inspectedByRole: { type: String, required: true },
    inspectedAt: { type: Date, required: true, default: Date.now },

    location: {
      address: { type: String, trim: true },
      district: { type: String, trim: true },
      state: { type: String, trim: true },
      gps: {
        lat: { type: Number },
        lng: { type: Number },
        accuracyMetres: { type: Number },
      },
    },

    gpsDriftMetres: { type: Number },

    readings: [
      {
        label: { type: String, required: true },
        reference: { type: Number, required: true },
        observed: { type: Number, required: true },
        unit: { type: String, default: 'kg' },
        error: { type: Number, default: 0 },
        errorPercent: { type: Number, default: 0 },
        maxErrorPercent: { type: Number, default: 0 },
        withinTolerance: { type: Boolean, default: true },
      },
    ],

    conformityChecks: [
      {
        code: { type: String, required: true },
        label: { type: String, required: true },
        result: { type: String, enum: ['PASS', 'FAIL', 'NA'], default: 'NA' },
        note: { type: String, trim: true },
      },
    ],

    referenceStandards: [
      {
        name: { type: String, required: true },
        identifier: { type: String },
        calibrationValidUntil: { type: Date },
      },
    ],

    evidenceIds: [{ type: Schema.Types.ObjectId, ref: 'DocumentRecord' }],

    ambientConditions: {
      temperatureC: { type: Number },
      humidityPercent: { type: Number },
    },

    result: { type: String, enum: ['PASS', 'FAIL', 'INCONCLUSIVE'], default: 'INCONCLUSIVE', index: true },
    remarks: { type: String, trim: true },

    sealDetails: {
      sealNo: { type: String, trim: true },
      stampedAt: { type: Date },
      stampLocation: { type: String, trim: true },
    },

    isSubmitted: { type: Boolean, default: false, index: true },
    submittedAt: { type: Date },

    capturedOffline: { type: Boolean, default: false },
    syncedAt: { type: Date },
    clientRecordId: { type: String, index: true, sparse: true },

    dataHash: { type: String },
  },
  { timestamps: true }
);

/** Offline sync idempotency: the same client record may only land once. */
InspectionSchema.index(
  { inspectedBy: 1, clientRecordId: 1 },
  { unique: true, partialFilterExpression: { clientRecordId: { $type: 'string' } } }
);

/**
 * Recompute derived reading fields so the stored numbers always agree.
 *
 * Mongoose 9 pre-hooks no longer take a `next` callback.
 */
InspectionSchema.pre('validate', function () {
  const doc = this as unknown as IInspection;
  if (Array.isArray(doc.readings)) {
    for (const r of doc.readings) {
      r.error = Number((r.observed - r.reference).toFixed(6));
      r.errorPercent =
        r.reference === 0 ? 0 : Number(((r.error / r.reference) * 100).toFixed(6));
      r.withinTolerance = Math.abs(r.errorPercent) <= (r.maxErrorPercent ?? 0);
    }
  }
});

const Inspection: Model<IInspection> =
  (mongoose.models.Inspection as Model<IInspection>) ||
  mongoose.model<IInspection>('Inspection', InspectionSchema);

export default Inspection;
