import { NextRequest } from 'next/server';
import OtpChallenge from '@/models/OtpChallenge';
import User from '@/models/User';
import dbConnect from '@/lib/db';
import { handle, ok, BadRequest, HttpError } from '@/lib/rbac';
import { verifyOTP } from '@/lib/twilio';
import { sha256Hex, randomToken, safeEqual } from '@/lib/utils';
import { writeAudit } from '@/lib/audit';

/**
 * Step 2 of phone login: check the code and mint a single-use login token.
 *
 * The client never learns *which* user it is about to be signed in as, and never
 * gets to say. It receives an opaque `loginToken`, which it hands to
 * `signIn('phone-otp', { loginToken })`; the NextAuth provider atomically burns
 * the token and resolves the user from the challenge record.
 *
 * This is the fix for the authentication bypass in the old flow: the previous
 * `phone-otp` provider took a `userId` straight from the client and signed that
 * account in, with no OTP check anywhere in the path.
 */

const LOGIN_TOKEN_TTL_MINUTES = 5;

export const POST = handle(async (req: NextRequest) => {
  await dbConnect();

  const body = (await req.json()) as { phone?: string; code?: string };
  const phone = body.phone?.trim();
  const code = body.code?.trim();

  if (!phone || !code) throw BadRequest('Both the phone number and the code are required', 'MISSING_FIELDS');
  if (!/^\d{4,8}$/.test(code)) throw BadRequest('The code should be the digits you were sent', 'INVALID_CODE_FORMAT');

  // The most recent live challenge for this number. `+codeHash` is needed because
  // the field is `select: false`.
  const challenge = await OtpChallenge.findOne({
    phone,
    purpose: 'LOGIN',
    verifiedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .select('+codeHash');

  if (!challenge) {
    await writeAudit({
      action: 'auth.otp.verify',
      outcome: 'FAILURE',
      details: 'No live OTP challenge for this number',
      headers: req.headers,
    });
    throw BadRequest(
      'That code has expired or was never requested. Request a new one.',
      'NO_CHALLENGE'
    );
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    // Retire the challenge so a fresh code is required, rather than leaving an
    // exhausted one around to be hammered further.
    challenge.expiresAt = new Date();
    await challenge.save();

    await writeAudit({
      action: 'auth.otp.verify',
      userId: String(challenge.userId),
      outcome: 'DENIED',
      details: `Too many incorrect codes (${challenge.attempts})`,
      headers: req.headers,
    });
    throw new HttpError(
      429,
      'Too many incorrect attempts. Request a new code.',
      'TOO_MANY_ATTEMPTS'
    );
  }

  challenge.attempts += 1;
  await challenge.save();

  // Twilio Verify holds the code; the mock provider's is hashed on the challenge.
  let valid: boolean;
  if (challenge.provider === 'twilio') {
    const result = await verifyOTP(phone, code);
    if (!result.success) {
      throw new HttpError(
        502,
        'The code could not be checked right now. Try again in a moment.',
        'OTP_CHECK_FAILED'
      );
    }
    valid = result.valid;
  } else {
    valid = Boolean(challenge.codeHash) && safeEqual(sha256Hex(code), challenge.codeHash!);
  }

  if (!valid) {
    await writeAudit({
      action: 'auth.otp.verify',
      userId: String(challenge.userId),
      outcome: 'FAILURE',
      details: `Incorrect code (attempt ${challenge.attempts} of ${challenge.maxAttempts})`,
      headers: req.headers,
    });
    return ok({
      valid: false,
      attemptsRemaining: Math.max(0, challenge.maxAttempts - challenge.attempts),
      error: 'That code is not correct.',
    });
  }

  // Re-check the account at the moment of sign-in: it may have been suspended
  // between the code being sent and the code being entered.
  const user = await User.findById(challenge.userId).select('_id role email isActive approvalStatus');
  if (!user || !user.canSignIn()) {
    await writeAudit({
      action: 'auth.otp.verify',
      userId: String(challenge.userId),
      outcome: 'DENIED',
      details: 'Correct code, but the account is not permitted to sign in',
      headers: req.headers,
    });
    throw new HttpError(
      403,
      'This account cannot sign in at the moment. Contact the Legal Metrology office.',
      'ACCOUNT_NOT_ACTIVE'
    );
  }

  const loginToken = randomToken(32);

  challenge.verifiedAt = new Date();
  challenge.loginTokenHash = sha256Hex(loginToken);
  challenge.loginTokenExpiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MINUTES * 60_000);
  challenge.loginTokenUsedAt = undefined;
  // The code has served its purpose; there is no reason to keep it.
  challenge.codeHash = undefined;
  await challenge.save();

  // The phone is now proven, which is worth persisting for notification routing.
  await User.updateOne({ _id: user._id }, { isPhoneVerified: true });

  await writeAudit({
    action: 'auth.otp.verify',
    userId: String(user._id),
    userRole: user.role,
    userEmail: user.email,
    outcome: 'SUCCESS',
    details: 'OTP verified; single-use login token issued',
    headers: req.headers,
  });

  return ok({
    valid: true,
    // Hand this straight to signIn('phone-otp', { loginToken }).
    loginToken,
    expiresInMinutes: LOGIN_TOKEN_TTL_MINUTES,
  });
});
