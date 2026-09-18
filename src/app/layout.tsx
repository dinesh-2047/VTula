import type { Metadata } from 'next';
import { Outfit, Inter, Noto_Sans_Devanagari } from 'next/font/google';
import Providers from '@/components/Providers';
import { DEFAULT_LOCALE } from '@/lib/i18n';
import './globals.css';

const outfit = Outfit({
  variable: '--font-outfit',
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800', '900'],
  display: 'swap',
});

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

/**
 * Devanagari, so the Hindi interface has a webfont at all.
 *
 * Outfit and Inter are loaded `subsets: ['latin']` — correctly, since neither has
 * Devanagari coverage. The consequence was that every Hindi string in the product
 * fell through to whatever the operating system happened to have: a system serif on
 * Windows, frequently a notably worse fit on Android, and on a machine with no
 * Devanagari font installed, boxes. The bilingual interface the spec asks for cannot
 * rest on the reader owning the right font.
 *
 * This is a separate family rather than another subset because the browser resolves
 * font fallback per character: Latin text takes Outfit or Inter, and only the
 * characters those families do not cover reach this one. Loading it costs nothing on
 * an English page, since no glyph is ever requested from it.
 */
const devanagari = Noto_Sans_Devanagari({
  variable: '--font-devanagari',
  subsets: ['devanagari'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'VTULA — Digital Legal Metrology Verification & Stamping Platform',
  description:
    'India\'s unified digital platform for legal metrology verification and stamping of commercial weights and measures. Submit applications, schedule inspections, and receive QR-enabled digital certificates under the Legal Metrology Act 2009.',
  keywords: [
    'legal metrology',
    'verification',
    'stamping',
    'weights and measures',
    'eMaap',
    'digital certificate',
    'QR verification',
    'India',
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `lang` is the default here and is corrected on mount by `LocaleProvider`.
     *
     * The alternative is `await cookies()` in this layout, which would get it right
     * in the first byte and opt every route in the application — including the
     * landing page and the public trust centre — out of static prerendering to do it.
     * A page that is already dynamic for its own reasons reads the cookie itself;
     * `/verify` does.
     */
    <html
      lang={DEFAULT_LOCALE}
      className={`${outfit.variable} ${inter.variable} ${devanagari.variable}`}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
