import type { Metadata } from 'next';
import { Outfit, Inter } from 'next/font/google';
import Providers from '@/components/Providers';
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
    <html lang="en" className={`${outfit.variable} ${inter.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
