import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Instrument from '@/models/Instrument';
import { handle, ok, requireAuth, BadRequest, NotFound } from '@/lib/rbac';
import { findApplicationForUser, transitionApplication, availableTransitions } from '@/lib/workflow';
import { issueCertificate, currentInspection, certificateQrDataUrl } from '@/lib/certificates';
import { computePriority } from '@/lib/risk';
import { notifications } from '@/lib/notify';
import { persistComplianceScore } from '@/lib/compliance';
import {
  APPLICATION_STATUSES,
  DOCUMENT_TYPES,
  type ApplicationStatus,
} from '@/lib/constants';

/**
 * The single endpoint through which an application's status changes.
 *
 * Previously `POST /api/tasks` did the whole officer flow in one shot — and did
 * it with **no role check at all**: any authenticated user, an Owner included,
 * could post `{ applicationId, verdict: 'Approve' }` and mint a real signed
 * certificate for someone else's instrument. It also wrote statuses directly,
 * with no legal-transition check and no history.
 *
 * Every transition now goes through `transitionApplication`, which validates
 * both that the move is legal and that this role may make it, and records it.
 *
 * Side effects attached to specific transitions live here, so they cannot drift
 * from the status they belong to:
 *   → QUERY_RAISED             append the query, notify the applicant
 *   → APPROVED / REJECTED      record the decision with a mandatory justification
 *   → CERTIFICATE_GENERATED    issue the signed certificate
 */

export const POST = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const user = await requireAuth();

  const app = await findApplicationForUser(id, user);
  if (!app) throw NotFound('No such application');

  const body = (await req.json()) as {
    to?: string;
    reason?: string;
    /** QUERY_RAISED only. */
    requestedDocuments?: string[];
    queryDueDays?: number;
    /** APPROVED / REJECTED only. */
    justification?: string;
    legalReference?: string;
  };

  const to = String(body.to ?? '').toUpperCase();
  if (!(APPLICATION_STATUSES as readonly string[]).includes(to)) {
    throw BadRequest(
      `Unknown target status "${body.to}". Available from ${app.status}: ${availableTransitions(app, user).join(', ') || 'none'}`,
      'UNKNOWN_STATUS'
    );
  }
  const target = to as ApplicationStatus;

  const reason = body.reason?.trim() || body.justification?.trim();

  /* --- QUERY_RAISED: the officer needs something from the applicant ------ */
  if (target === 'QUERY_RAISED') {
    if (!reason) {
      throw BadRequest(
        'Describe what the applicant needs to provide — a query with no message is not actionable',
        'REASON_REQUIRED'
      );
    }

    const requested = (body.requestedDocuments ?? []).filter((d) =>
      (DOCUMENT_TYPES as readonly string[]).includes(d)
    );

    app.queries = [
      ...(app.queries ?? []),
      {
        raisedBy: new Types.ObjectId(user.id),
        raisedAt: new Date(),
        message: reason,
        requestedDocuments: requested,
        dueBy: body.queryDueDays
          ? new Date(Date.now() + Math.max(1, body.queryDueDays) * 86_400_000)
          : undefined,
        responseDocumentIds: [],
      },
    ];
    app.markModified('queries');
  }

  /* --- APPROVED / REJECTED: a decision needs a written justification ---- */
  if (target === 'APPROVED' || target === 'REJECTED') {
    const justification = body.justification?.trim() || reason;
    if (!justification) {
      throw BadRequest(
        'A written justification is required for any decision on an application',
        'JUSTIFICATION_REQUIRED'
      );
    }

    // An approval must rest on a passed inspection — this is the check the old
    // route skipped entirely, so an application could be approved (and a
    // certificate signed) with no inspection on file at all.
    if (target === 'APPROVED') {
      const inspection = await currentInspection(app._id);
      if (!inspection) {
        throw BadRequest(
          'No submitted inspection exists for this application',
          'NO_INSPECTION'
        );
      }
      if (inspection.result !== 'PASS') {
        throw BadRequest(
          `The inspection result is ${inspection.result}. An application cannot be approved on an inspection that did not pass.`,
          'INSPECTION_NOT_PASSED'
        );
      }
    }

    app.decision = {
      outcome: target,
      decidedBy: new Types.ObjectId(user.id),
      decidedByRole: user.role,
      decidedAt: new Date(),
      justification,
      legalReference: body.legalReference?.trim(),
    };
  }

  const updated = await transitionApplication(app, target, user, {
    reason,
    headers: req.headers,
  });

  /* --- Post-transition side effects ------------------------------------- */

  let certificate: { id: string; certNo: string; expiryDate: Date; qrDataUrl: string } | undefined;

  if (target === 'QUERY_RAISED') {
    await notifications.queryRaised(
      String(app.ownerId),
      app.applicationNo,
      String(app._id),
      reason ?? ''
    );
  }

  if (target === 'APPROVED' || target === 'REJECTED') {
    await notifications.applicationDecided(
      String(app.ownerId),
      app.applicationNo,
      String(app._id),
      target,
      app.decision?.justification ?? ''
    );

    if (target === 'REJECTED') {
      // The instrument goes back to unverified, and the failure is counted so
      // the risk engine can see a repeat offender.
      await Instrument.findByIdAndUpdate(app.instrumentId, {
        status: 'REJECTED',
        $inc: { failedInspectionCount: 1 },
      });
    }
  }

  if (target === 'CERTIFICATE_GENERATED') {
    const inspection = await currentInspection(app._id);
    if (!inspection) throw BadRequest('No submitted inspection to certify', 'NO_INSPECTION');

    const cert = await issueCertificate({
      application: app,
      inspection: inspection as Parameters<typeof issueCertificate>[0]['inspection'],
      issuer: user,
      headers: req.headers,
    });

    certificate = {
      id: String(cert._id),
      certNo: cert.certNo,
      expiryDate: cert.expiryDate,
      qrDataUrl: await certificateQrDataUrl(cert.certNo),
    };

    // The application's own terminal state follows the certificate.
    await transitionApplication(app, 'ACTIVE', user, {
      isSystem: true,
      headers: req.headers,
    });
  }

  // Recompute the advisory queue priority whenever the stage changes, and the
  // owner's compliance score whenever the outcome does.
  if (!['APPROVED', 'REJECTED', 'CERTIFICATE_GENERATED', 'ACTIVE', 'CANCELLED'].includes(target)) {
    const priority = await computePriority(app._id);
    await app.updateOne({ priorityScore: priority.score, priorityReasons: priority.reasons });
  } else {
    await persistComplianceScore(app.ownerId, app.organizationId).catch((err) =>
      console.error('[transition] compliance score refresh failed', err)
    );
  }

  return ok({
    application: {
      id: String(app._id),
      applicationNo: app.applicationNo,
      status: updated.status,
    },
    certificate,
    availableTransitions: availableTransitions(app, user),
  });
});
