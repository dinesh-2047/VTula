/**
 * Creates the administrator accounts a fresh deployment needs to be usable.
 *
 * There is a chicken-and-egg problem in the product by design: only an `Admin`
 * can provision a `StateAdmin`, only a `StateAdmin` can provision officers, and
 * `SELF_REGISTERABLE_ROLES` is `['Owner']` — so no privileged account can ever be
 * created through the UI. This script is the one way in, which is why it is a
 * terminal command and not an endpoint.
 *
 *   npm run create-admin                       # both accounts, generated passwords
 *   npm run create-admin -- --reset-password   # re-issue passwords for existing accounts
 *
 * Passwords are generated with `crypto.randomBytes` and printed once. They are
 * not stored anywhere in plaintext and not written to a file: the operator copies
 * them out of the terminal and changes them on first sign-in. A fixed default
 * password here would be the same password on every deployment of this codebase.
 *
 * Idempotent. An account that already exists is reported and left alone unless
 * `--reset-password` is passed.
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

const RESET = process.argv.includes('--reset-password');

/** Matches the registration route's own cost factor. */
const BCRYPT_ROUNDS = 12;

interface Seed {
  label: string;
  email: string;
  name: string;
  role: 'Admin' | 'StateAdmin';
  phone: string;
  state?: string;
  district?: string;
  designation: string;
  officerCode: string;
}

const ACCOUNTS: Seed[] = [
  {
    label: 'National administrator',
    email: 'admin@vtula.gov.in',
    name: 'National Administrator',
    role: 'Admin',
    phone: '9000000001',
    designation: 'Controller of Legal Metrology',
    officerCode: 'VTULA-NAT-001',
  },
  {
    label: 'Himachal Pradesh state administrator',
    email: 'hp.admin@vtula.gov.in',
    name: 'Himachal Pradesh State Administrator',
    role: 'StateAdmin',
    phone: '9000000002',
    /*
     * Must be the exact string from `INDIAN_STATES`. `scopeFilter` narrows every
     * officer query by an equality match on this field, so "Himachal" or
     * "HP" here would produce an administrator who can see nothing at all.
     */
    state: 'Himachal Pradesh',
    district: 'Shimla',
    designation: 'Controller of Legal Metrology, Himachal Pradesh',
    officerCode: 'VTULA-HP-001',
  },
];

/**
 * A password that satisfies the registration route's policy without a retry loop.
 *
 * That policy (`src/app/api/auth/register/route.ts`) needs ≥10 characters, at
 * least 5 distinct ones, and no `password`/`12345678`/`qwertyui` prefix. Base64 of
 * 12 random bytes clears all three, and the `Vt-` prefix guarantees a mixed
 * character class whatever the draw.
 */
function generatePassword(): string {
  return `Vt-${randomBytes(12).toString('base64url')}`;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Copy sample.env to .env.local and fill it in.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  // Named rather than printed from the URI, which carries credentials.
  console.log(`\nConnected to database "${mongoose.connection.name}"\n`);

  const { default: User } = await import('@/models/User');
  const { isValidDistrict } = await import('@/lib/districts');
  const { INDIAN_STATES } = await import('@/lib/constants');

  const issued: { label: string; email: string; password: string; role: string }[] = [];

  for (const seed of ACCOUNTS) {
    // Guards against a typo producing an administrator with an unmatchable scope.
    if (seed.state) {
      if (!INDIAN_STATES.includes(seed.state as (typeof INDIAN_STATES)[number])) {
        throw new Error(`"${seed.state}" is not in INDIAN_STATES`);
      }
      if (seed.district && !isValidDistrict(seed.state, seed.district)) {
        throw new Error(`"${seed.district}" is not a district of ${seed.state}`);
      }
    }

    const existing = await User.findOne({ email: seed.email }).select('_id role');

    if (existing && !RESET) {
      console.log(`· ${seed.label}: already exists (${seed.email}) — left unchanged`);
      continue;
    }

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    if (existing) {
      /*
       * `updateOne` rather than assigning to the document and saving: the
       * password field is `select: false` on the model, so a loaded document has
       * no `passwordHash` and a save would not necessarily carry the new one.
       */
      await User.updateOne(
        { _id: existing._id },
        {
          $set: {
            passwordHash,
            isActive: true,
            approvalStatus: 'APPROVED',
            // Clears a lockout, which is a plausible reason for running this.
            failedLoginAttempts: 0,
          },
          $unset: { lockedUntil: '' },
        }
      );
      console.log(`· ${seed.label}: password reset`);
    } else {
      await User.create({
        name: seed.name,
        email: seed.email,
        phone: seed.phone,
        passwordHash,
        role: seed.role,
        state: seed.state,
        district: seed.district,
        designation: seed.designation,
        officerCode: seed.officerCode,
        isActive: true,
        // Bypasses the approval queue on purpose: there is nobody to approve the
        // first administrator.
        approvalStatus: 'APPROVED',
        isEmailVerified: true,
        isPhoneVerified: true,
      });
      console.log(`· ${seed.label}: created`);
    }

    issued.push({ label: seed.label, email: seed.email, password, role: seed.role });
  }

  if (issued.length === 0) {
    console.log(
      '\nNothing to do. Both accounts exist. Re-run with `-- --reset-password` to issue new passwords.\n'
    );
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${'─'.repeat(68)}`);
  console.log('  SIGN-IN DETAILS — shown once, not stored anywhere in plaintext');
  console.log('─'.repeat(68));
  for (const a of issued) {
    console.log(`\n  ${a.label}  [${a.role}]`);
    console.log(`  Email     ${a.email}`);
    console.log(`  Password  ${a.password}`);
  }
  console.log(`\n${'─'.repeat(68)}`);
  console.log('  Copy these now, then change them from Settings after signing in.');
  console.log(`${'─'.repeat(68)}\n`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nFailed to create administrator accounts:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
