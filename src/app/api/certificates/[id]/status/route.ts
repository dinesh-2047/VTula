import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Certificate from '@/models/Certificate';
import { handle, ok, requireRole, BadRequest, NotFound, canAccessRecord } from '@/lib/rbac';
import {
  suspendCertificate,
  reinstateCertificate,
  revokeCertificate,
  effectiveStatus,
} from '@/lib/certificates';
import { DECISION_ROLES } from '@/lib/constants';

/**
 * Suspension, reinstatement and revocation.
 *
 * These are the only ways a live certificate's status changes by human decision,
 * and none of them existed before — the schema had no representation for
 * suspension at all, so a certificate found to be non-compliant after issue could
 * only be left standing or deleted outright.
 *
 * Restricted to decision-making roles (LMO / StateAdmin / Admin). A GATC
 * technician performs inspections but does not withdraw a certificate.
 *
 * Every action requires a written reason, which is recorded in the certificate's
 * public history — a business must be able to see why its certificate was
 * withdrawn, and a citizen scanning the QR must see that it was.
 *
 * Note on scope: this endpoint records a departmental decision. It does not
 * itself adjudicate anything — the officer's reason and legal reference are
 * stored verbatim, and the platform makes no finding of its own.
 */

type Action = 'suspend' | 'reinstate' | 'revoke';

export const POST = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const user = await requireRole(DECISION_ROLES, 'certificate.status');

  if (!Types.ObjectId.isValid(id)) throw NotFound('No such certificate');

  const cert = await Certificate.findById(id);
  if (!cert) throw NotFound('No such certificate');

  // A state officer may only act on certificates issued in their jurisdiction.
  const inScope = canAccessRecord(user, {
    ownerId: cert.ownerId,
    state: cert.instrumentSnapshot?.installationState,
    district: cert.instrumentSnapshot?.installationDistrict,
    assignedTo: cert.issuedBy,
  });
  if (!inScope) throw NotFound('No such certificate');

  const body = (await req.json()) as {
    action?: string;
    reason?: string;
    /** Suspension only — when the suspension lapses automatically. */
    until?: string;
    /** Revocation only — the provision relied on, e.g. "LM Act 2009, s.24". */
    legalReference?: string;
  };

  const action = String(body.action ?? '').toLowerCase() as Action;
  if (!['suspend', 'reinstate', 'revoke'].includes(action)) {
    throw BadRequest('Action must be one of: suspend, reinstate, revoke', 'INVALID_ACTION');
  }

  const reason = body.reason?.trim();
  if (!reason || reason.length < 10) {
    throw BadRequest(
      'A written reason of at least 10 characters is required — it is shown to the business and on the public verification page',
      'REASON_REQUIRED'
    );
  }

  const doc = cert as unknown as Parameters<typeof suspendCertificate>[0];

  if (action === 'suspend') {
    const until = body.until ? new Date(body.until) : undefined;
    if (until && Number.isNaN(until.getTime())) {
      throw BadRequest('The suspension end date is not a valid date', 'INVALID_DATE');
    }
    if (until && until.getTime() <= Date.now()) {
      throw BadRequest('A suspension cannot end in the past', 'INVALID_DATE');
    }
    await suspendCertificate(doc, user, reason, until, req.headers);
  } else if (action === 'reinstate') {
    await reinstateCertificate(doc, user, reason, req.headers);
  } else {
    await revokeCertificate(doc, user, reason, body.legalReference?.trim(), req.headers);
  }

  return ok({
    certificate: {
      id: String(cert._id),
      certNo: cert.certNo,
      status: cert.status,
      effectiveStatus: effectiveStatus(cert),
    },
  });
});
