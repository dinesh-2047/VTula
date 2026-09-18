import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Application from '@/models/Application';
import Instrument from '@/models/Instrument';
import { handle, ok, requireOfficial, BadRequest, NotFound, canAccessRecord } from '@/lib/rbac';
import { recommendAssignees } from '@/lib/assignment';
import type { IApplication } from '@/models/Application';

/**
 * Who should take this inspection, and why.
 *
 * Kept separate from `POST /api/schedules` so the officer can see the ranking
 * *before* committing to a slot. The spec rules out unexplained automated
 * decisions, so every candidate carries the reasons that put them where they are
 * — jurisdiction match, accreditation for the instrument type, and current load.
 */

export const GET = handle(async (req: NextRequest) => {
  const user = await requireOfficial('schedule.recommend');
  const sp = new URL(req.url).searchParams;

  const applicationId = sp.get('applicationId');
  if (!applicationId || !Types.ObjectId.isValid(applicationId)) {
    throw BadRequest('An application must be identified', 'APPLICATION_REQUIRED');
  }

  const dateParam = sp.get('date');
  if (dateParam && Number.isNaN(Date.parse(dateParam))) {
    throw BadRequest('That is not a valid date', 'INVALID_DATE');
  }
  const targetDate = dateParam ? new Date(dateParam) : new Date();

  const application = await Application.findById(applicationId)
    .select('applicationNo type status jurisdiction instrumentId ownerId assignedTo dueDate')
    .lean<IApplication & { _id: Types.ObjectId }>();

  if (!application) throw NotFound('No such application');

  if (
    !canAccessRecord(user, {
      ownerId: application.ownerId,
      assignedTo: application.assignedTo,
      state: application.jurisdiction?.state,
      district: application.jurisdiction?.district,
    })
  ) {
    throw NotFound('No such application');
  }

  const instrument = await Instrument.findById(application.instrumentId)
    .select('type brand model serialNo installationDistrict installationState')
    .lean<{ type: string; brand: string; model: string; serialNo: string; installationDistrict: string; installationState: string }>();

  if (!instrument) {
    throw BadRequest('The instrument for this application no longer exists', 'NO_INSTRUMENT');
  }

  const candidates = await recommendAssignees({
    application,
    instrumentType: instrument.type,
    targetDate,
  });

  return ok({
    application: {
      id: String(application._id),
      applicationNo: application.applicationNo,
      type: application.type,
      status: application.status,
      dueDate: application.dueDate,
      jurisdiction: application.jurisdiction,
    },
    instrument: {
      type: instrument.type,
      label: `${instrument.brand} ${instrument.model} · ${instrument.serialNo}`,
      district: instrument.installationDistrict,
      state: instrument.installationState,
    },
    targetDate,
    candidates,
    // An empty list is an answer, not an error: it means nobody in this
    // jurisdiction can take it on that date, and the officer needs to know that
    // rather than see a spinner.
    note:
      candidates.length === 0
        ? `No inspector in ${application.jurisdiction?.district}, ${application.jurisdiction?.state} is available on ${targetDate.toDateString()}.`
        : undefined,
  });
});
