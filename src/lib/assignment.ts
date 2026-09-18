import { Types } from 'mongoose';
import User, { type IUser } from '@/models/User';
import Schedule from '@/models/Schedule';
import Application, { type IApplication } from '@/models/Application';
import Instrument from '@/models/Instrument';
import { INSPECTOR_ROLES, type Role } from '@/lib/constants';

/**
 * Smart assignment recommender.
 *
 * Scheduling was previously non-existent: `assignedTo` was written retroactively
 * at approval time, so nobody was ever assigned *before* an inspection, and
 * there was no way to see who was overloaded.
 *
 * This recommends, it does not decide. Every candidate carries the reasons that
 * produced its score so the officer who confirms the assignment can see exactly
 * why it was suggested — the spec is explicit that the system must never be an
 * unexplained decision-maker.
 */

export interface AssignmentCandidate {
  userId: string;
  name: string;
  role: Role;
  designation?: string;
  state?: string;
  district?: string;
  /** 0-100, higher is a better fit. */
  score: number;
  /** Human-readable justification, in the order it was applied. */
  reasons: string[];
  /** Open (not yet completed) inspections currently on their plate. */
  openLoad: number;
  /** Inspections already booked on the target date. */
  loadOnDate: number;
  /** Whether they are accredited for this instrument type. */
  categoryApproved: boolean;
}

export interface RecommendInput {
  application: Pick<IApplication, 'jurisdiction' | 'instrumentId' | 'type'>;
  instrumentType: string;
  targetDate: Date;
  /** Restrict to these roles; defaults to every inspector role. */
  roles?: Role[];
  /** Cap on inspections one person should hold on a single day. */
  dailyCapacity?: number;
}

const DEFAULT_DAILY_CAPACITY = 6;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/**
 * Returns candidates ranked best-first. An empty array means nobody in the
 * jurisdiction can take it — the caller should surface that rather than
 * silently assigning someone unsuitable.
 */
export async function recommendAssignees(input: RecommendInput): Promise<AssignmentCandidate[]> {
  const roles = input.roles ?? INSPECTOR_ROLES;
  const capacity = input.dailyCapacity ?? DEFAULT_DAILY_CAPACITY;
  const { state, district } = input.application.jurisdiction;

  const officers = await User.find({
    role: { $in: roles },
    isActive: true,
    approvalStatus: 'APPROVED',
    state,
  })
    .select('name role designation state district additionalDistricts categoriesApproved accreditationValidUntil')
    .limit(100)
    .lean<IUser[]>();

  if (officers.length === 0) return [];

  const ids = officers.map((o) => o._id);
  const dayStart = startOfDay(input.targetDate);
  const dayEnd = endOfDay(input.targetDate);

  const [openCounts, dayCounts] = await Promise.all([
    Schedule.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { assignedTo: { $in: ids }, status: { $in: ['PROPOSED', 'CONFIRMED', 'RESCHEDULED', 'IN_PROGRESS'] } } },
      { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
    ]),
    Schedule.aggregate<{ _id: Types.ObjectId; n: number }>([
      {
        $match: {
          assignedTo: { $in: ids },
          scheduledDate: { $gte: dayStart, $lte: dayEnd },
          status: { $nin: ['CANCELLED'] },
        },
      },
      { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
    ]),
  ]);

  const openMap = new Map(openCounts.map((c) => [String(c._id), c.n]));
  const dayMap = new Map(dayCounts.map((c) => [String(c._id), c.n]));

  const now = Date.now();

  const candidates: AssignmentCandidate[] = officers.map((o) => {
    const reasons: string[] = [];
    let score = 50;

    // --- Jurisdiction fit -------------------------------------------------
    if (o.district === district) {
      score += 25;
      reasons.push(`Primary jurisdiction is ${district}, matching the installation district.`);
    } else if (o.additionalDistricts?.includes(district)) {
      score += 15;
      reasons.push(`${district} is one of their additional assigned districts.`);
    } else {
      score -= 10;
      reasons.push(`Based in ${o.district || 'an unspecified district'}, outside ${district} — travel required.`);
    }

    // --- Category accreditation ------------------------------------------
    const approved = o.categoriesApproved ?? [];
    const categoryApproved = approved.length === 0 || approved.includes(input.instrumentType);
    if (approved.length === 0) {
      reasons.push('No category restriction recorded on this account.');
    } else if (categoryApproved) {
      score += 15;
      reasons.push(`Accredited for ${input.instrumentType}.`);
    } else {
      score -= 40;
      reasons.push(`Not accredited for ${input.instrumentType} — assignment not recommended.`);
    }

    // --- Accreditation validity (GATC) -----------------------------------
    if (o.accreditationValidUntil && new Date(o.accreditationValidUntil).getTime() < now) {
      score -= 35;
      reasons.push(
        `Accreditation lapsed on ${new Date(o.accreditationValidUntil).toLocaleDateString('en-IN')}.`
      );
    }

    // --- Workload ---------------------------------------------------------
    const openLoad = openMap.get(String(o._id)) ?? 0;
    const loadOnDate = dayMap.get(String(o._id)) ?? 0;

    if (loadOnDate >= capacity) {
      score -= 30;
      reasons.push(`Already has ${loadOnDate} inspections booked that day (capacity ${capacity}).`);
    } else if (loadOnDate === 0) {
      score += 10;
      reasons.push('No inspections booked on the target date.');
    } else {
      reasons.push(`${loadOnDate} of ${capacity} slots used on the target date.`);
    }

    // Spread the standing queue: each open item costs a little.
    score -= Math.min(15, openLoad);
    if (openLoad > 0) reasons.push(`${openLoad} open inspection${openLoad === 1 ? '' : 's'} in their queue.`);

    // An LMO can both inspect and decide; prefer a GATC for routine testing so
    // the officer's time goes to adjudication.
    if (o.role === 'LMO') {
      score -= 5;
      reasons.push('Legal Metrology Officer — prefer to reserve for adjudication where a GATC is available.');
    }

    return {
      userId: String(o._id),
      name: o.name,
      role: o.role as Role,
      designation: o.designation,
      state: o.state,
      district: o.district,
      score: Math.max(0, Math.min(100, Math.round(score))),
      reasons,
      openLoad,
      loadOnDate,
      categoryApproved,
    };
  });

  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Convenience wrapper used when an officer asks the system to suggest an
 * assignee for a specific application.
 */
export async function recommendForApplication(
  applicationId: string,
  targetDate: Date
): Promise<AssignmentCandidate[]> {
  const app = await Application.findById(applicationId).lean<IApplication>();
  if (!app) return [];

  const instrument = await Instrument.findById(app.instrumentId).select('type').lean<{ type: string }>();
  if (!instrument) return [];

  return recommendAssignees({
    application: app,
    instrumentType: instrument.type,
    targetDate,
  });
}
