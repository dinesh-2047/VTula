'use client';

import { SessionProvider } from 'next-auth/react';
import LocaleProvider from './LocaleProvider';

/**
 * The client context every page renders inside.
 *
 * `LocaleProvider` sits inside the session provider rather than outside it because
 * the language switcher writes the choice to `/api/settings`, and that call is only
 * meaningful for a signed-in user.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <LocaleProvider>{children}</LocaleProvider>
    </SessionProvider>
  );
}
