import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { ArrowLeft, QrCode, Shield, ScanLine, Keyboard, Landmark, Megaphone } from 'lucide-react';
import { extractCertNo } from '@/lib/constants';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, translator } from '@/lib/i18n';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import CertLookup from './CertLookup';
import styles from './verify.module.css';

/**
 * Manual entry point for public verification.
 *
 * The canonical result URL is `/verify/<certNo>` — that is what a certificate's
 * QR code encodes, and that is the only place a verdict is rendered. This page
 * exists for the citizen who cannot scan: the sticker is scratched, the phone has
 * no camera permission, or they are reading the number off a receipt.
 *
 * It also absorbs the old `/verify?certNo=…` shape. That was the *only* verify UI
 * before this rewrite, so links to it exist in the wild — they are redirected
 * rather than broken, and rather than left as a second rendering path that could
 * drift out of step with the one the QR points at.
 *
 * The locale is read from the cookie here, server-side, rather than left to
 * `LocaleProvider` to correct after mount. This page already awaits `searchParams`
 * and is therefore already dynamic, so the read costs nothing — and this is the
 * surface where it matters most. Someone standing at a counter checking the scale
 * their vegetables were just weighed on is both the reader most likely to need
 * Hindi and the one least likely to wait out a frame of English.
 */

export const metadata: Metadata = {
  title: 'Verify a certificate — VTULA',
  description:
    'Check whether a weighing or measuring instrument is legally verified under the Legal Metrology Act, 2009. No account needed.',
};

/**
 * The shape of a certificate number, shown so a reader knows what they are looking
 * for on the sticker.
 *
 * Not translated, and not transliterated into Devanagari numerals: this is a string
 * the reader has to type back character for character, and it is printed on the
 * sticker in exactly this form.
 */
const EXAMPLE_CERT_NO = 'VT-CERT-2026-000123';

/** The placeholder `verify.landing.typeBody` leaves for the example number. */
const EXAMPLE_SLOT = '{example}';

export default async function VerifyLandingPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  const legacy = typeof sp.certNo === 'string' ? sp.certNo : undefined;

  if (legacy) {
    /*
     * Parsed with the same function the server uses on the way in, so an old link
     * carrying a full URL or a lowercased number lands in the same place a fresh
     * scan would. An unparseable value still goes through — `publicVerify` echoes
     * back what was searched for, which is how a citizen spots a misread character.
     */
    const certNo = extractCertNo(legacy) ?? legacy.trim();
    redirect(`/verify/${encodeURIComponent(certNo)}?src=manual`);
  }

  const stored = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(stored) ? stored : DEFAULT_LOCALE;
  const t = translator(locale);

  return (
    <div className={styles.page}>
      <div className={styles.background}>
        <div className={styles.orb1} />
        <div className={styles.orb2} />
      </div>

      <div className={styles.container}>
        <div className={styles.topBar}>
          <Link href="/" className={styles.backLink}>
            <ArrowLeft size={16} />
            {t('common.home')}
          </Link>
          {/*
            * The switcher matters more here than anywhere else in the product. Every
            * other place it appears is behind a sign-in, and this page is reached by
            * people who have no account and never will.
            */}
          <LanguageSwitcher />
        </div>

        <div className={styles.header}>
          <div className={styles.logoIcon}>
            <QrCode size={32} />
          </div>
          <h1>{t('verify.landing.title')}</h1>
          <p>{t('verify.landing.lead')}</p>
        </div>

        <CertLookup />

        {/*
          * Said plainly, because the fastest route for most people is not this page
          * at all — the QR on the sticker opens the result directly.
          */}
        <section className={styles.howCard}>
          <h2>{t('verify.landing.waysTitle')}</h2>
          <ol className={styles.howList}>
            <li>
              <ScanLine size={17} />
              <div>
                <strong>{t('verify.landing.scanTitle')}</strong>
                <span>{t('verify.landing.scanBody')}</span>
              </div>
            </li>
            <li>
              <Keyboard size={17} />
              <div>
                <strong>{t('verify.landing.typeTitle')}</strong>
                {/*
                  * The example number is a placeholder in the sentence rather than
                  * part of it, so it can be wrapped in `<code>` — which is how a
                  * reader tells where the number starts and stops. The raw template is
                  * split on its own placeholder rather than interpolated, because
                  * interpolating first would give back a plain string with nowhere to
                  * put the element. Hindi also places the number earlier in the clause
                  * than English does, which is why this is one key with a slot and not
                  * two half-sentences either side of the code.
                  */}
                <span>
                  {t('verify.landing.typeBody')
                    .split(EXAMPLE_SLOT)
                    .flatMap((part, i) => [
                      ...(i > 0 ? [<code key={`eg-${i}`}>{EXAMPLE_CERT_NO}</code>] : []),
                      part,
                    ])}
                </span>
              </div>
            </li>
            <li>
              <Landmark size={17} />
              <div>
                <strong>{t('verify.landing.noStickerTitle')}</strong>
                <span>
                  {t('verify.landing.noStickerBefore')}{' '}
                  <Link href="/report" className={styles.inlineLink}>
                    {t('verify.landing.noStickerLink')}
                  </Link>{' '}
                  {t('verify.landing.noStickerAfter')}
                </span>
              </div>
            </li>
          </ol>
        </section>

        {/*
          * Checking a certificate and complaining about a trader are different
          * errands, so this sits outside the "three ways to check" list rather than
          * becoming a fourth item in it. It is placed directly beneath because the
          * most common moment a person needs it is the moment the lookup above has
          * just told them the sticker is expired — or there was never one to type.
          */}
        <section className={styles.complainCard}>
          <Megaphone size={20} />
          <div>
            <strong>{t('verify.landing.complainTitle')}</strong>
            <span>
              {t('verify.landing.complainBefore')}{' '}
              <Link href="/complaint" className={styles.inlineLink}>
                {t('verify.landing.complainLink')}
              </Link>{' '}
              {t('verify.landing.complainAfter')}
            </span>
          </div>
        </section>

        <div className={styles.footer}>
          <p>
            <Shield size={14} />
            {t('verify.footer')}
          </p>
        </div>
      </div>
    </div>
  );
}
