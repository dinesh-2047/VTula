import mongoose, { Schema, Model, Document, Types } from 'mongoose';
import { INDIAN_STATES, ORGANIZATION_TYPES, type OrganizationType } from '@/lib/constants';

/**
 * A business entity that owns instruments.
 *
 * Previously the organisation was a free-text `organizationName` string on the
 * user, which made it impossible to (a) have several users under one business,
 * (b) compute an organisation-level compliance score, or (c) detect a repeat
 * offender across accounts — all of which the spec requires.
 */
export interface IOrganization extends Document {
  name: string;
  legalName?: string;
  type: OrganizationType;

  gstin?: string;
  pan?: string;

  address: {
    line1?: string;
    line2?: string;
    city?: string;
    district?: string;
    state?: string;
    pincode?: string;
  };

  contactEmail?: string;
  contactPhone?: string;

  primaryOwnerId: Types.ObjectId;
  memberIds: Types.ObjectId[];

  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>(
  {
    name: { type: String, required: true, trim: true, index: true },
    legalName: { type: String, trim: true },
    type: {
      type: String,
      enum: [...ORGANIZATION_TYPES],
      default: 'PROPRIETORSHIP',
    },

    gstin: { type: String, trim: true, uppercase: true, sparse: true },
    pan: { type: String, trim: true, uppercase: true, sparse: true },

    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      district: { type: String, trim: true, index: true },
      state: { type: String, enum: [...INDIAN_STATES, ''], index: true },
      pincode: { type: String, trim: true },
    },

    contactEmail: { type: String, trim: true, lowercase: true },
    contactPhone: { type: String, trim: true },

    primaryOwnerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    memberIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    /*
     * `instrumentCount` and `complianceScore` used to live here, described as
     * "denormalised counters, refreshed by the compliance scorer". Nothing ever
     * refreshed them. `complianceScore` defaulted to 100, and the profile page read
     * it back — so every business in the system was told its compliance score was
     * 100 across 0 instruments, permanently, whatever its records actually said.
     *
     * They are gone rather than fixed. The real figures are a count away:
     * `Instrument.countDocuments` for the estate (which `/api/profile` already
     * reports truthfully in its `activity` block) and the `ComplianceScore`
     * collection for the score, computed by `src/lib/compliance.ts` and served by
     * `/api/compliance`. A denormalised copy of either would only ever be a second
     * answer waiting to disagree with the first.
     */

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Organization: Model<IOrganization> =
  (mongoose.models.Organization as Model<IOrganization>) ||
  mongoose.model<IOrganization>('Organization', OrganizationSchema);

export default Organization;
