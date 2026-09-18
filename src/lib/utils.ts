import crypto from 'crypto';

/**
 * Server-only helpers.
 *
 * This module imports `node:crypto`, so it must never be imported from a
 * `'use client'` component. Shared constants and display helpers that the UI
 * needs live in `src/lib/constants.ts` instead.
 *
 * `INDIAN_STATES`, `INSTRUMENT_TYPES` and `formatDate` are re-exported below for
 * backwards compatibility, but new code should import them from `constants.ts`.
 */

export {
  INDIAN_STATES,
  INSTRUMENT_TYPES,
  formatDate,
  formatDateTime,
  daysUntil,
} from './constants';

/* ------------------------------------------------------------------ *
 * Signing & integrity
 * ------------------------------------------------------------------ */

/** Identifier of the current signing key, stored on each certificate. */
export const SIGNING_KEY_ID = process.env.CERT_SIGNING_KEY_ID || 'v1';

function signingSecret(): string {
  const secret = process.env.CERT_SIGNING_SECRET;
  if (!secret) {
    // Refusing here is deliberate: silently falling back to a shared
    // 'default-secret' would make every signature forgeable by anyone who has
    // read this file, while still looking valid in the UI.
    throw new Error(
      'CERT_SIGNING_SECRET is not configured. Certificates cannot be signed or verified.'
    );
  }
  if (secret.length < 32) {
    throw new Error('CERT_SIGNING_SECRET must be at least 32 characters.');
  }
  return secret;
}

/** True when signing is configured, so callers can degrade gracefully. */
export function isSigningConfigured(): boolean {
  try {
    signingSecret();
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the canonical string that gets hashed and signed.
 *
 * Field order is fixed and every value is length-prefixed, so two different
 * payloads can never serialise to the same string (previously the payload was a
 * `:`-joined template literal, which is ambiguous if any field contains a `:`).
 */
export function buildCertificatePayload(fields: {
  certNo: string;
  instrumentId: string;
  ownerId: string;
  serialNo: string;
  issuedDate: Date | string;
  expiryDate: Date | string;
  issuedBy: string;
  version: number;
}): string {
  const parts: [string, string][] = [
    ['certNo', fields.certNo],
    ['instrumentId', fields.instrumentId],
    ['ownerId', fields.ownerId],
    ['serialNo', fields.serialNo],
    ['issuedDate', new Date(fields.issuedDate).toISOString()],
    ['expiryDate', new Date(fields.expiryDate).toISOString()],
    ['issuedBy', fields.issuedBy],
    ['version', String(fields.version)],
  ];
  return parts.map(([k, v]) => `${k}=${v.length}:${v}`).join('|');
}

/** SHA-256 digest, hex encoded. */
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** HMAC-SHA256 over `data`, hex encoded. */
export function signCertificateData(data: string): string {
  return crypto.createHmac('sha256', signingSecret()).update(data).digest('hex');
}

/**
 * Constant-time signature comparison.
 *
 * The previous implementation passed both buffers straight to
 * `crypto.timingSafeEqual`, which **throws a RangeError** when the lengths
 * differ rather than returning false — so any malformed signature crashed the
 * request instead of failing verification.
 */
export function verifyCertificateSignature(data: string, signature: string): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false;

  let expected: string;
  try {
    expected = signCertificateData(data);
  } catch {
    return false;
  }

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/** Verifies a Razorpay payment signature (HMAC-SHA256 of `orderId|paymentId`). */
export function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 * Tokens & hashing
 * ------------------------------------------------------------------ */

/** Cryptographically random URL-safe token. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Random numeric OTP of the requested length, using rejection-free sampling. */
export function randomNumericCode(length = 6): string {
  let out = '';
  while (out.length < length) {
    out += crypto.randomInt(0, 10).toString();
  }
  return out;
}

/**
 * Hashes a request IP for storage.
 *
 * A daily salt means the same visitor is linkable within a day (enough for
 * rate-limiting and spotting probing) but not indefinitely.
 */
export function hashRequesterIp(ip: string | null | undefined): string | undefined {
  if (!ip) return undefined;
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.NEXTAUTH_SECRET || 'vtula';
  return sha256Hex(`${ip}|${day}|${salt}`).slice(0, 32);
}

/** Constant-time comparison of two hex/ascii strings of arbitrary length. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a ?? '', 'utf8');
  const bufB = Buffer.from(b ?? '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

/** Adds `months` to `date`, clamping the day so 31 Jan + 1 month = 28/29 Feb. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const targetDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const daysInTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(targetDay, daysInTargetMonth));
  return result;
}

/** Extracts the client IP from a request's forwarding headers. */
export function clientIpFromHeaders(headers: Headers): string | undefined {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return headers.get('x-real-ip') ?? undefined;
}
