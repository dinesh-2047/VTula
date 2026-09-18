import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import dbConnect from './db';
import User from '@/models/User';
import OtpChallenge from '@/models/OtpChallenge';
import { sha256Hex } from '@/lib/utils';
import { writeAudit } from '@/lib/audit';
import type { Role } from '@/lib/constants';

/**
 * Authentication.
 *
 * Two things were wrong here before:
 *
 * 1. The `phone-otp` provider accepted a raw `userId` from the client and signed
 *    that user in. No OTP was ever checked, so the endpoint was a complete
 *    authentication bypass for anyone who could obtain a user id. It now takes a
 *    single-use `loginToken` that only `/api/otp/verify` can mint, and burns it.
 *
 * 2. Nothing rate-limited password attempts and nothing consulted the account's
 *    approval state, so a pending officer account could sign in immediately.
 *
 * `User.passwordHash` is `select: false`, so it must be requested explicitly.
 */

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

interface SessionUserFields {
  id: string;
  role: Role;
  state: string;
  district: string;
  organizationId?: string;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      id: 'credentials',
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === 'string' ? credentials.email.trim().toLowerCase() : '';
        const password = typeof credentials?.password === 'string' ? credentials.password : '';
        if (!email || !password) return null;

        await dbConnect();

        // `+passwordHash` is required: the field is excluded by default so that
        // it cannot leak through an incautious `.find()` in a route handler.
        const user = await User.findOne({ email }).select('+passwordHash');

        if (!user) {
          // Compare against a dummy hash so a missing account and a wrong
          // password take comparable time.
          await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
          return null;
        }

        if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
          await writeAudit({
            action: 'auth.login',
            userId: String(user._id),
            userRole: user.role,
            userEmail: user.email,
            outcome: 'DENIED',
            details: 'Account temporarily locked after repeated failed attempts',
          });
          return null;
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);

        if (!isValid) {
          const attempts = (user.failedLoginAttempts ?? 0) + 1;
          const update: Record<string, unknown> = { failedLoginAttempts: attempts };
          if (attempts >= MAX_FAILED_ATTEMPTS) {
            update.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
            update.failedLoginAttempts = 0;
          }
          await User.updateOne({ _id: user._id }, update);

          await writeAudit({
            action: 'auth.login',
            userId: String(user._id),
            userRole: user.role,
            userEmail: user.email,
            outcome: 'FAILURE',
            details: `Incorrect password (attempt ${attempts})`,
          });
          return null;
        }

        // Correct password, but the account may still not be permitted to sign in.
        if (!user.canSignIn()) {
          await writeAudit({
            action: 'auth.login',
            userId: String(user._id),
            userRole: user.role,
            userEmail: user.email,
            outcome: 'DENIED',
            details: user.isActive
              ? `Account approval status is ${user.approvalStatus}`
              : 'Account is deactivated',
          });
          return null;
        }

        await User.updateOne(
          { _id: user._id },
          { failedLoginAttempts: 0, lastLoginAt: new Date(), $unset: { lockedUntil: '' } }
        );

        await writeAudit({
          action: 'auth.login',
          userId: String(user._id),
          userRole: user.role,
          userEmail: user.email,
          outcome: 'SUCCESS',
          details: 'Signed in with email and password',
        });

        return {
          id: String(user._id),
          email: user.email,
          name: user.name,
          role: user.role,
          state: user.state || '',
          district: user.district || '',
          organizationId: user.organizationId ? String(user.organizationId) : undefined,
        };
      },
    }),

    Credentials({
      id: 'phone-otp',
      name: 'Phone OTP',
      credentials: {
        loginToken: { label: 'Login token', type: 'text' },
      },
      async authorize(credentials) {
        const token = typeof credentials?.loginToken === 'string' ? credentials.loginToken : '';
        if (!token || token.length < 32) return null;

        await dbConnect();

        const tokenHash = sha256Hex(token);

        // Atomically claim the token: `loginTokenUsedAt: null` in the filter means
        // a replay of the same token finds nothing.
        const challenge = await OtpChallenge.findOneAndUpdate(
          {
            loginTokenHash: tokenHash,
            verifiedAt: { $ne: null },
            loginTokenUsedAt: null,
            loginTokenExpiresAt: { $gt: new Date() },
          },
          { $set: { loginTokenUsedAt: new Date() } },
          { new: true }
        );

        if (!challenge) return null;

        const user = await User.findById(challenge.userId);
        if (!user || !user.canSignIn()) {
          await writeAudit({
            action: 'auth.login',
            userId: String(challenge.userId),
            outcome: 'DENIED',
            details: 'OTP login rejected: account is not permitted to sign in',
          });
          return null;
        }

        await User.updateOne(
          { _id: user._id },
          { failedLoginAttempts: 0, lastLoginAt: new Date(), $unset: { lockedUntil: '' } }
        );

        await writeAudit({
          action: 'auth.login',
          userId: String(user._id),
          userRole: user.role,
          userEmail: user.email,
          outcome: 'SUCCESS',
          details: `Signed in with a phone OTP (${challenge.provider})`,
        });

        return {
          id: String(user._id),
          email: user.email,
          name: user.name,
          role: user.role,
          state: user.state || '',
          district: user.district || '',
          organizationId: user.organizationId ? String(user.organizationId) : undefined,
        };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        const u = user as unknown as SessionUserFields;
        token.id = u.id;
        token.role = u.role;
        token.state = u.state;
        token.district = u.district;
        token.organizationId = u.organizationId;
      }

      // A role change or jurisdiction transfer must not wait out the 7-day token
      // lifetime, so refresh from the database when the client calls update().
      if (trigger === 'update' && token.id) {
        await dbConnect();
        const fresh = await User.findById(token.id as string)
          .select('role state district organizationId isActive approvalStatus name email')
          .lean<{
            role: Role;
            state?: string;
            district?: string;
            organizationId?: unknown;
            name: string;
            email: string;
          }>();
        if (fresh) {
          token.role = fresh.role;
          token.state = fresh.state ?? '';
          token.district = fresh.district ?? '';
          token.organizationId = fresh.organizationId ? String(fresh.organizationId) : undefined;
          token.name = fresh.name;
          token.email = fresh.email;
        }
      }

      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        const u = session.user as unknown as SessionUserFields;
        u.id = token.id as string;
        u.role = token.role as Role;
        u.state = (token.state as string) ?? '';
        u.district = (token.district as string) ?? '';
        u.organizationId = token.organizationId as string | undefined;
      }
      return session;
    },
  },

  pages: {
    signIn: '/login',
    error: '/login',
  },

  session: {
    strategy: 'jwt',
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },

  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
});
