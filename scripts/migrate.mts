/**
 * One-off migration from the pre-rewrite schema to the current one.
 *
 * The audit replaced most of the data model: statuses became screaming-snake
 * enums, instruments gained a normalised serial and a composite uniqueness rule,
 * applications gained a jurisdiction. None of that touches rows already in the
 * database, so an existing deployment carries documents the current models will
 * refuse to validate — and, in one case, an index that actively rejects
 * legitimate new data.
 *
 * Run it with:
 *
 *   npm run migrate           # report what would change, write nothing
 *   npm run migrate -- --apply
 *
 * It is idempotent: every step matches only documents still in the old shape, so
 * a second run is a no-op. It reads the real models through the `@/` alias hook
 * rather than re-declaring the schemas, so it cannot drift away from them.
 *
 * ## The index, which is the part that matters
 *
 * `serialNo` used to be globally unique. The current model replaces that with
 * `{brand, model, serialNoNormalized}` unique, because two different
 * manufacturers legitimately stamp the same serial on different machines and the
 * old rule rejected the second one to register.
 *
 * Mongoose creates new indexes and never drops old ones. So on any database that
 * ran the old code, `serialNo_1` is still there and still unique — which means
 * the new composite index is, in practice, dead: the old one rejects the row
 * first. Dropping it is the single change here without which the fix does not
 * take effect.
 */

import mongoose from 'mongoose';

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

/*
 * Environment comes from Node's own `--env-file-if-exists` flags, set in the
 * `migrate` npm script, rather than from `dotenv` — which is not a dependency of
 * this project and is not worth becoming one for a maintenance script.
 *
 * The npm script lists `.env` before `.env.local`, so the local file wins on
 * conflict, matching Next's own precedence: a developer pointing their app at a
 * scratch database expects this script to follow it there rather than at
 * whatever `.env` holds.
 */

const APPLY = process.argv.includes('--apply');

/* ------------------------------------------------------------------ *
 * Legacy → canonical maps
 *
 * Every value on the left was read out of the pre-rewrite models in commit
 * ffcb281, not guessed. A value that is not in these maps is left alone and
 * reported, because silently coercing an unrecognised status is how a migration
 * destroys the one row someone cared about.
 * ------------------------------------------------------------------ */

const APPLICATION_STATUS_MAP: Record<string, string> = {
  Pending: 'SUBMITTED',
  Scheduled: 'SCHEDULED',
  Inspected: 'INSPECTION_SUBMITTED',
  Approved: 'APPROVED',
  Rejected: 'REJECTED',
  Cancelled: 'CANCELLED',
};

const CERTIFICATE_STATUS_MAP: Record<string, string> = {
  Active: 'ACTIVE',
  Expired: 'EXPIRED',
  Revoked: 'REVOKED',
};

const INSTRUMENT_STATUS_MAP: Record<string, string> = {
  Active: 'REGISTERED',
  PendingVerification: 'PENDING_VERIFICATION',
  Verified: 'VERIFIED',
  Expired: 'EXPIRED',
  Rejected: 'REJECTED',
};

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

interface Step {
  name: string;
  matched: number;
  changed: number;
  notes: string[];
}

const steps: Step[] = [];

function step(name: string): Step {
  const s: Step = { name, matched: 0, changed: 0, notes: [] };
  steps.push(s);
  return s;
}

/**
 * Rewrites one enum field in place.
 *
 * Uses the driver collection rather than the Mongoose model on purpose: the
 * documents being fixed are exactly the ones the current schema considers
 * invalid, so a model-level `updateMany` would have to disable validation to
 * touch them at all.
 */
async function migrateEnum(
  collectionName: string,
  field: string,
  map: Record<string, string>,
  canonicalValues: readonly string[],
  s: Step
): Promise<void> {
  const collection = mongoose.connection.collection(collectionName);

  for (const [legacy, canonical] of Object.entries(map)) {
    const count = await collection.countDocuments({ [field]: legacy });
    if (count === 0) continue;

    s.matched += count;
    s.notes.push(`${collectionName}.${field}: ${legacy} → ${canonical} (${count})`);

    if (APPLY) {
      const res = await collection.updateMany(
        { [field]: legacy },
        { $set: { [field]: canonical } }
      );
      s.changed += res.modifiedCount;
    }
  }

  /*
   * Anything that is neither a legacy value nor a member of the current enum is
   * surfaced rather than touched. In a legal register an unexplained status is a
   * question for a human.
   *
   * The comparison is against the *full* canonical list imported from
   * `constants.ts`, not merely the values this map happens to produce. Checking
   * against the map's outputs alone reports every status the rewrite introduced —
   * `APPROVED_FOR_SCHEDULING`, `UNDER_DECISION` and the rest — as unrecognised,
   * which is a false alarm on correct data and exactly the kind of noise that
   * stops someone trusting a migration report.
   */
  const known = [...Object.keys(map), ...canonicalValues];
  const strays = await collection
    .aggregate([
      { $match: { [field]: { $nin: known, $exists: true } } },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    ])
    .toArray();

  for (const stray of strays) {
    s.notes.push(
      `UNRECOGNISED ${collectionName}.${field}="${String(stray._id)}" (${stray.n}) — left untouched`
    );
  }
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

/**
 * Drops the old global unique index on `serialNo`.
 *
 * See the header: without this the composite index the model declares is
 * unreachable, because the old one rejects the insert first.
 */
async function dropLegacySerialIndex(): Promise<void> {
  const s = step('Drop legacy serialNo_1 unique index');
  const collection = mongoose.connection.collection('instruments');

  let indexes: { name: string; unique?: boolean; key: Record<string, unknown> }[];
  try {
    indexes = (await collection.indexes()) as typeof indexes;
  } catch {
    s.notes.push('instruments collection does not exist yet — nothing to drop');
    return;
  }

  const legacy = indexes.find(
    (i) => i.name === 'serialNo_1' || (i.unique && Object.keys(i.key).join(',') === 'serialNo')
  );

  if (!legacy) {
    s.notes.push('already absent — the composite index is in force');
    return;
  }

  s.matched = 1;
  s.notes.push(`found ${legacy.name} (unique=${String(legacy.unique)})`);

  if (!APPLY) return;

  /*
   * Duplicates are checked *before* dropping, not after. They are not an error —
   * they are the rows the old rule wrongly forbade — but the composite index
   * cannot be built while genuine collisions exist, so a run that would leave the
   * database with neither index is stopped here instead.
   */
  const collisions = await collection
    .aggregate([
      {
        $group: {
          _id: {
            brand: '$brand',
            model: '$model',
            serial: { $toUpper: '$serialNoNormalized' },
          },
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();

  if (collisions.length > 0) {
    s.notes.push(
      `REFUSED: ${collisions.length} brand+model+serial collision(s) would block the ` +
        'composite index. Resolve these first — they are real duplicate registrations:'
    );
    for (const c of collisions) {
      const k = c._id as { brand?: string; model?: string; serial?: string };
      s.notes.push(`  ${k.brand} / ${k.model} / ${k.serial} ×${c.n}`);
    }
    return;
  }

  await collection.dropIndex(legacy.name);
  s.changed = 1;
  s.notes.push('dropped');
}

/**
 * Backfills `serialNoNormalized`.
 *
 * The field is `required` on the current model and the pre-save hook only fills
 * it for documents that go through Mongoose. Anything written by the old code
 * has no value at all, so it fails validation on the next save and is invisible
 * to the duplicate-detection the risk engine runs.
 *
 * The normalisation is the model's own rule, restated here rather than imported
 * because it lives inside a pre-save hook with no exported form.
 */
async function backfillSerialNormalized(): Promise<void> {
  const s = step('Backfill instrument serialNoNormalized');
  const collection = mongoose.connection.collection('instruments');

  const cursor = collection.find({
    serialNo: { $exists: true, $ne: null },
    $or: [{ serialNoNormalized: { $exists: false } }, { serialNoNormalized: '' }],
  });

  for await (const doc of cursor) {
    const serial = String(doc.serialNo ?? '');
    if (!serial) continue;
    s.matched += 1;

    if (APPLY) {
      const normalized = serial.replace(/[\s-]/g, '').toUpperCase();
      await collection.updateOne({ _id: doc._id }, { $set: { serialNoNormalized: normalized } });
      s.changed += 1;
    }
  }
}

/**
 * Backfills `jurisdiction` on applications from the instrument they belong to.
 *
 * `jurisdiction.state` and `.district` are both `required` on the current model
 * and did not exist on the old one. Every officer list in the product is narrowed
 * by `scopeFilter` on exactly these two fields, so a legacy application without
 * them is not merely invalid — it is invisible to the officers responsible for it.
 */
async function backfillApplicationJurisdiction(): Promise<void> {
  const s = step('Backfill application jurisdiction');
  const applications = mongoose.connection.collection('applications');
  const instruments = mongoose.connection.collection('instruments');

  const cursor = applications.find({
    $or: [
      { 'jurisdiction.state': { $exists: false } },
      { 'jurisdiction.district': { $exists: false } },
      { jurisdiction: null },
    ],
  });

  let unresolved = 0;

  for await (const app of cursor) {
    s.matched += 1;

    const instrument = app.instrumentId
      ? await instruments.findOne(
          { _id: app.instrumentId },
          { projection: { installationState: 1, installationDistrict: 1 } }
        )
      : null;

    const state = instrument?.installationState;
    const district = instrument?.installationDistrict;

    if (!state || !district) {
      /*
       * Left for a human. Inventing a jurisdiction would route a real application
       * to an office with no authority over it, which is worse than it staying
       * visibly broken.
       */
      unresolved += 1;
      continue;
    }

    if (APPLY) {
      await applications.updateOne(
        { _id: app._id },
        { $set: { jurisdiction: { state, district } } }
      );
      s.changed += 1;
    }
  }

  if (unresolved > 0) {
    s.notes.push(
      `${unresolved} application(s) have no instrument to inherit a jurisdiction from — ` +
        'left untouched for manual assignment'
    );
  }
}

/** Seeds the national default rule, so fees and validity have a source. */
async function seedDefaultRule(): Promise<void> {
  const s = step('Seed national default rule');
  const rules = mongoose.connection.collection('rules');

  const existing = await rules.countDocuments({ state: null, instrumentType: null, isActive: true });
  if (existing > 0) {
    s.notes.push('already present');
    return;
  }

  s.matched = 1;
  if (!APPLY) return;

  const { ensureDefaultRule } = await import('@/lib/rules');
  await ensureDefaultRule();
  s.changed = 1;
  s.notes.push('created');
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Copy sample.env to .env.local and fill it in.');
    process.exit(1);
  }

  await mongoose.connect(uri);

  // Named rather than printed from the URI, which carries credentials.
  console.log(`\nConnected to database "${mongoose.connection.name}"`);
  console.log(
    APPLY
      ? 'Mode: APPLY — changes will be written.\n'
      : 'Mode: DRY RUN — nothing will be written. Re-run with --apply to commit.\n'
  );

  const statuses = step('Normalise legacy status values');

  /*
   * The canonical lists come from `constants.ts` — the same arrays the Mongoose
   * schemas validate against — so this cannot fall behind a status added later.
   */
  const { APPLICATION_STATUSES, CERTIFICATE_STATUSES, INSTRUMENT_STATUSES } = await import(
    '@/lib/constants'
  );

  await migrateEnum('applications', 'status', APPLICATION_STATUS_MAP, APPLICATION_STATUSES, statuses);
  await migrateEnum('certificates', 'status', CERTIFICATE_STATUS_MAP, CERTIFICATE_STATUSES, statuses);
  await migrateEnum('instruments', 'status', INSTRUMENT_STATUS_MAP, INSTRUMENT_STATUSES, statuses);

  await backfillSerialNormalized();
  await backfillApplicationJurisdiction();
  await dropLegacySerialIndex();
  await seedDefaultRule();

  console.log('─'.repeat(64));
  for (const s of steps) {
    const verb = APPLY ? `${s.changed} changed` : `${s.matched} would change`;
    console.log(`\n${s.name}\n  ${verb}`);
    for (const note of s.notes) console.log(`  · ${note}`);
  }
  console.log(`\n${'─'.repeat(64)}`);

  const total = steps.reduce((n, s) => n + (APPLY ? s.changed : s.matched), 0);
  console.log(
    total === 0
      ? 'Nothing to do — this database is already on the current schema.\n'
      : APPLY
        ? `Done. ${total} change(s) written.\n`
        : `${total} change(s) pending. Re-run with --apply to commit them.\n`
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nMigration failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
