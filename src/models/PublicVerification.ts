import mongoose, { Schema, Model, Document, Types } from 'mongoose';

/**
 * A record of a public QR / certificate-number verification.
 *
 * Spec §41 asks for a verification counter on the trust page ("verified N
 * times"), and the enforcement module needs to know when a certificate is being
 * checked repeatedly or when unknown numbers are being probed.
 *
 * Privacy note: we deliberately store a **hash** of the IP rather than the IP
 * itself, since this endpoint is unauthenticated and open to the public.
 */
export interface IPublicVerification extends Document {
  /** The number that was looked up, as typed. */
  queriedCertNo: string;
  certificateId?: Types.ObjectId;
  instrumentId?: Types.ObjectId;

  outcome: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED' | 'SUPERSEDED' | 'NOT_FOUND' | 'INTEGRITY_FAILED';

  /** SHA-256 of (ip + daily salt). Enough to rate-limit and spot probing. */
  requesterHash?: string;
  userAgent?: string;

  source: 'QR' | 'MANUAL' | 'API';

  verifiedAt: Date;
  createdAt: Date;
}

const PublicVerificationSchema = new Schema<IPublicVerification>(
  {
    queriedCertNo: { type: String, required: true, index: true },
    certificateId: { type: Schema.Types.ObjectId, ref: 'Certificate', index: true },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', index: true },

    outcome: {
      type: String,
      enum: [
        'VALID',
        'EXPIRING_SOON',
        'EXPIRED',
        'SUSPENDED',
        'REVOKED',
        'SUPERSEDED',
        'NOT_FOUND',
        'INTEGRITY_FAILED',
      ],
      required: true,
      index: true,
    },

    requesterHash: { type: String, index: true },
    userAgent: { type: String },

    source: { type: String, enum: ['QR', 'MANUAL', 'API'], default: 'MANUAL' },

    verifiedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const PublicVerification: Model<IPublicVerification> =
  (mongoose.models.PublicVerification as Model<IPublicVerification>) ||
  mongoose.model<IPublicVerification>('PublicVerification', PublicVerificationSchema);

export default PublicVerification;
