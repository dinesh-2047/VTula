import { Types } from 'mongoose';
import AuditLog from '@/models/AuditLog';
import { clientIpFromHeaders } from '@/lib/utils';

/**
 * Audit trail writer.
 *
 * The `AuditLog` model existed but nothing in the codebase ever wrote to it, so
 * there was no record of who approved what, who issued a certificate, or who
 * tried and failed. Every privileged action now calls this.
 *
 * Writes are best-effort: an audit failure must never take down the operation
 * being audited, but it is logged loudly so it does not pass unnoticed.
 */

export interface AuditInput {
  action: string;
  userId?: string | Types.ObjectId | null;
  /** Omitted for public/unauthenticated actions such as a QR verification. */
  userRole?: string;
  userEmail?: string;
  details?: string;
  changes?: Record<string, unknown>;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  resourceType?: string;
  resourceId?: string | Types.ObjectId | null;
  resourceLabel?: string;
  /** Pass the incoming request's headers to capture IP / user-agent. */
  headers?: Headers;
}

/** Keys whose values are stripped before being persisted. */
const REDACT_KEYS = [
  'password',
  'passwordhash',
  'passwordHash',
  'token',
  'logintoken',
  'loginToken',
  'signature',
  'paymentsignature',
  'paymentSignature',
  'secret',
  'otp',
  'code',
  'codehash',
  'aadhaar',
  'aadhaarlinkedid',
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.includes(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

function toObjectId(value: string | Types.ObjectId | null | undefined): Types.ObjectId | undefined {
  if (!value) return undefined;
  if (value instanceof Types.ObjectId) return value;
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : undefined;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      action: input.action,
      userId: toObjectId(input.userId),
      userRole: input.userRole || 'PUBLIC',
      userEmail: input.userEmail,
      details: input.details ?? '',
      changes: input.changes ? (redact(input.changes) as Record<string, unknown>) : undefined,
      outcome: input.outcome ?? 'SUCCESS',
      ipAddress: input.headers ? clientIpFromHeaders(input.headers) : undefined,
      userAgent: input.headers?.get('user-agent') ?? undefined,
      resourceType: input.resourceType,
      resourceId: toObjectId(input.resourceId),
      resourceLabel: input.resourceLabel,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log entry:', input.action, err);
  }
}

/** Convenience wrapper for the common "actor did X to resource Y" shape. */
export async function auditAction(
  actor: { id: string; role: string; email?: string },
  action: string,
  resource: { type: string; id?: string | Types.ObjectId | null; label?: string },
  opts: { details?: string; changes?: Record<string, unknown>; headers?: Headers; outcome?: AuditInput['outcome'] } = {}
): Promise<void> {
  await writeAudit({
    action,
    userId: actor.id,
    userRole: actor.role,
    userEmail: actor.email,
    resourceType: resource.type,
    resourceId: resource.id,
    resourceLabel: resource.label,
    ...opts,
  });
}
