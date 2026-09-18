import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, Megaphone, Scale, Search, Shield, UserX } from 'lucide-react';
import { extractCertNo } from '@/lib/constants';
import ReportForm from './ReportForm';
import styles from './report.module.css';

/**
 * Public complaint intake.
 *
 * The unauthenticated branch of `POST /api/enforcement` was built for the citizen
 * standing at a counter who thinks they have been short-measured. Until now the
 * only way to reach it was the complaint panel on a certificate's verdict page,
 * which requires a certificate number that resolves — so anyone whose sticker was
 * missing, scratched off, or never applied had no route in at all. That is the
 * population most likely to have something worth reporting.
 *
 * This page is also the destination for the "report an instrument" link an officer
 * sees when their role has no enforcement powers, so it has to stand on its own
 * rather than assume the reader arrived from a scan.
 *
 * Everything that decides where the case goes is derived on the server from the
 * instrument. Nothing on this page can steer a complaint towards or away from a
 * particular office.
 */

export const metadata: Metadata = {
  title: 'Report a weighing or measuring instrument — VTULA',
  description:
    'Report a suspected short measure, a broken seal, or an instrument in trade use without a current verification. Goes to the Legal Metrology office for the district where the instrument is registered. No account needed.',
};

export default async function ReportPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;

  /*
   * Parsed with the same helper the verify pages use, so a link carrying a full
   * `/verify/VT-CERT-…` URL prefills correctly instead of dropping the number into
   * the box verbatim.
   */
  const rawCert = typeof sp.certNo === 'string' ? sp.certNo : undefined;
  const initialCertNo = rawCert ? extractCertNo(rawCert) ?? rawCert.trim() : undefined;
  const initialSerialNo = typeof sp.serialNo === 'string' ? sp.serialNo.trim() : undefined;

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
          <Link href="/verify" className={styles.backLink}>
            <Search size={15} />
            Check a certificate instead
          </Link>
        </div>

        <header className={styles.header}>
          <div className={styles.logoIcon}>
            <Megaphone size={30} />
          </div>
          <h1>Report an instrument</h1>
          <p>
            If a shop&apos;s scale, a petrol pump or a water meter looks wrong — short measure, a
            broken seal, no verification sticker — you can put it on the department&apos;s record
            here. No account, no charge, and you do not have to give your name.
          </p>
        </header>

        <ReportForm initialCertNo={initialCertNo} initialSerialNo={initialSerialNo} />

        {/* What happens next, stated before it is asked. A complaint that vanishes
            into a form is a complaint nobody files a second time. */}
        <section className={styles.howCard}>
          <h2>What happens to your report</h2>
          <ol className={styles.howList}>
            <li>
              <Scale size={17} />
              <div>
                <strong>It is matched to the registered instrument</strong>
                <span>
                  The serial or certificate number identifies the machine, and the case is routed to
                  the Legal Metrology office for the district where that machine is installed.
                </span>
              </div>
            </li>
            <li>
              <Shield size={17} />
              <div>
                <strong>An officer triages it</strong>
                <span>
                  Officers in that district are notified the moment it arrives. They decide whether
                  it warrants an inspection, and how serious it is — a complainant cannot set that,
                  which is what stops the queue being gamed.
                </span>
              </div>
            </li>
            <li>
              <UserX size={17} />
              <div>
                <strong>The business is told there is a case, not who filed it</strong>
                <span>
                  Your name, phone and email are never shown to the business, and if you file
                  anonymously they are never stored. The department cannot reveal what it does not
                  hold.
                </span>
              </div>
            </li>
          </ol>
        </section>

        <div className={styles.footer}>
          <p>
            <Shield size={14} />
            Legal Metrology Department · reporting under the Legal Metrology Act, 2009
          </p>
        </div>
      </div>
    </div>
  );
}
