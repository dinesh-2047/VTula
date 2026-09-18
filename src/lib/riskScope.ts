import { Types, type PipelineStage } from 'mongoose';
import Instrument from '@/models/Instrument';
import {
  scopeFilter,
  hasGlobalScope,
  NotFound,
  type AuthedUser,
} from '@/lib/rbac';

/**
 * Jurisdiction scoping for risk flags.
 *
 * `RiskFlag` deliberately stores no state or district of its own — a flag is a
 * pointer at an instrument, application, certificate or owner, and duplicating
 * their jurisdiction onto it would be a second copy to keep in step. The cost is
 * that a flag cannot be scoped with a plain `scopeFilter`, and the first version
 * of the analytics route simply counted every open flag in the country and showed
 * a district officer the national backlog.
 *
 * Every detector in `src/lib/risk.ts` sets `instrumentId` — including the SLA
 * breach detector, which is derived from an application — so the instrument is a
 * complete join key. This module is the single definition of "which flags may this
 * officer see", shared by the triage list, the single-flag route and analytics.
 */

/**
 * Aggregation stages that narrow a `RiskFlag` pipeline to the officer's
 * jurisdiction. Empty for a national role, so the pipeline stays cheap.
 *
 * Leaves the joined instrument on the document as `instrument`, which the triage
 * list reuses for display rather than joining twice.
 */
export function riskScopeStages(user: AuthedUser): PipelineStage[] {
  const projection = {
    $project: {
      serialNo: 1,
      type: 1,
      brand: 1,
      model: 1,
      installationState: 1,
      installationDistrict: 1,
      ownerId: 1,
    },
  };

  const lookup: PipelineStage[] = [
    {
      $lookup: {
        from: Instrument.collection.name,
        localField: 'instrumentId',
        foreignField: '_id',
        as: 'instrument',
        pipeline: [projection],
      },
    },
    // A flag whose instrument has since been deleted cannot be placed in a
    // jurisdiction, so it drops out rather than appearing in every officer's list.
    { $unwind: '$instrument' },
  ];

  if (hasGlobalScope(user.role)) return lookup;

  return [
    ...lookup,
    {
      $match: scopeFilter(user, {
        stateField: 'instrument.installationState',
        districtField: 'instrument.installationDistrict',
      }),
    },
  ];
}

/**
 * Refuses a flag outside the officer's jurisdiction.
 *
 * 404 rather than 403: a flag's existence tells an officer in another state that
 * some instrument there is under suspicion, which is not theirs to know.
 */
export async function assertFlagInScope(
  user: AuthedUser,
  flag: { instrumentId?: Types.ObjectId | null }
): Promise<void> {
  if (hasGlobalScope(user.role)) return;

  if (!flag.instrumentId) throw NotFound('No such risk flag');

  const instrument = await Instrument.findById(flag.instrumentId)
    .select('installationState installationDistrict')
    .lean<{ installationState?: string; installationDistrict?: string } | null>();

  if (!instrument) throw NotFound('No such risk flag');

  if (user.state && instrument.installationState !== user.state) {
    throw NotFound('No such risk flag');
  }
  if (user.role === 'LMO' && user.district && instrument.installationDistrict !== user.district) {
    throw NotFound('No such risk flag');
  }
}
