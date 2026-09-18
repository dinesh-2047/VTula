import { NextRequest } from 'next/server';
import dbConnect from '@/lib/db';
import Complaint, { type IComplaint } from '@/models/Complaint';
import { handle, ok, requireOfficial, scopeFilter } from '@/lib/rbac';
import {
  COMPLAINT_STATUSES,
  COMPLAINT_CLOSED_STATUSES,
  COMPLAINT_TYPES,
  type ComplaintStatus,
} from '@/lib/constants';

/**
 * `GET /api/complaints` — the officer's complaint queue.
 *
 * Scoped by `scopeFilter` on the *premises* jurisdiction, not the complainant's
 * address. A customer from one district complaining about a shop in another is
 * the case that decides this: the officer who can act is the one with authority
 * over the premises.
 */

export const dynamic = 'force-dynamic';

export const GET = handle(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireOfficial('complaints.list');
  const sp = req.nextUrl.searchParams;

  const query: Record<string, unknown> = scopeFilter(user, {
    stateField: 'against.state',
    districtField: 'against.district',
    assigneeField: 'assignedTo',
  });

  const status = sp.get('status');
  if (status === 'open') {
    query.status = { $nin: COMPLAINT_CLOSED_STATUSES };
  } else if (status && COMPLAINT_STATUSES.includes(status as ComplaintStatus)) {
    query.status = status;
  }

  const type = sp.get('type');
  if (type && COMPLAINT_TYPES.includes(type as (typeof COMPLAINT_TYPES)[number])) {
    query.complaintType = type;
  }

  const priority = sp.get('priority');
  if (priority) query.priority = priority;

  /*
   * Free-text search across the reference, the business complained about and the
   * complainant's name. An officer taking a phone call has one of those three and
   * no idea which field it belongs to.
   */
  const q = sp.get('q')?.trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [
      { complaintNo: rx },
      { 'against.businessName': rx },
      { 'complainant.name': rx },
      { 'complainant.phone': rx },
    ];
  }

  const page = Math.max(1, Number(sp.get('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 20));

  const [rows, total, counts] = await Promise.all([
    Complaint.find(query)
      /*
       * `evidence` is excluded from the list. Inline-stored attachments carry a
       * base64 payload, so a page of twenty complaints with videos would be a
       * multi-hundred-megabyte response — the list needs the count, which the
       * projection below derives, not the bytes.
       */
      .select('-evidence.data -submitterHash')
      .sort({ priority: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IComplaint[]>(),
    Complaint.countDocuments(query),
    // Tab counts for the same scope, so the badges cannot disagree with the list.
    Complaint.aggregate([
      { $match: query },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
  ]);

  const byStatus: Record<string, number> = {};
  for (const c of counts as { _id: string; n: number }[]) byStatus[c._id] = c.n;

  const openCount = COMPLAINT_STATUSES.filter(
    (s) => !COMPLAINT_CLOSED_STATUSES.includes(s)
  ).reduce((n, s) => n + (byStatus[s] ?? 0), 0);

  return ok({
    complaints: rows.map((c) => ({
      ...c,
      evidenceCount: c.evidence?.length ?? 0,
      evidence: undefined,
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    counts: { byStatus, open: openCount, total },
  });
});
