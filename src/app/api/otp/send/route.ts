import { NextRequest } from 'next/server';
import OtpChallenge from '@/models/OtpChallenge';
import User from '@/models/User';
import dbConnect from '@/lib/db';
import { handle, ok, BadRequest, HttpError } from '@/lib/rbac';
import { sendOTP, otpProvider, DEV_MOCK_OTP } from '@/lib/twilio';
import { sha256Hex, clientIpFromHeaders, hashRequesterIp } from '@/lib/utils';
import { writeAudit } from '@/lib/audit';

/**
 * Step 1 of phone login: create a server-side challenge and send the code.
 *
 * What this replaces: the old route took any phone number, asked Twilio to send
 * a code, and returned success. Nothing was recorded server-side, so
 * `/api/otp/verify` had nothing to verify *against* — and the NextAuth
 * `phone-otp` provider ended up trusting a client-supplied `userId` instead,
 * which was a complete authentication bypass.
 *
 * Deliberate behaviours:
 *  - **The response never reveals whether the number is registered.** An
 *    unregistered number gets the same `{ sent: true }` shape, because this
 *    endpoint is unauthenticated and would otherwise be a free account-enumeration
 *    oracle.
 *  - **Rate limited per number and per requester**, so it cannot be used to spam
 *    someone's phone or to burn the department's SMS budget.
 */

const OTP_TTL_MINUTES = 10;
const MAX_SENDS_PER_HOUR_PER_PHONE = 5;
const MAX_SENDS_PER_HOUR_PER_IP = 15;
const RESEND_COOLDOWN_SECONDS = 45;

export const POST = handle(async (req: NextRequest) => {
  await dbConnect();

  const body = (await req.json()) as { phone?: string; channel?: string };
  const phone = body.phone?.trim();

  if (!phone) throw BadRequest('A phone number is required', 'PHONE_REQUIRED');

  // E.164, which is what Twilio Verify and the WhatsApp Cloud API both require.
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw BadRequest(
      'Enter the number in international format, for example +919876543210',
      'INVALID_PHONE'
    );
  }

  const channel = body.channel === 'whatsapp' ? 'whatsapp' : 'sms';
  const ipHash = hashRequesterIp(clientIpFromHeaders(req.headers));
  const hourAgo = new Date(Date.now() - 3_600_000);

  const [recentForPhone, recentForIp, lastSend] = await Promise.all([
    OtpChallenge.countDocuments({ phone, createdAt: { $gte: hourAgo } }),
    ipHash
      ? OtpChallenge.countDocuments({ requestIpHash: ipHash, createdAt: { $gte: hourAgo } })
      : 0,
    OtpChallenge.findOne({ phone }).sort({ createdAt: -1 }).select('createdAt'),
  ]);

  if (recentForPhone >= MAX_SENDS_PER_HOUR_PER_PHONE || recentForIp >= MAX_SENDS_PER_HOUR_PER_IP) {
    throw new HttpError(
      429,
      'Too many verification codes requested. Wait an hour, or sign in with your email and password.',
      'RATE_LIMITED'
    );
  }

  if (lastSend && Date.now() - lastSend.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
    const wait = Math.ceil(
      (RESEND_COOLDOWN_SECONDS * 1000 - (Date.now() - lastSend.createdAt.getTime())) / 1000
    );
    throw new HttpError(429, `A code was just sent. Try again in ${wait} seconds.`, 'COOLDOWN');
  }

  const user = await User.findOne({ phone }).select('_id isActive approvalStatus role email');

  // No account: record the attempt, send nothing, and return the same shape.
  if (!user) {
    await writeAudit({
      action: 'auth.otp.send',
      outcome: 'DENIED',
      details: 'OTP requested for a phone number with no account',
      headers: req.headers,
    });
    return ok({
      sent: true,
      channel,
      provider: otpProvider(),
      expiresInMinutes: OTP_TTL_MINUTES,
    });
  }

  if (!user.canSignIn()) {
    await writeAudit({
      action: 'auth.otp.send',
      userId: String(user._id),
      userRole: user.role,
      userEmail: user.email,
      outcome: 'DENIED',
      details: user.isActive
        ? `Account approval status is ${user.approvalStatus}`
        : 'Account is deactivated',
      headers: req.headers,
    });
    return ok({
      sent: true,
      channel,
      provider: otpProvider(),
      expiresInMinutes: OTP_TTL_MINUTES,
    });
  }

  const provider = otpProvider();

  // With Twilio Verify the code lives on Twilio's side and we never see it. The
  // mock provider is the only path that stores a hash, and only outside
  // production — see `src/lib/twilio.ts`.
  const localCode = provider === 'mock' ? DEV_MOCK_OTP : undefined;

  const challenge = await OtpChallenge.create({
    phone,
    userId: user._id,
    purpose: 'LOGIN',
    provider,
    codeHash: localCode ? sha256Hex(localCode) : undefined,
    expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000),
    requestIpHash: ipHash,
  });

  const result = await sendOTP(phone, channel);

  if (!result.success) {
    await OtpChallenge.deleteOne({ _id: challenge._id });
    await writeAudit({
      action: 'auth.otp.send',
      userId: String(user._id),
      userRole: user.role,
      outcome: 'FAILURE',
      details: `Delivery failed: ${result.error ?? 'unknown error'}`,
      headers: req.headers,
    });
    throw new HttpError(
      502,
      'The verification code could not be sent right now. Try again, or sign in with your email and password.',
      'OTP_SEND_FAILED'
    );
  }

  await writeAudit({
    action: 'auth.otp.send',
    userId: String(user._id),
    userRole: user.role,
    userEmail: user.email,
    outcome: 'SUCCESS',
    details: `Code sent via ${channel} (${provider})`,
    headers: req.headers,
  });

  return ok({
    sent: true,
    channel,
    provider,
    challengeId: String(challenge._id),
    expiresInMinutes: OTP_TTL_MINUTES,
    // Surfaced only so the login screen can say "development mode: use 123456"
    // instead of leaving a demo reviewer stuck. Never set in production.
    devHint: provider === 'mock' ? localCode : undefined,
  });
});
