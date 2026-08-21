import mongoose, { Schema, Model } from 'mongoose';

export interface IInstrument {
  _id: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  type: string;
  brand: string;
  model: string;
  serialNo: string;
  capacity: string;
  accuracyClass: string;
  installationState: string;
  installationDistrict: string;
  address: string;
  gpsCoordinates?: { lat: number; lng: number };
  photos: string[];
  installationDate?: Date;
  status: 'Active' | 'PendingVerification' | 'Verified' | 'Expired' | 'Rejected';
  lastVerifiedDate?: Date;
  nextVerificationDue?: Date;
  currentCertificateId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const InstrumentSchema = new Schema<IInstrument>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true, trim: true },
    brand: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    serialNo: { type: String, required: true, unique: true, trim: true },
    capacity: { type: String, required: true, trim: true },
    accuracyClass: { type: String, trim: true, default: '' },
    installationState: { type: String, required: true, trim: true },
    installationDistrict: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    gpsCoordinates: {
      lat: { type: Number },
      lng: { type: Number },
    },
    photos: [{ type: String }],
    installationDate: { type: Date },
    status: {
      type: String,
      enum: ['Active', 'PendingVerification', 'Verified', 'Expired', 'Rejected'],
      default: 'Active',
    },
    lastVerifiedDate: { type: Date },
    nextVerificationDue: { type: Date },
    currentCertificateId: { type: Schema.Types.ObjectId, ref: 'Certificate' },
  },
  { timestamps: true }
);

InstrumentSchema.index({ serialNo: 1 }, { unique: true });
InstrumentSchema.index({ ownerId: 1 });
InstrumentSchema.index({ type: 1 });
InstrumentSchema.index({ installationState: 1, installationDistrict: 1 });
InstrumentSchema.index({ status: 1 });

const Instrument: Model<IInstrument> =
  mongoose.models.Instrument || mongoose.model<IInstrument>('Instrument', InstrumentSchema);
export default Instrument;
