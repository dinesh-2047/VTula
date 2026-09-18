import Link from 'next/link';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowLeft,
  Calendar,
  Building2,
  Scale,
  Hash,
  Gauge,
  MapPin,
  Stamp,
  FileText,
  History,
  Search,
  Fingerprint,
  ArrowRight,
} from 'lucide-react';
import { publicVerify, type VerifyOutcome } from '@/lib/publicVerify';
import { certificateQrDataUrl } from '@/lib/certificates';
import { formatDate, formatDateTime } from '@/lib/constants';
import ReportProblem from '../ReportProblem';
import styles from '../verify.module.css';

/**
 * The public trust page — the URL a certificate's QR code actually encodes.
 *
 * `verifyUrl()` in `src/lib/certificates.ts` prints `${NEXTAUTH_URL}/verify/<certNo>`
 * onto every certificate and seal sticker. Until this file existed that path had
 * no page behind it, so **scanning the QR on a real certificate produced a 404**.
 * The only verification UI lived at `/verify?certNo=…`, which nothing pointed at.
 *
 * This is a Server Component that calls `publicVerify` directly rather than
 * fetching its own API route. Three reasons, all of them about the person holding
 * the phone:
 *
 *  - The verdict is in the first response. A citizen standing at a fuel pump on a
 *    2G connection does not wait for a JS bundle and then a second round trip.
 *  - It works with JavaScript disabled or still loading.
 *  - `publicVerify` records every lookup against a daily-salted hash of the
 *    requester's IP. Rendering here means the request being logged is the citizen's
 *    actual navigation, not a secondary fetch.
 *
 * What this page deliberately does not do: decide anything. The outcome, the
 * headline, the detail text and the integrity result are all computed server-side
 * in `publicVerify` from the stored certificate and its hash. The old page
 * recomputed `isExpired` in the browser from a date string, which meant a device
 * with a wrong clock reported a wrong legal status.
 */

export const dynamic = 'force-dynamic';

type Tone = 'ok' | 'warn' | 'bad';

const OUTCOME_TONE: Record<VerifyOutcome, Tone> = {
  VALID: 'ok',
  EXPIRING_SOON: 'warn',
  EXPIRED: 'bad',
  SUSPENDED: 'bad',
  REVOKED: 'bad',
  SUPERSEDED: 'warn',
  NOT_FOUND: 'bad',
  INTEGRITY_FAILED: 'bad',
};

export async function generateMetadata(props: {
  params: Promise<{ certNo: string }>;
}): Promise<Metadata> {
  const { certNo } = await props.params;
  const decoded = decodeURIComponent(certNo);
  return {
    title: `Verify certificate ${decoded} — VTULA`,
    description:
      'Check whether a weighing or measuring instrument is legally verified under the Legal Metrology Act, 2009.',
    // A verification result is about one instrument at one moment. Indexing it
    // would publish the register a page at a time.
    robots: { index: false, follow: false },
  };
}

export default async function VerifyCertificatePage(props: {
  params: Promise<{ certNo: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [{ certNo }, sp, requestHeaders] = await Promise.all([
    props.params,
    props.searchParams,
    headers(),
  ]);

  /*
   * A code scanned from a sticker is a QR scan; arriving from the manual form on
   * `/verify` is not. The distinction matters because enforcement reads the
   * verification log to tell "customers are scanning this pump" apart from "someone
   * is typing numbers into the lookup form".
   */
  const source = sp.src === 'manual' ? 'MANUAL' : 'QR';

  const result = await publicVerify(decodeURIComponent(certNo), {
    source,
    headers: requestHeaders,
  });

  const cert = result.certificate;
  const tone = OUTCOME_TONE[result.outcome];

  // Generated locally by `qrcode`. The old page fetched this from
  // api.qrserver.com, which made verification depend on a third party and handed
  // it the certificate number of everything anyone ever checked.
  const qrDataUrl = cert ? await certificateQrDataUrl(cert.certNo) : null;

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
            <Search size={16} />
            Check another number
          </Link>
        </div>

        {/* The verdict, first and largest. Everything below it is supporting detail. */}
        <div className={`${styles.verdict} ${toneClass(tone)}`}>
          <div className={styles.verdictIcon}>
            <VerdictIcon outcome={result.outcome} />
          </div>
          <h1>{result.headline}</h1>
          <p className={styles.verdictDetail}>{result.detail}</p>

          {cert && (
            <p className={styles.verdictCertNo}>
              <Hash size={14} />
              {cert.certNo}
              {cert.version > 1 && <span> · version {cert.version}</span>}
            </p>
          )}

          {/*
            * Stated plainly, because "the certificate exists" and "the instrument may
            * legally be used for trade today" are different questions and only the
            * second one is the one being asked at the counter.
            */}
          <p className={styles.tradeLine}>
            {result.isValidForTrade
              ? 'This instrument may be used for trade today.'
              : 'This instrument must not be used for trade.'}
          </p>
        </div>

        {result.supersededBy && (
          <div className={styles.supersededBox}>
            <ArrowRight size={18} />
            <div>
              <strong>Replaced by {result.supersededBy.certNo}</strong>
              <span>
                Valid until {formatDate(result.supersededBy.expiryDate)}. Check the replacement
                for the instrument&apos;s current standing.
              </span>
            </div>
            <Link
              href={`/verify/${encodeURIComponent(result.supersededBy.certNo)}`}
              className="clay-btn clay-btn-sm clay-btn-secondary"
            >
              Check it
            </Link>
          </div>
        )}

        {cert && (
          <>
            {/*
              * Identity first. The point of these fields is that a customer can match
              * them against the machine in front of them — a certificate that describes
              * a different instrument is as useless as no certificate at all.
              */}
            <section className={styles.card}>
              <h2>
                <Scale size={18} />
                What was verified
              </h2>
              <dl className={styles.detailList}>
                <Row icon={<Scale size={15} />} label="Instrument">
                  {[cert.instrument.type, cert.instrument.brand, cert.instrument.model]
                    .filter(Boolean)
                    .join(' · ') || 'Not recorded'}
                </Row>
                <Row icon={<Hash size={15} />} label="Serial number">
                  <code>{cert.instrument.serialNo || 'Not recorded'}</code>
                </Row>
                <Row icon={<Gauge size={15} />} label="Capacity">
                  {cert.instrument.capacity || 'Not recorded'}
                  {cert.instrument.accuracyClass
                    ? ` · accuracy class ${cert.instrument.accuracyClass}`
                    : ''}
                </Row>
                <Row icon={<Building2 size={15} />} label="Business">
                  {cert.verifiedBusiness}
                </Row>
                {(cert.instrument.district || cert.instrument.state) && (
                  <Row icon={<MapPin size={15} />} label="Installed in">
                    {[cert.instrument.district, cert.instrument.state].filter(Boolean).join(', ')}
                  </Row>
                )}
              </dl>
              <p className={styles.matchNote}>
                Compare the serial number above with the one on the instrument in front of you. If
                they do not match, the sticker does not belong to this machine.
              </p>
            </section>

            <section className={styles.card}>
              <h2>
                <Calendar size={18} />
                Validity
              </h2>
              <dl className={styles.detailList}>
                <Row icon={<Calendar size={15} />} label="Verified on">
                  {formatDate(cert.issuedDate)}
                </Row>
                <Row icon={<Calendar size={15} />} label="Valid until">
                  <span className={tone === 'bad' ? styles.badText : undefined}>
                    {formatDate(cert.expiryDate)}
                    {cert.daysToExpiry > 0
                      ? ` · ${cert.daysToExpiry} day${cert.daysToExpiry === 1 ? '' : 's'} left`
                      : ` · lapsed ${Math.abs(cert.daysToExpiry)} day${Math.abs(cert.daysToExpiry) === 1 ? '' : 's'} ago`}
                  </span>
                </Row>
                <Row icon={<Shield size={15} />} label="Status">
                  <span className={`clay-badge ${badgeClass(tone)}`}>{cert.statusLabel}</span>
                </Row>
                {cert.legalReference && (
                  <Row icon={<FileText size={15} />} label="Issued under">
                    {cert.legalReference}
                  </Row>
                )}
              </dl>
            </section>

            <section className={styles.card}>
              <h2>
                <Stamp size={18} />
                Who verified it
              </h2>
              <dl className={styles.detailList}>
                <Row icon={<Shield size={15} />} label="Designation">
                  {cert.issuedBy.designation ?? 'Legal Metrology Officer'}
                </Row>
                {cert.issuedBy.officerCode && (
                  <Row icon={<Hash size={15} />} label="Officer code">
                    <code>{cert.issuedBy.officerCode}</code>
                  </Row>
                )}
                {cert.issuedBy.office && (
                  <Row icon={<MapPin size={15} />} label="Office">
                    {cert.issuedBy.office}
                  </Row>
                )}
              </dl>
              {/*
                * The officer's name is intentionally absent. The office and the officer
                * code identify who is accountable; publishing an individual's name on an
                * unauthenticated page to anyone who scans a sticker does not.
                */}
              <p className={styles.matchNote}>
                Verifying officers are identified by office and officer code. Quote the certificate
                number above when contacting the office.
              </p>
            </section>

            {cert.inspection && (
              <section className={styles.card}>
                <h2>
                  <Gauge size={18} />
                  The inspection behind it
                </h2>
                <dl className={styles.detailList}>
                  <Row icon={<Calendar size={15} />} label="Inspected on">
                    {formatDateTime(cert.inspection.inspectedAt)}
                  </Row>
                  <Row icon={<CheckCircle2 size={15} />} label="Result">
                    {cert.inspection.result}
                  </Row>
                  <Row icon={<Gauge size={15} />} label="Test points">
                    {cert.inspection.readingCount} reading
                    {cert.inspection.readingCount === 1 ? '' : 's'} recorded
                    {typeof cert.inspection.maxErrorPercent === 'number'
                      ? ` · largest error ${cert.inspection.maxErrorPercent.toFixed(3)}%`
                      : ''}
                  </Row>
                  {cert.inspection.sealNo && (
                    <Row icon={<Stamp size={15} />} label="Seal number">
                      <code>{cert.inspection.sealNo}</code>
                    </Row>
                  )}
                </dl>
              </section>
            )}

            {/*
              * The integrity check is the actual answer to "is this certificate real".
              * It is shown, with its result, rather than replaced by a reassuring
              * padlock — the old officer console printed the literal string
              * "HMAC-SHA256-<mongo id>" and called it a digital signature.
              */}
            {result.integrity && (
              <section
                className={`${styles.card} ${
                  result.integrity.hashValid ? styles.integrityOk : styles.integrityBad
                }`}
              >
                <h2>
                  <Fingerprint size={18} />
                  Authenticity check
                </h2>
                <ul className={styles.integrityList}>
                  <li>
                    {result.integrity.hashValid ? (
                      <CheckCircle2 size={15} />
                    ) : (
                      <XCircle size={15} />
                    )}
                    <span>
                      Contents {result.integrity.hashValid ? 'match' : 'do not match'} their
                      recorded hash
                    </span>
                  </li>
                  <li>
                    {result.integrity.signatureValid ? (
                      <CheckCircle2 size={15} />
                    ) : (
                      <AlertTriangle size={15} />
                    )}
                    <span>
                      Issuer signature {result.integrity.signatureValid ? 'verified' : 'not verified'}
                    </span>
                  </li>
                </ul>
                <p className={styles.matchNote}>{result.integrity.detail}</p>
              </section>
            )}

            {result.history.length > 0 && (
              <section className={styles.card}>
                <h2>
                  <History size={18} />
                  History
                </h2>
                <ol className={styles.timeline}>
                  {result.history.map((event, i) => (
                    <li key={`${event.eventType}-${i}`}>
                      <span className={styles.timelineDot} />
                      <div>
                        <strong>{event.eventType.replace(/_/g, ' ').toLowerCase()}</strong>
                        <p>{event.summary}</p>
                        <time>{formatDateTime(event.occurredAt)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section className={styles.card}>
              <h2>
                <Shield size={18} />
                Share this check
              </h2>
              <div className={styles.shareRow}>
                {qrDataUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element -- a locally generated data URL, not a remote asset */
                  <img
                    src={qrDataUrl}
                    alt={`QR code linking to the verification page for certificate ${cert.certNo}`}
                    width={140}
                    height={140}
                    className={styles.shareQr}
                  />
                )}
                <div>
                  <p className={styles.matchNote}>
                    This is the same code printed on the certificate. Anyone can scan it to reach
                    this page — no account needed.
                  </p>
                  <code className={styles.shareUrl}>{cert.verifyUrl}</code>
                  <p className={styles.countNote}>
                    Checked {cert.verificationCount} time
                    {cert.verificationCount === 1 ? '' : 's'}.
                  </p>
                </div>
              </div>
            </section>
          </>
        )}

        {/*
          * Every outcome ends somewhere a citizen can act. The spec's verification
          * story finishes here: a customer scans a fuel dispenser, finds the
          * certificate lapsed, and needs a way to say so. Until now the page ended in
          * a dead end, and `POST /api/enforcement`'s public intake path had no caller.
          */}
        <ReportProblem
          certNo={cert?.certNo ?? decodeURIComponent(certNo)}
          certExists={result.found}
          outcome={result.outcome}
          startExpanded={!result.isValidForTrade}
        />

        <div className={styles.footer}>
          <p>
            <Shield size={14} />
            Legal Metrology Department · verification under the Legal Metrology Act, 2009
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

function toneClass(tone: Tone): string {
  return tone === 'ok' ? styles.verdictOk : tone === 'warn' ? styles.verdictWarn : styles.verdictBad;
}

function badgeClass(tone: Tone): string {
  return tone === 'ok'
    ? 'clay-badge-success'
    : tone === 'warn'
      ? 'clay-badge-warning'
      : 'clay-badge-error';
}

function VerdictIcon({ outcome }: { outcome: VerifyOutcome }) {
  switch (outcome) {
    case 'VALID':
      return <ShieldCheck size={52} />;
    case 'EXPIRING_SOON':
    case 'SUPERSEDED':
      return <ShieldAlert size={52} />;
    case 'INTEGRITY_FAILED':
      return <ShieldOff size={52} />;
    case 'NOT_FOUND':
      return <XCircle size={52} />;
    default:
      return <ShieldOff size={52} />;
  }
}

function Row({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.detailRow}>
      <dt>
        {icon}
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
