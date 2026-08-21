import mongoose, { Schema, Model } from 'mongoose';

export interface ICertificate {
  _id: mongoose.Types.ObjectId;
  certNo: string;
  applicationId: mongoose.Types.ObjectId;
  instrumentId: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  issuedDate: Date;
  expiryDate: Date;
  issuedBy: mongoose.Types.ObjectId;
  issuedByRole: 'LMO' | 'GATC';
  instrumentSnapshot: {
    type: string;
    brand: string;
    model: string;
    serialNo: string;
    capacity: string;
  };
  ownerSnapshot: {
    name: string;
    email: string;
    phone?: string;
  };
  dataHash: string;
  digitalSignature: string;
  qrCodeData: string;
  status: 'Active' | 'Expired' | 'Revoked';
  createdAt: Date;
  updatedAt: Date;
}

const CertificateSchema = new Schema<ICertificate>(
  {
    certNo: { type: String, unique: true, required: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    issuedDate: { type: Date, required: true, default: Date.now },
    expiryDate: { type: Date, required: true },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    issuedByRole: { type: String, enum: ['LMO', 'GATC'], required: true },
    instrumentSnapshot: {
      type: { type: String },
      brand: { type: String },
      model: { type: String },
      serialNo: { type: String },
      capacity: { type: String },
    },
    ownerSnapshot: {
      name: { type: String },
      email: { type: String },
      phone: { type: String },
    },
    dataHash: { type: String, required: true },
    digitalSignature: { type: String, required: true },
    qrCodeData: { type: String },
    status: { type: String, enum: ['Active', 'Expired', 'Revoked'], default: 'Active' },
  },
  { timestamps: true }
);

CertificateSchema.index({ certNo: 1 }, { unique: true });
CertificateSchema.index({ issuedBy: 1 });
CertificateSchema.index({ ownerId: 1 });
CertificateSchema.index({ expiryDate: 1 });
CertificateSchema.index({ status: 1 });

const Certificate: Model<ICertificate> =
  mongoose.models.Certificate || mongoose.model<ICertificate>('Certificate', CertificateSchema);
export default Certificate;
