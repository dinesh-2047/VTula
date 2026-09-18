import mongoose, { Schema, Model } from 'mongoose';
import { CERTIFICATE_STATUSES, type CertificateStatus } from '@/lib/constants';

/**
 * A verification certificate.
 *
 * Changes from the previous shape:
 *  - the status enum now covers the full spec lifecycle, including
 *    `EXPIRING_SOON`, `SUSPENDED` and `SUPERSEDED`, which had no representation.
 *  - `dataHash` is now an actual SHA-256 digest. It previously stored the
 *    *plaintext* payload under a name that claimed otherwise, so the UI's
 *    "tamper-proof hash" was not one.
 *  - the instrument snapshot carries the jurisdiction, which the reports page
 *    was already trying to read (`instrumentSnapshot.installationDistrict`) and
 *    always getting `undefined` from — every certificate fell into one bucket.
 *  - renewal chain (`version`, `supersedesId`, `supersededById`) so a renewed
 *    certificate points at what it replaced.
 *  - `verificationCount` backs the public trust page counter.
 */

export interface ICertificate {
  _id: mongoose.Types.ObjectId;
  certNo: string;
  applicationId: mongoose.Types.ObjectId;
  instrumentId: mongoose.Types.ObjectId;
  inspectionId?: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;

  issuedDate: Date;
  expiryDate: Date;

  issuedBy: mongoose.Types.ObjectId;
  issuedByRole: string;
  /** Denormalised issuer identity, so a reissued/printed certificate is honest. */
  issuerSnapshot: {
    name: string;
    designation?: string;
    officerCode?: string;
    state?: string;
    district?: string;
    organizationName?: string;
  };

  instrumentSnapshot: {
    type: string;
    brand: string;
    model: string;
    serialNo: string;
    capacity: string;
    accuracyClass?: string;
    installationState?: string;
    installationDistrict?: string;
    address?: string;
  };

  ownerSnapshot: {
    name: string;
    email: string;
    phone?: string;
    organizationName?: string;
  };

  /** Summary of the inspection this certificate rests on. */
  inspectionSummary?: {
    inspectedAt: Date;
    result: string;
    readingCount: number;
    maxErrorPercent?: number;
    sealNo?: string;
  };

  /** The rule that determined validity, kept for explainability. */
  appliedRuleSnapshot?: {
    /**
     * Which rule row, and which version of it, was in force at issue. Rules are
     * amended by supersede-and-replace, so without the id and version an audit
     * cannot tell which terms this certificate was actually issued under.
     */
    ruleId?: mongoose.Types.ObjectId;
    ruleVersion?: number;
    validityMonths: number;
    legalReference?: string;
  };

  /** SHA-256 of the canonical payload, hex encoded. */
  dataHash: string;
  /** HMAC-SHA256 over the canonical payload. */
  digitalSignature: string;
  /** Key version, so the signing secret can be rotated without invalidating history. */
  signatureKeyId: string;

  /** The URL encoded into the QR code. */
  qrCodeData: string;

  status: CertificateStatus;

  /** Renewal / supersession chain. */
  version: number;
  supersedesId?: mongoose.Types.ObjectId;
  supersededById?: mongoose.Types.ObjectId;

  /** Suspension / revocation record. */
  suspension?: {
    reason: string;
    by: mongoose.Types.ObjectId;
    at: Date;
    until?: Date;
  };
  revocation?: {
    reason: string;
    by: mongoose.Types.ObjectId;
    at: Date;
    legalReference?: string;
  };

  /** Public trust-page counters. */
  verificationCount: number;
  lastVerifiedAt?: Date;
  downloadCount: number;

  /** Which expiry reminders have already gone out, so a sweep cannot repeat one. */
  remindersSent: { offsetDays: number; sentAt: Date; channel: string }[];

  createdAt: Date;
  updatedAt: Date;
}

const CertificateSchema = new Schema<ICertificate>(
  {
    certNo: { type: String, unique: true, required: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
    inspectionId: { type: Schema.Types.ObjectId, ref: 'Inspection' },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },

    issuedDate: { type: Date, required: true, default: Date.now },
    expiryDate: { type: Date, required: true },

    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    issuedByRole: { type: String, required: true },
    issuerSnapshot: {
      name: { type: String, required: true },
      designation: { type: String },
      officerCode: { type: String },
      state: { type: String },
      district: { type: String },
      organizationName: { type: String },
    },

    instrumentSnapshot: {
      type: { type: String },
      brand: { type: String },
      model: { type: String },
      serialNo: { type: String },
      capacity: { type: String },
      accuracyClass: { type: String },
      installationState: { type: String, index: true },
      installationDistrict: { type: String, index: true },
      address: { type: String },
    },

    ownerSnapshot: {
      name: { type: String },
      email: { type: String },
      phone: { type: String },
      organizationName: { type: String },
    },

    inspectionSummary: {
      inspectedAt: { type: Date },
      result: { type: String },
      readingCount: { type: Number },
      maxErrorPercent: { type: Number },
      sealNo: { type: String },
    },

    appliedRuleSnapshot: {
      ruleId: { type: Schema.Types.ObjectId, ref: 'Rule', index: true },
      ruleVersion: { type: Number },
      validityMonths: { type: Number },
      legalReference: { type: String },
    },

    dataHash: { type: String, required: true, index: true },
    digitalSignature: { type: String, required: true },
    signatureKeyId: { type: String, default: 'v1' },

    qrCodeData: { type: String },

    status: { type: String, enum: CERTIFICATE_STATUSES, default: 'ACTIVE', index: true },

    version: { type: Number, default: 1 },
    supersedesId: { type: Schema.Types.ObjectId, ref: 'Certificate' },
    supersededById: { type: Schema.Types.ObjectId, ref: 'Certificate' },

    suspension: {
      reason: { type: String },
      by: { type: Schema.Types.ObjectId, ref: 'User' },
      at: { type: Date },
      until: { type: Date },
    },
    revocation: {
      reason: { type: String },
      by: { type: Schema.Types.ObjectId, ref: 'User' },
      at: { type: Date },
      legalReference: { type: String },
    },

    verificationCount: { type: Number, default: 0 },
    lastVerifiedAt: { type: Date },
    downloadCount: { type: Number, default: 0 },

    remindersSent: [
      {
        offsetDays: { type: Number, required: true },
        sentAt: { type: Date, default: Date.now },
        channel: { type: String, default: 'app' },
      },
    ],
  },
  { timestamps: true }
);

CertificateSchema.index({ issuedBy: 1 });
CertificateSchema.index({ ownerId: 1, status: 1 });
CertificateSchema.index({ expiryDate: 1, status: 1 });
CertificateSchema.index({ 'instrumentSnapshot.installationState': 1, 'instrumentSnapshot.installationDistrict': 1 });

const Certificate: Model<ICertificate> =
  mongoose.models.Certificate || mongoose.model<ICertificate>('Certificate', CertificateSchema);
export default Certificate;
