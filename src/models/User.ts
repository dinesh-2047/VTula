import mongoose, { Schema, Document, Model } from 'mongoose';
import { INDIAN_STATES, INSTRUMENT_TYPES, ROLES, type Role } from '@/lib/constants';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  role: Role;

  /** Jurisdiction the account operates in. */
  state?: string;
  district?: string;
  /** Additional districts an officer covers beyond their primary one. */
  additionalDistricts: string[];

  /** Business linkage (Owner accounts). */
  organizationId?: mongoose.Types.ObjectId;
  organizationName?: string;

  /** GATC accreditation (GATC / GATCTechnician accounts). */
  gatcId?: mongoose.Types.ObjectId;
  categoriesApproved: string[];
  accreditationNo?: string;
  accreditationValidUntil?: Date;

  /** Officer identity used on certificates. */
  officerCode?: string;
  designation?: string;

  aadhaarLinkedId?: string;
  profilePhoto?: string;

  isActive: boolean;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;

  /**
   * Privileged accounts (anything other than Owner) must be approved before they
   * can sign in. Prevents the previous privilege-escalation hole where a visitor
   * could self-register as an Admin.
   */
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  rejectionReason?: string;

  /** Per-user notification preferences (previously a UI-only toggle). */
  preferences: {
    notifyEmail: boolean;
    notifySms: boolean;
    notifyWhatsapp: boolean;
    notifyInApp: boolean;
    expiryReminderDays: number[];
    language: 'en' | 'hi';
  };

  /** Brute-force protection on password login. */
  failedLoginAttempts: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;

  createdAt: Date;
  updatedAt: Date;

  /** True when this account is permitted to hold a session. */
  canSignIn(): boolean;
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, sparse: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: ROLES,
      required: true,
      default: 'Owner',
    },

    state: { type: String, enum: [...INDIAN_STATES, ''], trim: true },
    district: { type: String, trim: true },
    additionalDistricts: [{ type: String, trim: true }],

    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },
    organizationName: { type: String, trim: true },

    gatcId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    categoriesApproved: [{ type: String, enum: INSTRUMENT_TYPES }],
    accreditationNo: { type: String, trim: true },
    accreditationValidUntil: { type: Date },

    officerCode: { type: String, trim: true, sparse: true },
    designation: { type: String, trim: true },

    aadhaarLinkedId: { type: String, trim: true, select: false },
    profilePhoto: { type: String },

    isActive: { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: false },
    isPhoneVerified: { type: Boolean, default: false },

    approvalStatus: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'APPROVED',
      index: true,
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectionReason: { type: String, trim: true },

    preferences: {
      notifyEmail: { type: Boolean, default: true },
      notifySms: { type: Boolean, default: false },
      notifyWhatsapp: { type: Boolean, default: true },
      notifyInApp: { type: Boolean, default: true },
      expiryReminderDays: { type: [Number], default: [60, 30, 7] },
      language: { type: String, enum: ['en', 'hi'], default: 'en' },
    },

    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

UserSchema.index({ role: 1 });
UserSchema.index({ state: 1, district: 1 });
UserSchema.index({ role: 1, approvalStatus: 1, isActive: 1 });

/** True when this account is permitted to hold a session. */
UserSchema.methods.canSignIn = function (this: IUser): boolean {
  if (!this.isActive) return false;
  if (this.approvalStatus !== 'APPROVED') return false;
  if (this.lockedUntil && this.lockedUntil.getTime() > Date.now()) return false;
  return true;
};

const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
export default User;
