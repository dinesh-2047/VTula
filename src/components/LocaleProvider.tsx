'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isLocale,
  translator,
  type Locale,
  type Translate,
} from '@/lib/i18n';

/**
 * The chosen language, and the translator bound to it.
 *
 * `src/lib/i18n.ts` was a finished two-language dictionary that nothing consumed.
 * `/api/settings` imported it for the *names* of the languages, so the settings page
 * offered a choice, saved it to `user.preferences.language`, and every screen in the
 * product stayed in English — the setting was real, its effect was not. This is the
 * missing half.
 *
 * Translated so far: the dashboard shell (sidebar, topbar, profile menu) and the
 * public trust centre. Everything else still renders its own English strings; a page
 * joins in by calling `useLocale()` and swapping its literals for keys, which is why
 * `t()` is typed against the English key set — a page cannot half-adopt it and pass
 * a key that does not exist.
 *
 * ## Why the locale is read after mount and not from `cookies()`
 *
 * Reading the cookie in the root layout would give a correct `<html lang>` in the
 * first byte, but `cookies()` in a layout opts *every* route beneath it out of static
 * prerendering — including the landing page and the trust centre, which are the two
 * pages a citizen reaches cold and the two where time-to-first-byte matters most.
 * Paying that on every request in the application, to avoid one frame of English for
 * the minority of users who have switched, is the wrong trade. So the cookie is read
 * on mount and `document.documentElement.lang` is corrected there.
 *
 * The exception is a page that is dynamic for its own reasons — `/verify` already
 * awaits `searchParams` — where the cookie is read server-side and the page renders
 * in the right language from the first byte. That is done per page, deliberately,
 * rather than globally.
 */

interface LocaleContextValue {
  locale: Locale;
  /** Persists the choice to the cookie, and to the account when signed in. */
  setLocale: (next: Locale) => void;
  /**
   * Adopts a locale that came *from* the server, without writing it back.
   *
   * Separate from `setLocale` so that reading a saved `preferences.language` off the
   * account does not immediately PATCH the same value back — which the settings route
   * would answer with a `NO_CHANGES` 400, and which would make the server log read as
   * though the user had changed something they had not.
   */
  adoptLocale: (next: Locale) => void;
  t: Translate;
  /**
   * Whether the locale came from a cookie on this device.
   *
   * `false` means nobody has chosen on this browser yet, so a signed-in user's saved
   * `preferences.language` is worth asking the server for. The dashboard shell does
   * exactly that, once — see `DashboardShell`. Public pages must not, because for an
   * anonymous visitor the request can only ever come back 401.
   */
  chosen: boolean;
}

const FALLBACK: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  adoptLocale: () => {},
  t: translator(DEFAULT_LOCALE),
  chosen: false,
};

const LocaleContext = createContext<LocaleContextValue>(FALLBACK);

/** Reads the locale cookie. Returns null when absent or unrecognised. */
function readCookie(): Locale | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== LOCALE_COOKIE) continue;
    const value = decodeURIComponent(rest.join('='));
    return isLocale(value) ? value : null;
  }
  return null;
}

function writeCookie(locale: Locale) {
  // `secure` is omitted over plain HTTP, because a browser silently discards a
  // secure cookie on an insecure origin and the switcher would appear to do nothing
  // in local development.
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax${secure}`;
}

export default function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [chosen, setChosen] = useState(false);

  /*
   * Read on mount, not during render.
   *
   * `document.cookie` is unavailable while the server renders, so a `useState`
   * initialiser that read it would return `en` on the server and `hi` in the
   * browser — a hydration mismatch. The `await Promise.resolve()` is the project's
   * idiom for satisfying `react-hooks/set-state-in-effect`, which is an error here.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      const stored = readCookie();
      if (stored) {
        setLocaleState(stored);
        setChosen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Keep the document's own language honest. It matters beyond tidiness: screen
   * readers pick a voice from it, and Chrome offers to translate a page whose `lang`
   * disagrees with its text — so a Hindi interface still claiming `lang="en"` gets
   * read aloud in an English voice and machine-translated on top of a translation.
   */
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const adoptLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    setChosen(true);
    writeCookie(next);
    document.documentElement.lang = next;
  }, []);

  const setLocale = useCallback(
    (next: Locale) => {
      adoptLocale(next);

      /*
       * Mirrored to the account so the choice follows the user to their next device,
       * where no cookie exists yet. Best-effort on purpose: an anonymous visitor gets
       * a 401, and neither that nor a network failure is a problem the reader needs to
       * hear about — the interface in front of them has already changed.
       */
      void fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: next }),
      }).catch(() => {});
    },
    [adoptLocale]
  );

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, adoptLocale, t: translator(locale), chosen }),
    [locale, setLocale, adoptLocale, chosen]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * The current locale and its translator.
 *
 * Falls back to English rather than throwing when no provider is above it. A
 * mis-wired subtree should render readable English, not an error boundary — but
 * `Providers` is the single wrapper both the root and dashboard layouts use, so in
 * practice this cannot happen.
 */
export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
