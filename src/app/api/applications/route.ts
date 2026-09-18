import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Application from '@/models/Application';
import Instrument from '@/models/Instrument';
import User from '@/models/User';
import Certificate from '@/models/Certificate';
import {
  handle,
  ok,
  requireAuth,
  scopeFilter,
  BadRequest,
  Conflict,
  NotFound,
  isOfficial,
} from '@/lib/rbac';
import { resolveRule, computeFee, computeDueDate } from '@/lib/rules';
import { transitionApplication } from '@/lib/workflow';
import { computePriority } from '@/lib/risk';
import { notifications, notifyOfficers } from '@/lib/notify';
import { auditAction } from '@/lib/audit';
import { generateApplicationNo } from '@/lib/ids';
import {
  APPLICATION_STATUSES,
  OFFICER_QUEUE_STATUSES,
  OPEN_APPLICATION_STATUSES,
  VERIFICATION_TYPES,
  type ApplicationStatus,
  type VerificationType,
} from '@/lib/constants';

/**
 * Applications collection.
 *
 * What this replaces:
 *  - GET scoped by an ad-hoc `if (role === 'Owner')` chain in which an
 *    unrecognised role fell through to `query = {}` — every application in the
 *    country. Scoping now goes through `scopeFilter`.
 *  - POST trusted the client for money: `feeStatus: feeStatus || (paymentId ? 'Paid' : 'Unpaid')`,
 *    so a caller could POST `feeStatus: 'Paid'` and skip payment entirely. The
 *    fee is now computed from the applicable rule and the status is only ever
 *    written by the payment-verification route.
 *  - POST created the application already `submittedDate`-stamped with no state
 *    machine. It now creates a DRAFT and runs `DRAFT → SUBMITTED` through
 *    `transitionApplication`, so the status history, audit entry and instrument
 *    timeline all exist.
 */

const MAX_PAGE_SIZE = 100;

export const GET = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const sp = req.nextUrl.searchParams;

  const scope = scopeFilter(user, {
    ownerField: 'ownerId',
    stateField: 'jurisdiction.state',
    districtField: 'jurisdiction.district',
    assigneeField: 'assignedTo',
  });

  const query: Record<string, unknown> = { ...scope };

  // `status` accepts a comma-separated list; `queue` is the officer shorthand.
  const statusParam = sp.get('status');
  if (statusParam) {
    const wanted = statusParam
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is ApplicationStatus =>
        (APPLICATION_STATUSES as readonly string[]).includes(s)
      );
    if (wanted.length > 0) query.status = { $in: wanted };
  } else if (sp.get('queue') === 'officer') {
    query.status = { $in: OFFICER_QUEUE_STATUSES };
  }

  if (sp.get('assignedToMe') === 'true') query.assignedTo = new Types.ObjectId(user.id);
  if (sp.get('instrumentId')) query.instrumentId = sp.get('instrumentId');

  const type = sp.get('type');
  if (type && (VERIFICATION_TYPES as readonly string[]).includes(type)) query.type = type;

  const search = sp.get('search')?.trim();
  if (search) {
    // Application numbers only — searching owner names here would let an officer
    // probe for businesses outside their jurisdiction by trial and error.
    query.applicationNo = { $regex: escapeRegex(search), $options: 'i' };
  }

  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(sp.get('limit')) || 50));
  const page = Math.max(1, Number(sp.get('page')) || 1);

  // Counts for the caller's status filters, built from the same query with the
  // status narrowing dropped. Counting the fetched page instead would make a
  // status filter's own count change the moment it was applied.
  const countQuery = { ...query };
  delete countQuery.status;

  const [applications, total, counts] = await Promise.all([
    Application.find(query)
      .populate('instrumentId', 'type brand model serialNo capacity installationState installationDistrict address')
      .populate('assignedTo', 'name role designation')
      // Officers work the highest-priority item first; owners see newest first.
      .sort(isOfficial(user.role) ? { priorityScore: -1, createdAt: -1 } : { createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Application.countDocuments(query),
    Application.aggregate<{ _id: string; count: number }>([
      { $match: countQuery },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  // Owner-facing lists show the applicant's own contact details only; officer
  // lists need the owner name to work a queue, so it is populated separately.
  if (isOfficial(user.role)) {
    await Application.populate(applications, {
      path: 'ownerId',
      select: 'name organizationName phone email',
    });
  }

  return ok({
    applications,
    total,
    page,
    limit,
    countsByStatus: Object.fromEntries(counts.map((c) => [c._id, c.count])),
  });
});

export const POST = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const body = (await req.json()) as {
    instrumentId?: string;
    type?: string;
    inspectionLocation?: string;
    preferredDate?: string;
    remarks?: string;
    documentIds?: string[];
    /** When false the application is left as a DRAFT the owner can finish later. */
    submit?: boolean;
  };

  if (user.role !== 'Owner') {
    // An officer filing on a business's behalf is a separate, audited flow that
    // does not exist yet; blocking it is safer than guessing the owner.
    throw BadRequest(
      'Only a business owner account can file a verification application',
      'OWNER_ONLY'
    );
  }

  const { instrumentId, type } = body;
  if (!instrumentId || !Types.ObjectId.isValid(instrumentId)) {
    throw BadRequest('A valid instrument must be selected', 'INSTRUMENT_REQUIRED');
  }
  if (!type || !(VERIFICATION_TYPES as readonly string[]).includes(type)) {
    throw BadRequest(
      `Verification type must be one of: ${VERIFICATION_TYPES.join(', ')}`,
      'INVALID_TYPE'
    );
  }
  const verificationType = type as VerificationType;

  const instrument = await Instrument.findOne({ _id: instrumentId, ownerId: user.id });
  if (!instrument) throw NotFound('No such instrument in your account');

  if (instrument.isDecommissioned) {
    throw BadRequest(
      'This instrument is decommissioned and cannot be submitted for verification',
      'INSTRUMENT_DECOMMISSIONED'
    );
  }

  // One live application per instrument, or the officer queue fills with
  // duplicates of the same job.
  const existing = await Application.findOne({
    instrumentId,
    status: { $in: [...OPEN_APPLICATION_STATUSES] },
  }).select('applicationNo status');

  if (existing) {
    throw Conflict(
      `Application ${existing.applicationNo} is already open for this instrument (status: ${existing.status})`,
      'APPLICATION_ALREADY_OPEN'
    );
  }

  // `initial` is only honest the first time; after that it is a re-verification.
  const priorCertificates = await Certificate.countDocuments({ instrumentId });
  const effectiveType: VerificationType =
    verificationType === 'initial' && priorCertificates > 0 ? 'reverification' : verificationType;

  const rule = await resolveRule(instrument.installationState, instrument.type);
  const fee = computeFee(rule, effectiveType);

  const owner = await User.findById(user.id).select('organizationId').lean<{
    organizationId?: Types.ObjectId;
  }>();

  const application = await Application.create({
    applicationNo: await generateApplicationNo(),
    instrumentId: instrument._id,
    ownerId: new Types.ObjectId(user.id),
    organizationId: instrument.organizationId ?? owner?.organizationId,

    type: effectiveType,
    status: 'DRAFT',

    jurisdiction: {
      state: instrument.installationState,
      district: instrument.installationDistrict,
    },

    appliedRuleId: rule.ruleId ? new Types.ObjectId(rule.ruleId) : undefined,
    appliedRuleSnapshot: {
      validityMonths: rule.validityMonths,
      feeBase: rule.fee.base,
      requiredDocuments: rule.requiredDocuments,
      legalReference: rule.legalReference,
    },

    // Server-computed. `feeStatus` stays Unpaid until /api/payments/verify says
    // otherwise — the client cannot set it.
    feeAmount: fee,
    feePaid: 0,
    feeStatus: fee === 0 ? 'Waived' : 'Unpaid',

    inspectionLocation:
      body.inspectionLocation?.trim() ||
      `${instrument.address}, ${instrument.installationDistrict}, ${instrument.installationState}`,
    preferredDate: parseDate(body.preferredDate),
    remarks: body.remarks?.trim() ?? '',
    documentIds: (body.documentIds ?? [])
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id)),

    dueDate: computeDueDate(rule),
    statusHistory: [{ to: 'DRAFT', actorId: new Types.ObjectId(user.id), actorRole: user.role, isSystem: false, at: new Date() }],
  });

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    'application.create',
    { type: 'Application', id: application._id, label: application.applicationNo },
    {
      details: `${effectiveType} for ${instrument.type} ${instrument.serialNo}; fee ₹${fee} (rule: ${rule.matchedScope})`,
      headers: req.headers,
    }
  );

  // Submitting is a distinct step so the owner can save a draft and attach
  // documents before it enters the officer queue.
  if (body.submit !== false) {
    const priority = await computePriority(application._id);

    await transitionApplication(application, 'SUBMITTED', user, {
      patch: {
        priorityScore: priority.score,
        priorityReasons: priority.reasons,
      },
      headers: req.headers,
    });

    if (instrument.status === 'REGISTERED' || instrument.status === 'EXPIRED' || instrument.status === 'EXPIRING_SOON') {
      instrument.status = 'PENDING_VERIFICATION';
      await instrument.save();
    }

    await Promise.all([
      notifications.applicationSubmitted(
        user.id,
        application.applicationNo,
        String(application._id)
      ),
      notifyOfficers(
        { state: instrument.installationState, district: instrument.installationDistrict },
        ['LMO', 'StateAdmin'],
        {
          type: 'info',
          title: 'New application to review',
          message: `${application.applicationNo} (${instrument.type}, ${instrument.installationDistrict}) is awaiting review.`,
          relatedModel: 'Application',
          relatedId: String(application._id),
          actionUrl: `/dashboard/applications/${application._id}`,
          actionLabel: 'Review application',
          dedupeKey: `new-app:${application._id}`,
        }
      ),
    ]);
  }

  return ok(
    {
      application: {
        id: String(application._id),
        applicationNo: application.applicationNo,
        status: application.status,
        feeAmount: application.feeAmount,
        feeStatus: application.feeStatus,
        type: application.type,
        dueDate: application.dueDate,
        appliedRule: {
          name: rule.name,
          matchedScope: rule.matchedScope,
          validityMonths: rule.validityMonths,
          legalReference: rule.legalReference,
        },
      },
    },
    201
  );
});

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
