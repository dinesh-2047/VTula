import mongoose, { Schema, Model } from 'mongoose';
import {
  INDIAN_STATES,
  INSTRUMENT_STATUSES,
  INSTRUMENT_TYPES,
  type InstrumentStatus,
} from '@/lib/constants';

/**
 * A physical weighing / measuring instrument — the central record of the system.
 *
 * The spec's key architectural point is that the *instrument* carries the
 * lifecycle, not the certificate: it has a continuous history across owners,
 * locations, inspections and certificates. See `InstrumentEvent` for that
 * timeline and `ownershipHistory` / `locationHistory` below for the structured
 * change log.
 */
export interface IInstrumentOwnershipEntry {
  ownerId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  ownerName: string;
  from: Date;
  to?: Date;
  /** Reference to the transfer application, when one exists. */
  transferApplicationId?: mongoose.Types.ObjectId;
  note?: string;
}

export interface IInstrumentLocationEntry {
  address: string;
  installationState: string;
  installationDistrict: string;
  gpsCoordinates?: { lat: number; lng: number };
  from: Date;
  to?: Date;
  note?: string;
}

export interface IInstrument {
  _id: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;

  type: string;
  brand: string;
  model: string;
  serialNo: string;
  /** Uppercased, whitespace-stripped serial used for duplicate detection. */
  serialNoNormalized: string;
  capacity: string;
  /** Numeric capacity + unit, parsed from `capacity`, used by the tolerance table. */
  capacityValue?: number;
  capacityUnit?: string;
  accuracyClass: string;

  /** Manufacturer model-approval reference (required by the Act for some types). */
  modelApprovalNo?: string;
  manufactureYear?: number;

  installationState: string;
  installationDistrict: string;
  address: string;
  gpsCoordinates?: { lat: number; lng: number };

  /** Uploaded registration photos, as DocumentRecord references. */
  photoIds: mongoose.Types.ObjectId[];
  /** Legacy inline photo URLs / data-URLs from before document storage existed. */
  photos: string[];

  installationDate?: Date;
  status: InstrumentStatus;

  lastVerifiedDate?: Date;
  nextVerificationDue?: Date;
  currentCertificateId?: mongoose.Types.ObjectId;

  ownershipHistory: IInstrumentOwnershipEntry[];
  locationHistory: IInstrumentLocationEntry[];

  /** Set when a possible duplicate registration was detected and not yet resolved. */
  duplicateReviewPending: boolean;

  /** Denormalised, refreshed on each certificate issue. */
  verificationCount: number;
  failedInspectionCount: number;

  isDecommissioned: boolean;
  decommissionedAt?: Date;
  decommissionReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const InstrumentSchema = new Schema<IInstrument>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },

    type: { type: String, required: true, trim: true, enum: INSTRUMENT_TYPES },
    brand: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    serialNo: { type: String, required: true, trim: true },
    serialNoNormalized: { type: String, required: true, index: true },
    capacity: { type: String, required: true, trim: true },
    capacityValue: { type: Number },
    capacityUnit: { type: String, trim: true },
    accuracyClass: { type: String, trim: true, default: '' },

    modelApprovalNo: { type: String, trim: true },
    manufactureYear: { type: Number, min: 1900, max: 2200 },

    installationState: { type: String, required: true, trim: true, enum: INDIAN_STATES },
    installationDistrict: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    gpsCoordinates: {
      lat: { type: Number, min: -90, max: 90 },
      lng: { type: Number, min: -180, max: 180 },
    },

    photoIds: [{ type: Schema.Types.ObjectId, ref: 'DocumentRecord' }],
    photos: [{ type: String }],

    installationDate: { type: Date },
    status: {
      type: String,
      enum: INSTRUMENT_STATUSES,
      default: 'REGISTERED',
    },

    lastVerifiedDate: { type: Date },
    nextVerificationDue: { type: Date, index: true },
    currentCertificateId: { type: Schema.Types.ObjectId, ref: 'Certificate' },

    ownershipHistory: [
      {
        ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
        ownerName: { type: String, required: true },
        from: { type: Date, required: true },
        to: { type: Date },
        transferApplicationId: { type: Schema.Types.ObjectId, ref: 'Application' },
        note: { type: String, trim: true },
      },
    ],

    locationHistory: [
      {
        address: { type: String, required: true },
        installationState: { type: String, required: true },
        installationDistrict: { type: String, required: true },
        gpsCoordinates: { lat: { type: Number }, lng: { type: Number } },
        from: { type: Date, required: true },
        to: { type: Date },
        note: { type: String, trim: true },
      },
    ],

    duplicateReviewPending: { type: Boolean, default: false, index: true },

    verificationCount: { type: Number, default: 0 },
    failedInspectionCount: { type: Number, default: 0 },

    isDecommissioned: { type: Boolean, default: false, index: true },
    decommissionedAt: { type: Date },
    decommissionReason: { type: String, trim: true },
  },
  { timestamps: true }
);

/**
 * The same physical device (brand + model + serial) may only be registered once.
 *
 * Previously `serialNo` alone was globally unique, which rejected legitimate
 * registrations whenever two manufacturers happened to reuse a serial. A second
 * owner claiming an already-registered device should file a transfer, not a new
 * registration — the API returns that guidance and raises a review flag.
 */
InstrumentSchema.index(
  { brand: 1, model: 1, serialNoNormalized: 1 },
  { unique: true, name: 'uniq_brand_model_serial' }
);

InstrumentSchema.index({ ownerId: 1 });
InstrumentSchema.index({ type: 1 });
InstrumentSchema.index({ installationState: 1, installationDistrict: 1 });
InstrumentSchema.index({ status: 1 });
InstrumentSchema.index({ installationState: 1, status: 1, nextVerificationDue: 1 });

/**
 * Keep the normalised serial and parsed capacity in sync with their sources.
 *
 * Mongoose 9 pre-hooks no longer take a `next` callback — returning (or
 * resolving) is what continues the chain.
 */
InstrumentSchema.pre('validate', function () {
  const doc = this as unknown as IInstrument & { isModified(path: string): boolean };

  if (doc.serialNo && (!doc.serialNoNormalized || doc.isModified('serialNo'))) {
    doc.serialNoNormalized = doc.serialNo.replace(/[\s-]/g, '').toUpperCase();
  }

  if (doc.capacity && (doc.capacityValue == null || doc.isModified('capacity'))) {
    const match = /^\s*([\d.]+)\s*([a-zA-Z]*)/.exec(doc.capacity);
    if (match) {
      const parsed = Number.parseFloat(match[1]);
      if (!Number.isNaN(parsed)) doc.capacityValue = parsed;
      if (match[2]) doc.capacityUnit = match[2];
    }
  }
});

const Instrument: Model<IInstrument> =
  mongoose.models.Instrument || mongoose.model<IInstrument>('Instrument', InstrumentSchema);
export default Instrument;
