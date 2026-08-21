import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  role: 'Owner' | 'LMO' | 'GATC' | 'Admin';
  state?: string;
  district?: string;
  organizationName?: string; // For GATC
  categoriesApproved?: string[]; // For GATC
  aadhaarLinkedId?: string;
  profilePhoto?: string;
  isActive: boolean;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, sparse: true, trim: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ['Owner', 'LMO', 'GATC', 'Admin'],
      required: true,
      default: 'Owner',
    },
    state: { type: String, trim: true },
    district: { type: String, trim: true },
    organizationName: { type: String, trim: true },
    categoriesApproved: [{ type: String }],
    aadhaarLinkedId: { type: String, trim: true },
    profilePhoto: { type: String },
    isActive: { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: false },
    isPhoneVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ role: 1 });
UserSchema.index({ state: 1, district: 1 });

const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
export default User;
