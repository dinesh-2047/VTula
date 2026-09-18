import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, Megaphone, Search, Shield, ShieldCheck, Clock, UserX } from 'lucide-react';
import ComplaintForm from './ComplaintForm';
import styles from './complaint.module.css';

/**
 * Public complaint portal.
 *
 * Distinct from `/report`, which files an `EnforcementCase` against an instrument
 * that already exists in the register and therefore needs a certificate or serial
 * number to resolve. A customer standing in front of a scale with no sticker on it
 * has neither, and that is precisely the case worth hearing about: a trader who
 * never presented an instrument for verification leaves no record to complain
 * against. This route needs only a business name and an address.
 *
 * No account, and none is offered. Requiring a sign-up to report a short measure
 * would filter the complaints down to the people who care enough to register,
 * which is not the same population as the people being short-measured.
 */

export const metadata: Metadata = {
  title: 'File a complaint about a weighing or measuring instrument — VTULA',
  description:
    'Complain about a shop, petrol pump or trader using a faulty, unverified or tampered weighing instrument — or none at all. Attach photos or video. No account needed; you get a reference number to track it.',
};

export default function ComplaintPage() {
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
          <div className={styles.topActions}>
            <Link href="/complaint/track" className={styles.backLink}>
              <Search size={15} />
              Track a complaint
            </Link>
            <Link href="/verify" className={styles.backLink}>
              <ShieldCheck size={15} />
              Verify a certificate
            </Link>
          </div>
        </div>

        <header className={styles.header}>
          <span className={styles.badge}>
            <Megaphone size={14} />
            Consumer complaint
          </span>
          <h1 className={styles.title}>File a complaint</h1>
          <p className={styles.subtitle}>
            Short weight, a scale with no verification sticker, a tampered seal, a pump that
            under-delivers — report it to the Legal Metrology office for that district. You do not
            need an account, and you do not need to know anything about the machine&apos;s
            registration.
          </p>
        </header>

        {/* Answered before it is asked: the three things people hesitate over. */}
        <div className={styles.assurances}>
          <div className={styles.assurance}>
            <span className={styles.assuranceIcon}>
              <UserX size={16} />
            </span>
            <span className={styles.assuranceText}>
              <strong>The shop is not told who you are</strong>
              <span>Officers see your contact details. The business does not.</span>
            </span>
          </div>
          <div className={styles.assurance}>
            <span className={styles.assuranceIcon}>
              <Clock size={16} />
            </span>
            <span className={styles.assuranceText}>
              <strong>You get a reference number</strong>
              <span>Use it with your mobile number to see exactly what has happened.</span>
            </span>
          </div>
          <div className={styles.assurance}>
            <span className={styles.assuranceIcon}>
              <Shield size={16} />
            </span>
            <span className={styles.assuranceText}>
              <strong>It reaches a real officer</strong>
              <span>
                Routed by district and flagged to the officers responsible the moment you file.
              </span>
            </span>
          </div>
        </div>

        <ComplaintForm />

        <p className={styles.footNote}>
          Already filed one? <Link href="/complaint/track">Check its status</Link>. Reporting a
          specific registered instrument by its certificate number?{' '}
          <Link href="/report">Use the instrument report form</Link> instead.
          <br />
          Legal Metrology Department · complaints under the Legal Metrology Act, 2009
        </p>
      </div>
    </div>
  );
}
