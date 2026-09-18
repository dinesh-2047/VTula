import type { DefaultSession } from 'next-auth';
import type { Role } from '@/lib/constants';

/**
 * Session/JWT shape.
 *
 * Without this, every consumer had to write `(session?.user as any)?.role`, which
 * is how the role checks drifted apart across pages — one file read `role`,
 * another read a field that was never set, and TypeScript could not tell anyone.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: Role;
      state: string;
      district: string;
      organizationId?: string;
    } & DefaultSession['user'];
  }

  interface User {
    role: Role;
    state?: string;
    district?: string;
    organizationId?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: Role;
    state?: string;
    district?: string;
    organizationId?: string;
  }
}

export {};
