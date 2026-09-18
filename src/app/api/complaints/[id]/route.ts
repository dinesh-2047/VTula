import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import Complaint from '@/models/Complaint';
import User from '@/models/User';
import {
  handle,
  ok,
  requireOfficial,
  scopeFilter,
  NotFound,
  BadRequest,
} from '@/lib/rbac';
import { auditAction } from '@/lib/audit';
import { notify } from '@/lib/notify';
import {
  transitionComplaint,
  nextComplaintStatuses,
} from '@/lib/complaints';
import {
  COMPLAINT_STATUSES,
  COMPLAINT_STATUS_LABELS,
  type ComplaintStatus,
} from '@/lib/constants';

/**
 * A single complaint, for the officer handling it.
 *
 * `GET` returns the full record including the complainant's contact details —
 * the whole point of the intake form is that somebody can ring them back — and
 * evidence metadata without the inline bytes.
 *
 * `PATCH` moves the complaint through its statuses. It is the only writer.
 */

export const dynamic = 'force-dynamic';

async function loadForOfficer(id: string, user: Awaited<ReturnType<typeof requireOfficial>>) {
  if (!Types.ObjectId.isValid(id)) return null;

  const complaint = await Complaint.findById(id);
  if (!complaint) return null;

  /*
   * 404 rather than 403 for a complaint outside the officer's jurisdiction. A 403
   * confirms the record exists, which for a complaint means confirming that
   * someone has reported a named business — that is exactly what must not leak
   * across district boundaries.
   */
  const scoped = scopeFilter(user, {
    stateField: 'against.state',
    districtField: 'against.district',
    assigneeField: 'assignedTo',
  });

  const visible = await Complaint.exists({ _id: complaint._id, ...scoped });
  return visible ? complaint : null;
}

export const GET = handle(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireOfficial('complaints.read');
  const { id } = await ctx.params;

  const complaint = await loadForOfficer(id, user);
  if (!complaint) throw NotFound('Complaint not found');

  // Mongoose's own `toObject()` type is precise enough; casting it at a
  // `Record<string, unknown>` only made TypeScript complain about the missing
  // index signature it never needed.
  const obj = complaint.toObject();

  // Metadata only: the bytes are served one at a time by the evidence route so a
  // detail page never carries several videos inline.
  const evidence = (obj.evidence ?? []).map((e, index) => ({
    index,
    fileName: e.fileName,
    mimeType: e.mimeType,
    sizeBytes: e.sizeBytes,
    sha256: e.sha256,
    kind: e.kind,
    uploadedAt: e.uploadedAt,
    url: e.storage === 'cloudinary' ? e.url : `/api/complaints/${id}/evidence/${index}`,
  }));

  const assignee = complaint.assignedTo
    ? await User.findById(complaint.assignedTo).select('name email role district').lean()
    : null;

  return ok({
    complaint: { ...obj, evidence, submitterHash: undefined },
    assignee,
    /*
     * The server decides what this officer may do next; the page renders the
     * answer. The alternative — the UI computing its own transition list — is how
     * a button appears for an action the API then refuses.
     */
    availableTransitions: nextComplaintStatuses(complaint.status).map((s) => ({
      status: s,
      label: COMPLAINT_STATUS_LABELS[s],
    })),
  });
});

export const PATCH = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireOfficial('complaints.update');
  const { id } = await ctx.params;

  const complaint = await loadForOfficer(id, user);
  if (!complaint) throw NotFound('Complaint not found');

  const body = (await req.json()) as {
    status?: string;
    internalNote?: string;
    publicNote?: string;
    assignTo?: string;
    priority?: string;
  };

  if (body.priority && !body.status) {
    // A priority change on its own is not a transition and writes no history.
    complaint.priority = body.priority;
    await complaint.save();
    await auditAction(
      { id: user.id, role: user.role, email: user.email },
      'complaint.reprioritise',
      { type: 'EnforcementCase', id: complaint._id, label: complaint.complaintNo },
      { details: `priority → ${body.priority}`, headers: req.headers }
    );
    return ok({ complaint: { _id: complaint._id, priority: complaint.priority } });
  }

  const to = body.status;
  if (!to || !COMPLAINT_STATUSES.includes(to as ComplaintStatus)) {
    throw BadRequest('Choose a valid status to move this complaint to.');
  }

  let assignTo = body.assignTo;
  if (to === 'ASSIGNED') {
    /*
     * Assigning to nobody is the default an officer means when they pick up a
     * complaint themselves, so an absent `assignTo` assigns it to them rather
     * than being an error.
     */
    assignTo = assignTo || user.id;

    const target = await User.findById(assignTo).select('role state district isActive').lean<{
      role: string;
      state?: string;
      district?: string;
      isActive: boolean;
    }>();
    if (!target || !target.isActive) throw BadRequest('That officer account is not available.');
    if (!['LMO', 'GATC', 'GATCTechnician', 'StateAdmin', 'Admin'].includes(target.role)) {
      throw BadRequest('A complaint can only be assigned to an officer.');
    }
  }

  const before = complaint.status;

  await transitionComplaint({
    complaint,
    to: to as ComplaintStatus,
    actor: { id: user.id, role: user.role },
    internalNote: body.internalNote,
    publicNote: body.publicNote,
    assignTo,
  });

  await auditAction(
    { id: user.id, role: user.role, email: user.email },
    'complaint.transition',
    { type: 'EnforcementCase', id: complaint._id, label: complaint.complaintNo },
    {
      details: `${before} → ${to}${body.publicNote ? `: ${body.publicNote}` : ''}`,
      changes: { from: before, to, assignTo },
      headers: req.headers,
    }
  );

  // Tell the assignee, unless they assigned it to themselves.
  if (to === 'ASSIGNED' && assignTo && assignTo !== user.id) {
    await notify({
      userId: assignTo,
      type: 'warning',
      title: `Complaint ${complaint.complaintNo} assigned to you`,
      message: `${complaint.against.businessName}, ${complaint.against.district}. ${complaint.description.slice(0, 120)}`,
      actionUrl: `/dashboard/complaints/${String(complaint._id)}`,
      actionLabel: 'Open complaint',
      dedupeKey: `complaint-assigned:${String(complaint._id)}:${assignTo}`,
    }).catch(() => {});
  }

  return ok({
    complaint: {
      _id: complaint._id,
      complaintNo: complaint.complaintNo,
      status: complaint.status,
      priority: complaint.priority,
      statusHistory: complaint.statusHistory,
    },
    availableTransitions: nextComplaintStatuses(complaint.status).map((s) => ({
      status: s,
      label: COMPLAINT_STATUS_LABELS[s],
    })),
  });
});
