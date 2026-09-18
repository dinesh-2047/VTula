import Instrument from '@/models/Instrument';
import Certificate from '@/models/Certificate';
import PublicVerification from '@/models/PublicVerification';
import User from '@/models/User';
import dbConnect from '@/lib/db';
import { handle, ok } from '@/lib/rbac';
import { OFFICIAL_ROLES } from '@/lib/constants';

/**
 * Aggregate national figures for the public landing page.
 *
 * The landing page used to invent these. Four numbers were hardcoded in state
 * (124 instruments, 28 states, 98 certificates, 34 officers) and a `fetchLiveStats`
 * helper then tried to replace two of them by calling `/api/instruments` and
 * `/api/certificates` — both of which require a signed-in session, so an
 * unauthenticated visitor always got 401 and always saw the invented figures.
 * Even for a signed-in reader the replacements were wrong: it took `.length` of a
 * paginated page and presented it as a national total.
 *
 * Everything here is a `countDocuments` or a `distinct` over the whole
 * collection. Nothing is per-business, and no record is named, so this is safe to
 * serve without a session — it is the same class of information a department
 * publishes in an annual report.
 *
 * Cached for five minutes so the front page cannot be used to hammer the
 * database; the figures are not the kind that need to be current to the second.
 */

export const revalidate = 300;

export const GET = handle(async () => {
  await dbConnect();

  const [instruments, verifiedInstruments, certificates, activeCertificates, states, verifications, officers] =
    await Promise.all([
      // Decommissioned instruments stay on the register as history, but they are
      // not part of "instruments covered", so they are excluded from the headline.
      Instrument.countDocuments({ status: { $ne: 'DECOMMISSIONED' } }),
      Instrument.countDocuments({ status: { $in: ['VERIFIED', 'EXPIRING_SOON'] } }),
      Certificate.countDocuments({}),
      Certificate.countDocuments({ status: 'ACTIVE' }),
      // Real coverage: states that actually have an instrument on the register,
      // rather than the constant 28 the page used to print.
      Instrument.distinct('installationState', { status: { $ne: 'DECOMMISSIONED' } }),
      PublicVerification.countDocuments({}),
      User.countDocuments({
        role: { $in: OFFICIAL_ROLES },
        isActive: true,
        approvalStatus: 'APPROVED',
      }),
    ]);

  return ok({
    stats: {
      instruments,
      verifiedInstruments,
      certificates,
      activeCertificates,
      statesCovered: states.filter((s) => typeof s === 'string' && s.length > 0).length,
      publicVerifications: verifications,
      officers,
    },
  });
});
