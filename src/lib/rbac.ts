import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import dbConnect from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import {
  ADMIN_ROLES,
  DECISION_ROLES,
  GLOBAL_SCOPE_ROLES,
  INSPECTOR_ROLES,
  OFFICIAL_ROLES,
  type Role,
} from '@/lib/constants';

/**
 * Central authorization layer.
 *
 * Before this existed, authorization was effectively "is there a session?" —
 * `/api/tasks` GET returned every application in the system to any signed-in
 * user (including other businesses' owner names, emails and phone numbers), and
 * its POST let *any* authenticated user, an Owner included, mint a signed
 * certificate. Role checks lived only in the UI, where they were bypassable by
 * typing a URL or calling the endpoint directly.
 *
 * Every route handler now starts with `requireAuth()` / `requireRole()` and
 * every list query is narrowed by `scopeFilter()`.
 */

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  state?: string;
  district?: string;
  organizationId?: string;
}

/** Thrown by the `require*` helpers; converted to a response by `handle()`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const Unauthorized = (msg = 'Authentication required') => new HttpError(401, msg, 'UNAUTHENTICATED');
export const Forbidden = (msg = 'You do not have permission to perform this action') =>
  new HttpError(403, msg, 'FORBIDDEN');
export const NotFound = (msg = 'Resource not found') => new HttpError(404, msg, 'NOT_FOUND');
export const BadRequest = (msg: string, code = 'BAD_REQUEST') => new HttpError(400, msg, code);
export const Conflict = (msg: string, code = 'CONFLICT') => new HttpError(409, msg, code);

/**
 * Resolves the current session into a typed user, connecting to the database as
 * a side effect so callers do not each have to remember to.
 */
export async function requireAuth(): Promise<AuthedUser> {
  const session = await auth();
  const user = session?.user as (AuthedUser & { id?: string }) | undefined;

  if (!user?.id) throw Unauthorized();

  await dbConnect();

  return {
    id: user.id,
    email: user.email ?? '',
    name: user.name ?? '',
    role: user.role,
    state: user.state,
    district: user.district,
    organizationId: user.organizationId,
  };
}

/** Like `requireAuth`, but returns null instead of throwing for public routes. */
export async function optionalAuth(): Promise<AuthedUser | null> {
  try {
    return await requireAuth();
  } catch {
    return null;
  }
}

/**
 * Requires one of `allowed`. Denials are written to the audit log — an attempt
 * by an Owner to reach an officer endpoint is exactly the signal an auditor
 * wants to see.
 */
export async function requireRole(allowed: Role[], action = 'authz.check'): Promise<AuthedUser> {
  const user = await requireAuth();

  if (!allowed.includes(user.role)) {
    await writeAudit({
      action,
      userId: user.id,
      userRole: user.role,
      userEmail: user.email,
      outcome: 'DENIED',
      details: `Role ${user.role} is not permitted; requires one of ${allowed.join(', ')}`,
    });
    throw Forbidden();
  }

  return user;
}

export const requireOfficial = (action?: string) => requireRole(OFFICIAL_ROLES, action);
export const requireAdmin = (action?: string) => requireRole(ADMIN_ROLES, action);
export const requireInspector = (action?: string) => requireRole(INSPECTOR_ROLES, action);
export const requireDecisionMaker = (action?: string) => requireRole(DECISION_ROLES, action);

/* ------------------------------------------------------------------ *
 * Data scoping
 * ------------------------------------------------------------------ */

export const isOfficial = (role: Role) => OFFICIAL_ROLES.includes(role);
export const hasGlobalScope = (role: Role) => GLOBAL_SCOPE_ROLES.includes(role);

/**
 * Builds the Mongo filter that limits a list query to what `user` may see.
 *
 * - Owner            → only their own records.
 * - LMO / GATC*      → only records inside their state (and district when set).
 * - StateAdmin       → only records inside their state.
 * - Admin            → everything.
 *
 * `fields` names the paths on the collection being queried, because
 * applications store jurisdiction under `jurisdiction.*` while instruments use
 * `installation*` and certificates use `instrumentSnapshot.*`.
 */
export function scopeFilter(
  user: AuthedUser,
  fields: {
    ownerField?: string;
    stateField?: string;
    districtField?: string;
    /** Set when officers should also see anything explicitly assigned to them. */
    assigneeField?: string;
  }
): Record<string, unknown> {
  const { ownerField, stateField, districtField, assigneeField } = fields;

  // Business users only ever see their own rows.
  if (!isOfficial(user.role)) {
    if (!ownerField) {
      // No ownership column to scope by — deny rather than leak.
      return { _id: { $exists: false } };
    }
    return { [ownerField]: user.id };
  }

  if (hasGlobalScope(user.role)) return {};

  // Officers are bound to their jurisdiction. An officer with no state set
  // would otherwise see the whole country, so treat that as "assigned only".
  const clauses: Record<string, unknown>[] = [];

  if (user.state && stateField) {
    const jurisdiction: Record<string, unknown> = { [stateField]: user.state };
    // A district-level officer sees their district; a state-level one sees all.
    if (user.district && districtField && user.role !== 'StateAdmin') {
      jurisdiction[districtField] = user.district;
    }
    clauses.push(jurisdiction);
  }

  if (assigneeField) clauses.push({ [assigneeField]: user.id });

  if (clauses.length === 0) return { _id: { $exists: false } };
  if (clauses.length === 1) return clauses[0];
  return { $or: clauses };
}

/** True when `user` may read/act on a single record. */
export function canAccessRecord(
  user: AuthedUser,
  record: {
    ownerId?: unknown;
    assignedTo?: unknown;
    state?: string;
    district?: string;
  }
): boolean {
  const ownerId = record.ownerId ? String(record.ownerId) : undefined;
  const assignedTo = record.assignedTo ? String(record.assignedTo) : undefined;

  if (ownerId && ownerId === user.id) return true;
  if (assignedTo && assignedTo === user.id) return true;

  if (!isOfficial(user.role)) return false;
  if (hasGlobalScope(user.role)) return true;

  if (!user.state) return false;
  if (record.state && record.state !== user.state) return false;

  if (user.role !== 'StateAdmin' && user.district && record.district && record.district !== user.district) {
    return false;
  }

  return true;
}

/** Throws 403/404 when the record is out of scope. */
export function assertCanAccess(
  user: AuthedUser,
  record: Parameters<typeof canAccessRecord>[1],
  what = 'record'
): void {
  if (!canAccessRecord(user, record)) {
    // 404 rather than 403 so out-of-jurisdiction ids are not enumerable.
    throw NotFound(`No such ${what}`);
  }
}

/* ------------------------------------------------------------------ *
 * Handler wrapper
 * ------------------------------------------------------------------ */

interface ErrorBody {
  success: false;
  error: string;
  code?: string;
}

/**
 * Wraps a route handler so thrown `HttpError`s become clean JSON responses and
 * unexpected errors are logged without leaking internals to the client.
 */
export function handle<T extends unknown[]>(
  fn: (...args: T) => Promise<NextResponse>
): (...args: T) => Promise<NextResponse> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) {
        const body: ErrorBody = { success: false, error: err.message, code: err.code };
        return NextResponse.json(body, { status: err.status });
      }

      // Mongo duplicate key.
      if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
        return NextResponse.json(
          { success: false, error: 'A record with these details already exists', code: 'DUPLICATE' },
          { status: 409 }
        );
      }

      // Mongoose validation.
      if (err instanceof Error && err.name === 'ValidationError') {
        return NextResponse.json(
          { success: false, error: err.message, code: 'VALIDATION_ERROR' },
          { status: 400 }
        );
      }

      console.error('[api] Unhandled error:', err);
      return NextResponse.json(
        { success: false, error: 'Internal server error', code: 'INTERNAL' },
        { status: 500 }
      );
    }
  };
}

/** Consistent success envelope. */
export function ok<T extends Record<string, unknown>>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, ...data }, { status });
}
