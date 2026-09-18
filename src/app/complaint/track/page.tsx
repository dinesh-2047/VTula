import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, Megaphone, Search } from 'lucide-react';
import { normalizeComplaintNo } from '@/lib/constants';
import TrackForm from './TrackForm';
import styles from '../complaint.module.css';

/**
 * Complaint status lookup.
 *
 * The success screen links here with `?ref=…` prefilled, but never with the phone
 * number: a reference in a URL is a reference someone may paste into a chat, and
 * the whole point of requiring the pair is that the reference on its own opens
 * nothing.
 */

export const metadata: Metadata = {
  title: 'Track a complaint — VTULA',
  description:
    'Check what has happened to a complaint you filed about a weighing or measuring instrument. Enter your reference number and the mobile number you filed with.',
};

export default async function TrackPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  const raw = typeof sp.ref === 'string' ? sp.ref : undefined;
  const initialRef = raw ? normalizeComplaintNo(raw) || raw.trim() : undefined;

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
            Home
          </Link>
          <Link href="/complaint" className={styles.backLink}>
            <Megaphone size={15} />
            File a new complaint
          </Link>
        </div>

        <header className={styles.header}>
          <span className={styles.badge}>
            <Search size={14} />
            Complaint status
          </span>
          <h1 className={styles.title}>Track your complaint</h1>
          <p className={styles.subtitle}>
            Enter the reference number you were given and the mobile number you filed with. You will
            see every step the department has recorded, in the order it happened.
          </p>
        </header>

        <TrackForm initialRef={initialRef} />

        <p className={styles.footNote}>
          Lost your reference number? Contact the district Legal Metrology office — they can find the
          complaint from your mobile number.
        </p>
      </div>
    </div>
  );
}
