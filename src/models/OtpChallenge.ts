import mongoose, { Schema, Model, Document, Types } from 'mongoose';

/**
 * Server-side OTP challenge.
 *
 * Fixes an authentication bypass: the `phone-otp` NextAuth provider previously
 * accepted a raw `userId` from the client and signed that user in with no proof
 * that the caller had ever received — let alone entered — an OTP. Anyone who
 * knew (or guessed) a user id could log in as them.
 *
 * The flow is now:
 *   1. POST /api/otp/send   → creates a challenge, sends the code.
 *   2. POST /api/otp/verify → validates the code, marks the challenge consumed
 *                             and returns a single-use, short-lived `loginToken`.
 *   3. signIn('phone-otp', { loginToken }) → the provider looks the token up,
 *                             burns it, and only then resolves the user.
 *
 * The client never gets to choose *which* user is signed in.
 */
export interface IOtpChallenge extends Document {
  phone: string;
  userId: Types.ObjectId;

  purpose: 'LOGIN' | 'PHONE_VERIFY';

  /** SHA-256 of the OTP. Only used by the dev/mock provider; Twilio Verify keeps its own. */
  codeHash?: string;

  /** Which provider issued the code. */
  provider: 'twilio' | 'mock';

  attempts: number;
  maxAttempts: number;

  /** Set once the correct code has been supplied. */
  verifiedAt?: Date;

  /**
   * Single-use bearer token handed to the client after successful verification
   * and exchanged for a session. Stored hashed.
   */
  loginTokenHash?: string;
  loginTokenExpiresAt?: Date;
  loginTokenUsedAt?: Date;

  /** TTL — Mongo removes the document once this passes. */
  expiresAt: Date;

  requestIpHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OtpChallengeSchema = new Schema<IOtpChallenge>(
  {
    phone: { type: String, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    purpose: { type: String, enum: ['LOGIN', 'PHONE_VERIFY'], default: 'LOGIN' },

    codeHash: { type: String, select: false },
    provider: { type: String, enum: ['twilio', 'mock'], default: 'mock' },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },

    verifiedAt: { type: Date },

    loginTokenHash: { type: String, index: true, sparse: true, select: false },
    loginTokenExpiresAt: { type: Date },
    loginTokenUsedAt: { type: Date },

    expiresAt: { type: Date, required: true },

    requestIpHash: { type: String, index: true },
  },
  { timestamps: true }
);

// Mongo TTL monitor deletes expired challenges automatically.
OtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OtpChallenge: Model<IOtpChallenge> =
  (mongoose.models.OtpChallenge as Model<IOtpChallenge>) ||
  mongoose.model<IOtpChallenge>('OtpChallenge', OtpChallengeSchema);

export default OtpChallenge;
