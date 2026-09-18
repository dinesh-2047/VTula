import { NextRequest, NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import Application from '@/models/Application';
import Certificate from '@/models/Certificate';
import Instrument from '@/models/Instrument';
import Inspection from '@/models/Inspection';
import RiskFlag from '@/models/RiskFlag';
import User from '@/models/User';
import {
  handle,
  ok,
  requireOfficial,
  scopeFilter,
  hasGlobalScope,
  HttpError,
} from '@/lib/rbac';
import { writeAudit } from '@/lib/audit';
import { riskScopeStages } from '@/lib/riskScope';
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  IN_FLIGHT_APPLICATION_STATUSES,
  VERIFICATION_TYPE_LABELS,
  type ApplicationStatus,
  type VerificationType,
} from '@/lib/constants';

/**
 * Departmental analytics: revenue, throughput, SLA performance and coverage.
 *
 * The reports page was computing all of this in the browser from three paginated
 * list endpoints, which made every headline figure wrong in the same direction:
 * `instruments.length` was the *page size*, not the number of instruments, so a
 * state with 4,000 instruments reported 50. Revenue summed `feePaid` over whatever
 * happened to be on page one, and anything without a district was filed under an
 * invented `'Central Division'`. The two badges on the page — "100% Authentic" and
 * a per-district "Active" — were string literals.
 *
 * Everything here is aggregated in MongoDB over the full jurisdiction-scoped set,
 * and every number is one a district office could be asked to defend.
 */

export const dynamic = 'force-dynamic';

/** Revenue counts money actually collected, not money merely invoiced. */
const COLLECTED = { feeStatus: 'Paid' as const };

type Range = { from: Date; to: Date; label: string };

function readRange(sp: URLSearchParams): Range {
  const now = new Date();
  const preset = sp.get('period') ?? 'fy';

  const explicitFrom = sp.get('from');
  const explicitTo = sp.get('to');
  if (explicitFrom || explicitTo) {
    const from = explicitFrom ? new Date(explicitFrom) : new Date(0);
    const to = explicitTo ? new Date(explicitTo) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new HttpError(400, 'from and to must be valid dates', 'INVALID_DATE');
    }
    if (from > to) {
      throw new HttpError(400, 'The start of the period is after its end', 'INVALID_RANGE');
    }
    return { from, to, label: 'Custom period' };
  }

  switch (preset) {
    case 'month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to: now, label: 'This month' };
    }
    case 'quarter': {
      const from = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      return { from, to: now, label: 'This quarter' };
    }
    case 'year': {
      return { from: new Date(now.getFullYear(), 0, 1), to: now, label: 'This calendar year' };
    }
    case 'all': {
      return { from: new Date(0), to: now, label: 'All time' };
    }
    case 'fy':
    default: {
      // The Indian financial year runs April to March, which is the period a
      // Legal Metrology office actually reports revenue against.
      const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      return {
        from: new Date(startYear, 3, 1),
        to: now,
        label: `FY ${startYear}–${String(startYear + 1).slice(2)}`,
      };
    }
  }
}

/** Rounds to two decimals, or returns null when there is nothing to average. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const GET = handle(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireOfficial('analytics.read');
  const sp = req.nextUrl.searchParams;

  const range = readRange(sp);
  const inRange = { $gte: range.from, $lte: range.to };

  // Every collection stores jurisdiction under a different path, which is why
  // `scopeFilter` takes the field names rather than assuming them.
  const appScope = scopeFilter(user, {
    ownerField: 'ownerId',
    stateField: 'jurisdiction.state',
    districtField: 'jurisdiction.district',
    assigneeField: 'assignedTo',
  });
  const instScope = scopeFilter(user, {
    ownerField: 'ownerId',
    stateField: 'installationState',
    districtField: 'installationDistrict',
  });
  const certScope = scopeFilter(user, {
    ownerField: 'ownerId',
    stateField: 'instrumentSnapshot.installationState',
    districtField: 'instrumentSnapshot.installationDistrict',
  });
  const inspScope = scopeFilter(user, {
    stateField: 'location.state',
    districtField: 'location.district',
  });

  const appsInPeriod = { ...appScope, createdAt: inRange };

  const [
    /* headline counts — over the whole scoped set, not a page of it */
    totalInstruments,
    activeInstruments,
    totalApplications,
    applicationsInPeriod,
    openApplications,
    totalCertificates,
    activeCertificates,
    expiringSoon,
    expiredCertificates,
    revenueAgg,
    outstandingAgg,
    statusAgg,
    typeAgg,
    districtAgg,
    categoryAgg,
    monthlyAgg,
    decidedApps,
    inspectionAgg,
    riskAgg,
    officers,
  ] = await Promise.all([
    Instrument.countDocuments(instScope),
    Instrument.countDocuments({ ...instScope, isDecommissioned: { $ne: true } }),
    Application.countDocuments(appScope),
    Application.countDocuments(appsInPeriod),
    Application.countDocuments({
      ...appScope,
      status: { $in: [...IN_FLIGHT_APPLICATION_STATUSES] },
    }),
    Certificate.countDocuments(certScope),
    Certificate.countDocuments({ ...certScope, status: 'ACTIVE' }),
    Certificate.countDocuments({ ...certScope, status: 'EXPIRING_SOON' }),
    Certificate.countDocuments({ ...certScope, status: 'EXPIRED' }),

    // Collected in the period, from the payment verification timestamp — the date
    // the money arrived, not the date the application was filed.
    Application.aggregate([
      { $match: { ...appScope, ...COLLECTED, paymentVerifiedAt: inRange } },
      { $group: { _id: null, total: { $sum: '$feePaid' }, count: { $sum: 1 } } },
    ]),

    // Assessed but not collected. A district's real position needs both.
    Application.aggregate([
      {
        $match: {
          ...appScope,
          feeStatus: { $in: ['Unpaid', 'Pending', 'Failed'] },
          status: { $in: [...IN_FLIGHT_APPLICATION_STATUSES] },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $subtract: ['$feeAmount', '$feePaid'] } },
          count: { $sum: 1 },
        },
      },
    ]),

    Application.aggregate([
      { $match: appScope },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),

    Application.aggregate([
      { $match: appsInPeriod },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $eq: ['$feeStatus', 'Paid'] }, '$feePaid', 0] } },
        },
      },
    ]),

    /*
     * District breakdown, from applications rather than instruments, because the
     * application is what carries the jurisdiction the work was done in. Missing
     * districts are reported as "Not recorded" — the old page filed them under an
     * invented "Central Division", which read like a real place.
     */
    Application.aggregate([
      { $match: appScope },
      {
        $group: {
          _id: {
            state: { $ifNull: ['$jurisdiction.state', 'Not recorded'] },
            district: { $ifNull: ['$jurisdiction.district', 'Not recorded'] },
          },
          applications: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $eq: ['$feeStatus', 'Paid'] }, '$feePaid', 0] } },
          outstanding: {
            $sum: {
              $cond: [
                { $in: ['$feeStatus', ['Unpaid', 'Pending', 'Failed']] },
                { $subtract: ['$feeAmount', '$feePaid'] },
                0,
              ],
            },
          },
          open: {
            $sum: {
              $cond: [{ $in: ['$status', [...IN_FLIGHT_APPLICATION_STATUSES]] }, 1, 0],
            },
          },
          certificatesIssued: {
            $sum: { $cond: [{ $ifNull: ['$certificateId', false] }, 1, 0] },
          },
          overdue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ['$status', [...IN_FLIGHT_APPLICATION_STATUSES]] },
                    { $ne: ['$dueDate', null] },
                    { $lt: ['$dueDate', new Date()] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { applications: -1 } },
      { $limit: 100 },
    ]),

    Instrument.aggregate([
      { $match: instScope },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    // Twelve-month trend, keyed by year-month so the client does not have to guess
    // the bucket boundaries.
    Application.aggregate([
      {
        $match: {
          ...appScope,
          createdAt: { $gte: new Date(Date.now() - 365 * 86_400_000) },
        },
      },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          applications: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $eq: ['$feeStatus', 'Paid'] }, '$feePaid', 0] } },
          approved: { $sum: { $cond: [{ $eq: ['$decision.outcome', 'APPROVED'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$decision.outcome', 'REJECTED'] }, 1, 0] } },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),

    /*
     * SLA performance. `dueDate` is the target derived from the rule's three
     * stages, so "on time" means decided on or before it — the same definition the
     * officer's queue uses to flag overdue work.
     */
    Application.find({
      ...appScope,
      'decision.decidedAt': inRange,
    })
      .select('submittedDate dueDate decision.decidedAt decision.outcome')
      .limit(5000)
      .lean(),

    /*
     * Inspections are scoped on where the inspection actually happened, which is
     * the right jurisdictional question for "what is my district's pass rate".
     * Superseded versions are excluded so a corrected inspection is counted once.
     */
    Inspection.aggregate([
      {
        $match: {
          ...inspScope,
          isSubmitted: true,
          isSuperseded: { $ne: true },
          inspectedAt: inRange,
        },
      },
      { $group: { _id: '$result', count: { $sum: 1 } } },
    ]),

    /*
     * Risk flags carry no jurisdiction of their own — only links to the owner,
     * organisation, instrument and application — so a plain `countDocuments` here
     * would have shown a district officer the national backlog. `riskScopeStages`
     * is the shared definition of which flags an officer may see, used by the
     * triage list too so the count here and the queue there cannot disagree.
     */
    RiskFlag.aggregate([
      { $match: { status: { $in: ['OPEN', 'REVIEWING'] } } },
      ...riskScopeStages(user),
      { $count: 'total' },
    ]),

    User.countDocuments({
      role: { $in: ['LMO', 'GATC', 'GATCTechnician'] },
      isActive: true,
      approvalStatus: 'APPROVED',
      ...(hasGlobalScope(user.role) ? {} : user.state ? { state: user.state } : {}),
    }),
  ]);

  /* --- SLA and turnaround, computed from the decided set ------------------- */
  const turnaroundDays: number[] = [];
  let onTime = 0;
  let withDueDate = 0;

  for (const app of decidedApps) {
    const decidedAt = app.decision?.decidedAt;
    if (!decidedAt) continue;

    if (app.submittedDate) {
      turnaroundDays.push(
        (new Date(decidedAt).getTime() - new Date(app.submittedDate).getTime()) / 86_400_000
      );
    }
    if (app.dueDate) {
      withDueDate += 1;
      if (new Date(decidedAt) <= new Date(app.dueDate)) onTime += 1;
    }
  }

  const inspectionCounts = Object.fromEntries(inspectionAgg.map((r) => [r._id, r.count]));
  const inspectionTotal = inspectionAgg.reduce((sum, r) => sum + r.count, 0);
  const passed = inspectionCounts.PASS ?? 0;

  const revenue = revenueAgg[0]?.total ?? 0;
  const outstanding = Math.max(0, outstandingAgg[0]?.total ?? 0);

  const statusCounts = Object.fromEntries(statusAgg.map((r) => [r._id, r.count]));

  const districts = districtAgg.map((d) => ({
    state: d._id.state as string,
    district: d._id.district as string,
    applications: d.applications as number,
    open: d.open as number,
    overdue: d.overdue as number,
    certificatesIssued: d.certificatesIssued as number,
    revenue: d.revenue as number,
    outstanding: Math.max(0, d.outstanding as number),
    // A real status, derived: a district with overdue work is behind.
    slaStatus: d.overdue > 0 ? 'BEHIND' : d.open > 0 ? 'IN_PROGRESS' : 'CLEAR',
  }));

  const report = {
    period: { from: range.from, to: range.to, label: range.label },
    scope: {
      level: hasGlobalScope(user.role) ? 'national' : user.role === 'StateAdmin' ? 'state' : 'district',
      state: hasGlobalScope(user.role) ? undefined : user.state,
      district: user.role === 'StateAdmin' || hasGlobalScope(user.role) ? undefined : user.district,
    },

    headline: {
      instruments: { total: totalInstruments, active: activeInstruments },
      applications: {
        total: totalApplications,
        inPeriod: applicationsInPeriod,
        open: openApplications,
      },
      certificates: {
        total: totalCertificates,
        active: activeCertificates,
        expiringSoon,
        expired: expiredCertificates,
      },
      revenue: {
        collected: revenue,
        payments: revenueAgg[0]?.count ?? 0,
        outstanding,
        outstandingApplications: outstandingAgg[0]?.count ?? 0,
        // The share of assessed fees actually banked.
        collectionRate:
          revenue + outstanding > 0
            ? Math.round((revenue / (revenue + outstanding)) * 1000) / 10
            : null,
      },
      officers,
      openRiskFlags: riskAgg[0]?.total ?? 0,
    },

    sla: {
      decided: decidedApps.length,
      withTarget: withDueDate,
      onTime,
      // Null rather than 100% when nothing has been decided — an empty period is
      // not perfect performance.
      onTimePercent: withDueDate > 0 ? Math.round((onTime / withDueDate) * 1000) / 10 : null,
      averageTurnaroundDays: mean(turnaroundDays),
      medianTurnaroundDays:
        turnaroundDays.length > 0
          ? Math.round(
              turnaroundDays.sort((a, b) => a - b)[Math.floor(turnaroundDays.length / 2)] * 100
            ) / 100
          : null,
      truncated: decidedApps.length >= 5000,
    },

    inspections: {
      total: inspectionTotal,
      byResult: inspectionCounts,
      passRate: inspectionTotal > 0 ? Math.round((passed / inspectionTotal) * 1000) / 10 : null,
    },

    funnel: APPLICATION_STATUSES.map((s) => ({
      status: s,
      label: APPLICATION_STATUS_LABELS[s as ApplicationStatus],
      count: statusCounts[s] ?? 0,
    })).filter((r) => r.count > 0),

    byVerificationType: typeAgg.map((t) => ({
      type: t._id as string,
      label: VERIFICATION_TYPE_LABELS[t._id as VerificationType] ?? t._id,
      count: t.count as number,
      revenue: t.revenue as number,
    })),

    byDistrict: districts,

    byInstrumentCategory: categoryAgg.map((c) => ({
      type: c._id as string,
      count: c.count as number,
    })),

    monthly: monthlyAgg.map((m) => ({
      // `YYYY-MM`, sortable and unambiguous.
      month: `${m._id.year}-${String(m._id.month).padStart(2, '0')}`,
      applications: m.applications as number,
      revenue: m.revenue as number,
      approved: m.approved as number,
      rejected: m.rejected as number,
    })),

    generatedAt: new Date(),
  };

  /* --- CSV export --------------------------------------------------------- */
  if (sp.get('format') === 'csv') {
    // Generated server-side so the exported figures are the same ones the
    // department can be held to, rather than whatever the browser had loaded.
    const lines: string[] = [
      'VTULA — Legal Metrology verification and revenue report',
      `Scope,${csvCell(report.scope.level)},${csvCell(report.scope.state ?? 'All states')},${csvCell(report.scope.district ?? 'All districts')}`,
      `Period,${csvCell(range.label)},${range.from.toISOString().slice(0, 10)},${range.to.toISOString().slice(0, 10)}`,
      `Generated,${new Date().toISOString()}`,
      '',
      'Summary',
      `Instruments registered,${totalInstruments}`,
      `Instruments in service,${activeInstruments}`,
      `Applications (all time),${totalApplications}`,
      `Applications (period),${applicationsInPeriod}`,
      `Applications open,${openApplications}`,
      `Certificates active,${activeCertificates}`,
      `Certificates expiring soon,${expiringSoon}`,
      `Certificates expired,${expiredCertificates}`,
      `Fees collected (INR),${revenue}`,
      `Fees outstanding (INR),${outstanding}`,
      `Collection rate (%),${report.headline.revenue.collectionRate ?? ''}`,
      `Decisions within SLA (%),${report.sla.onTimePercent ?? ''}`,
      `Average turnaround (days),${report.sla.averageTurnaroundDays ?? ''}`,
      `Inspection pass rate (%),${report.inspections.passRate ?? ''}`,
      '',
      'State,District,Applications,Open,Overdue,Certificates issued,Fees collected (INR),Outstanding (INR),SLA status',
      ...districts.map((d) =>
        [
          d.state,
          d.district,
          d.applications,
          d.open,
          d.overdue,
          d.certificatesIssued,
          d.revenue,
          d.outstanding,
          d.slaStatus,
        ]
          .map(csvCell)
          .join(',')
      ),
    ];

    await writeAudit({
      action: 'analytics.export',
      userId: user.id,
      userRole: user.role,
      outcome: 'SUCCESS',
      details: `Exported ${districts.length} district rows for ${range.label}`,
      headers: req.headers,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(lines.join('\r\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="vtula-report-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return ok({ report });
});
