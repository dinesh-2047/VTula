import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { ADMIN_ROLES, OFFICIAL_ROLES, type Role } from '@/lib/constants';

/**
 * Request gate.
 *
 * The project previously had no `middleware.ts`/`proxy.ts` at all: every
 * dashboard route was reachable by anyone who typed the URL, and the only role
 * checks lived in client components, which decide what to *render*, not what a
 * user may *reach*.
 *
 * This file is deliberately thin. Next.js 16 advises against putting logic in
 * Proxy, and it must not be the only line of defence — the real authorization is
 * `requireAuth()` / `requireRole()` inside each route handler (`src/lib/rbac.ts`).
 * What happens here is only the redirect ergonomics: send signed-out users to the
 * login page, and keep users out of sections their role has no business opening.
 *
 * Note the file name: `middleware` was deprecated and renamed to `proxy` in
 * Next.js 16, and the exported function must be named `proxy` (or be the default
 * export). Proxy runs in the Node.js runtime, which is why importing `auth()` —
 * and through it mongoose — is safe here; the `runtime` config option is not
 * available in this file and setting it throws.
 */

/** Dashboard sections that only some roles may open. */
const SECTION_ROLES: { prefix: string; allowed: Role[] }[] = [
  { prefix: '/dashboard/users', allowed: ADMIN_ROLES },
  { prefix: '/dashboard/rules', allowed: ADMIN_ROLES },
  { prefix: '/dashboard/audit', allowed: ADMIN_ROLES },
  { prefix: '/dashboard/tasks', allowed: OFFICIAL_ROLES },
  { prefix: '/dashboard/enforcement', allowed: OFFICIAL_ROLES },
  { prefix: '/dashboard/risk', allowed: OFFICIAL_ROLES },
  { prefix: '/dashboard/reports', allowed: OFFICIAL_ROLES },
];

/** Signed-in users have no reason to see these. */
const AUTH_PAGES = ['/login', '/register'];

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const session = await auth();
  const role = (session?.user as { role?: Role } | undefined)?.role;
  const signedIn = Boolean((session?.user as { id?: string } | undefined)?.id);

  if (AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (signedIn) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    return NextResponse.next();
  }

  if (!pathname.startsWith('/dashboard')) {
    return NextResponse.next();
  }

  if (!signedIn) {
    const login = new URL('/login', request.url);
    // Preserve where they were going so login can bounce them back.
    login.searchParams.set('callbackUrl', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  const section = SECTION_ROLES.find((s) => pathname === s.prefix || pathname.startsWith(`${s.prefix}/`));
  if (section && (!role || !section.allowed.includes(role))) {
    const home = new URL('/dashboard', request.url);
    home.searchParams.set('denied', section.prefix.replace('/dashboard/', ''));
    return NextResponse.redirect(home);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Without a matcher, Proxy runs on *every* request including `_next/static`,
   * `_next/image` and everything in `public/`, which would put a session lookup
   * in front of every CSS file and image.
   *
   * `/verify/*` and `/api/verify/*` are deliberately absent: public certificate
   * verification must work for an inspector or a consumer with no account.
   */
  matcher: ['/dashboard/:path*', '/login', '/register'],
};
