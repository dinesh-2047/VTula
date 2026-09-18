'use client';

import { use, useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  ArrowLeft,
  Loader2,
  Scale,
  Gauge,
  BadgeCheck,
  Calendar,
  MapPin,
  Building2,
  Phone,
  Mail,
  ShieldCheck,
  ShieldOff,
  ShieldAlert,
  FileText,
  Award,
  ClipboardCheck,
  History,
  AlertTriangle,
  ImageIcon,
  BookOpen,
  ExternalLink,
  Navigation,
  Flag,
  Truck,
  CircleSlash,
  Factory,
} from 'lucide-react';
import {
  formatDate,
  formatDateTime,
  instrumentStatusLabel,
  applicationStatusLabel,
  certificateStatusLabel,
  statusBadgeClass,
  DOCUMENT_TYPE_LABELS,
  type DocumentType,
} from '@/lib/constants';
import InstrumentActions from './InstrumentActions';
import styles from './passport.module.css';

/**
 * The instrument's digital passport (spec §9).
 *
 * The spec is explicit that the **instrument**, not the certificate, is the
 * record of truth: one physical machine, one permanent record, carrying every
 * application, inspection, certificate, move and owner it has ever had. Nothing
 * in the product surfaced that. An instrument existed only as a card in a list,
 * and `GET /api/instruments/[id]` — written for this page — had no caller.
 *
 * Everything here is read from that endpoint. In particular the headline verdict
 * comes from the server's `verification` block, which derives the standing from
 * the current certificate at request time. Deriving it in the browser instead
 * would mean a device with a wrong clock showing a wrong legal status, which is
 * the bug the public verify page used to have.
 */

interface OwnerRef {
  _id: string;
  name?: string;
  organizationName?: string;
  phone?: string;
  email?: string;
}

interface CertificateRow {
  _id: string;
  certNo: string;
  issuedDate: string;
  expiryDate: string;
  status: string;
  version?: number;
  supersedesId?: string;
  supersededById?: string;
  verificationCount?: number;
}

interface Reading {
  label: string;
  reference: number;
  observed: number;
  unit: string;
  error: number;
  errorPercent: number;
  maxErrorPercent: number;
  withinTolerance: boolean;
}

interface InspectionRow {
  _id: string;
  inspectionNo: string;
  inspectedAt: string;
  result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  version: number;
  isSuperseded: boolean;
  sealDetails?: { sealNo?: string; stampedAt?: string; stampLocation?: string };
  readings?: Reading[];
  gpsDriftMetres?: number;
}

interface ApplicationRow {
  _id: string;
  applicationNo: string;
  type: string;
  status: string;
  submittedDate?: string;
  completedDate?: string;
  dueDate?: string;
  feeAmount?: number;
  feeStatus?: string;
}

interface TimelineEvent {
  _id: string;
  eventType: string;
  title: string;
  description?: string;
  occurredAt: string;
  isSystem?: boolean;
  actorRole?: string;
  actorId?: { name?: string; role?: string; designation?: string } | string | null;
}

interface PhotoRow {
  _id: string;
  fileName?: string;
  mimeType?: string;
  documentType?: DocumentType;
  createdAt?: string;
  href: string;
}

interface RiskFlagRow {
  _id: string;
  flagType: string;
  level: string;
  score?: number;
  title: string;
  reasons?: string[];
  recommendedAction?: string;
  status: string;
  detectedAt: string;
}

interface OwnershipEntry {
  ownerId?: string;
  ownerName?: string;
  from: string;
  to?: string;
  note?: string;
}

interface LocationEntry {
  address?: string;
  installationState?: string;
  installationDistrict?: string;
  gpsCoordinates?: { lat: number; lng: number };
  from: string;
  to?: string;
  note?: string;
}

export interface PassportInstrument {
  _id: string;
  type: string;
  brand?: string;
  model?: string;
  serialNo: string;
  capacity?: string;
  capacityValue?: number;
  capacityUnit?: string;
  accuracyClass?: string;
  modelApprovalNo?: string;
  manufactureYear?: number;
  installationState?: string;
  installationDistrict?: string;
  address?: string;
  gpsCoordinates?: { lat: number; lng: number };
  gpsLabel: string;
  installationDate?: string;
  status: string;
  lastVerifiedDate?: string;
  nextVerificationDue?: string;
  daysToDue: number | null;
  verificationCount?: number;
  failedInspectionCount?: number;
  duplicateReviewPending?: boolean;
  isDecommissioned?: boolean;
  decommissionedAt?: string;
  decommissionReason?: string;
  ownerId?: OwnerRef | string;
  ownershipHistory?: OwnershipEntry[];
  locationHistory?: LocationEntry[];
  photos?: string[];
  createdAt?: string;
}

interface PassportData {
  instrument: PassportInstrument;
  verification: { certNo: string; expiryDate: string; status: string } | null;
  timeline: TimelineEvent[];
  applications: ApplicationRow[];
  certificates: CertificateRow[];
  inspections: InspectionRow[];
  photos: PhotoRow[];
  legacyPhotos: string[];
  riskFlags: RiskFlagRow[];
  applicableRule: {
    name: string;
    matchedScope: string;
    validityMonths: number;
    requiredDocuments: string[];
    legalReference?: string;
    tolerances: { label: string; maxErrorPercent: number }[];
  };
}

export default function InstrumentPassportPage({ params }: { params: Promise<{ id: string }> }) {
  // Next 16 passes `params` as a Promise. In a Client Component page it is
  // unwrapped with React's `use`, per next/dist/docs dynamic-routes.
  const { id } = use(params);
  const { data: session } = useSession();

  const [data, setData] = useState<PassportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/instruments/${id}`);
      const body = (await res.json()) as
        | ({ success: true } & PassportData)
        | { success: false; error?: string };

      if (!body.success) {
        setData(null);
        setError(body.error || 'This instrument could not be loaded.');
      } else {
        setError(null);
        setData(body);
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // The await defers every setState in `load` past this commit; without it the
    // React compiler lint (correctly) reads the fetch as a synchronous cascade.
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={34} className={styles.spin} />
        <p>Loading instrument record…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={styles.errorWrap}>
        <ShieldOff size={40} />
        <h2>Record not available</h2>
        {/*
          * The API answers 404 rather than 403 for an instrument outside the
          * caller's scope, so ids stay non-enumerable. That means "not yours" and
          * "does not exist" read the same here, deliberately.
          */}
        <p>{error}</p>
        <Link href="/dashboard/instruments" className="clay-btn clay-btn-primary">
          Back to instruments
        </Link>
      </div>
    );
  }

  const { instrument: inst, verification, applicableRule: rule } = data;
  const owner = typeof inst.ownerId === 'object' && inst.ownerId ? inst.ownerId : null;
  const isOwner = !!session?.user?.id && !!owner && session.user.id === owner._id;
  const role = session?.user?.role ?? 'Owner';
  const title = [inst.brand, inst.model].filter(Boolean).join(' ') || inst.type;

  const standing = describeStanding(inst, verification);

  return (
    <div className={styles.page}>
      <Link href="/dashboard/instruments" className={styles.backLink}>
        <ArrowLeft size={16} />
        All instruments
      </Link>

      <header className={styles.header}>
        <div className={styles.headerIcon}>
          <Scale size={30} />
        </div>
        <div className={styles.headerText}>
          <div className={styles.headerTitleRow}>
            <h1>{title}</h1>
            <span className={`clay-badge ${statusBadgeClass(inst.status)}`}>
              {instrumentStatusLabel(inst.status)}
            </span>
          </div>
          <p className={styles.headerMeta}>
            {inst.type}
            {' · '}
            <span className={styles.mono}>{inst.serialNo}</span>
          </p>
        </div>
        {isOwner && !inst.isDecommissioned && (
          <InstrumentActions instrument={inst} onChanged={load} />
        )}
      </header>

      {/*
        * The one question an owner or an officer actually opens this page to
        * answer: may this machine be used for trade today, and until when.
        */}
      <section className={`${styles.standing} ${styles[standing.tone]}`}>
        <div className={styles.standingIcon}>{standing.icon}</div>
        <div className={styles.standingText}>
          <strong>{standing.headline}</strong>
          <span>{standing.detail}</span>
        </div>
        {verification && (
          <Link
            href={`/verify/${encodeURIComponent(verification.certNo)}`}
            className="clay-btn clay-btn-sm clay-btn-secondary"
          >
            <ExternalLink size={14} />
            Public check
          </Link>
        )}
      </section>

      {inst.duplicateReviewPending && (
        <div className={styles.noticeWarn}>
          <AlertTriangle size={18} />
          <span>
            This serial number closely matches another registered instrument and is under review.
            Verification cannot be issued until the department resolves the duplicate.
          </span>
        </div>
      )}

      {inst.isDecommissioned && (
        <div className={styles.noticeMuted}>
          <CircleSlash size={18} />
          <span>
            Decommissioned on {formatDate(inst.decommissionedAt)}
            {inst.decommissionReason ? ` — ${inst.decommissionReason}` : ''}. The record is retained
            for audit; it cannot be verified or transferred.
          </span>
        </div>
      )}

      {data.riskFlags.length > 0 && (
        <section className={`${styles.card} ${styles.riskCard}`}>
          <h2>
            <Flag size={17} />
            Open risk flags
            <span className={styles.countPill}>{data.riskFlags.length}</span>
          </h2>
          {/*
            * Officials only — the API omits `riskFlags` entirely for an owner, so
            * an internal advisory signal never becomes something an owner can
            * game or contest before an officer has reviewed it.
            */}
          <ul className={styles.riskList}>
            {data.riskFlags.map((flag) => (
              <li key={flag._id}>
                <span className={`clay-badge ${riskBadge(flag.level)}`}>{flag.level}</span>
                <div>
                  <strong>{flag.title}</strong>
                  {flag.reasons && flag.reasons.length > 0 && (
                    <ul className={styles.reasonList}>
                      {flag.reasons.map((reason, i) => (
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                  )}
                  {flag.recommendedAction && (
                    <p className={styles.recommended}>Recommended: {flag.recommendedAction}</p>
                  )}
                  <time>
                    Detected {formatDateTime(flag.detectedAt)}
                    {typeof flag.score === 'number' ? ` · score ${flag.score}` : ''}
                  </time>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={styles.columns}>
        <div className={styles.colMain}>
          <section className={styles.card}>
            <h2>
              <Gauge size={17} />
              Identity &amp; specification
            </h2>
            <dl className={styles.detailList}>
              <Row label="Category">{inst.type}</Row>
              <Row label="Make and model">
                {[inst.brand, inst.model].filter(Boolean).join(' · ') || 'Not recorded'}
              </Row>
              <Row label="Serial number">
                <code>{inst.serialNo}</code>
              </Row>
              <Row label="Capacity">
                {inst.capacity ||
                  (inst.capacityValue
                    ? `${inst.capacityValue} ${inst.capacityUnit ?? ''}`.trim()
                    : 'Not recorded')}
              </Row>
              <Row label="Accuracy class">{inst.accuracyClass || 'Not recorded'}</Row>
              <Row label="Model approval">
                {inst.modelApprovalNo ? <code>{inst.modelApprovalNo}</code> : 'Not recorded'}
              </Row>
              <Row label="Year of manufacture">{inst.manufactureYear || 'Not recorded'}</Row>
              <Row label="Installed on">{formatDate(inst.installationDate)}</Row>
              <Row label="On the register since">{formatDate(inst.createdAt)}</Row>
            </dl>
            <p className={styles.note}>
              Category, make, model and serial number are fixed once registered. They are what a
              certificate was issued against and what a QR scan is matched to, so a mistake in them
              is corrected by decommissioning this record and registering the instrument again —
              not by editing history.
            </p>
          </section>

          <section className={styles.card}>
            <h2>
              <MapPin size={17} />
              Where it is
            </h2>
            <dl className={styles.detailList}>
              <Row label="Address">{inst.address || 'Not recorded'}</Row>
              <Row label="District">{inst.installationDistrict || 'Not recorded'}</Row>
              <Row label="State">{inst.installationState || 'Not recorded'}</Row>
              <Row label="GPS">
                {inst.gpsCoordinates ? (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${inst.gpsCoordinates.lat},${inst.gpsCoordinates.lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.mapLink}
                  >
                    <Navigation size={13} />
                    {inst.gpsLabel}
                  </a>
                ) : (
                  inst.gpsLabel
                )}
              </Row>
            </dl>

            {(inst.locationHistory?.length ?? 0) > 1 && (
              <>
                <h3 className={styles.subHead}>
                  <Truck size={14} />
                  Movement history
                </h3>
                <ol className={styles.history}>
                  {[...(inst.locationHistory ?? [])].reverse().map((entry, i) => (
                    <li key={`${entry.from}-${i}`}>
                      <div>
                        <strong>
                          {[entry.installationDistrict, entry.installationState]
                            .filter(Boolean)
                            .join(', ') || 'Location'}
                        </strong>
                        <p>{entry.address}</p>
                        {entry.note && <p className={styles.historyNote}>{entry.note}</p>}
                      </div>
                      <time>
                        {formatDate(entry.from)} — {entry.to ? formatDate(entry.to) : 'present'}
                      </time>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>

          <section className={styles.card}>
            <h2>
              <Award size={17} />
              Certificates
              {data.certificates.length > 0 && (
                <span className={styles.countPill}>{data.certificates.length}</span>
              )}
            </h2>
            {data.certificates.length === 0 ? (
              <p className={styles.empty}>
                No certificate has been issued for this instrument yet.
              </p>
            ) : (
              <ul className={styles.rowList}>
                {data.certificates.map((cert) => {
                  const isCurrent = verification?.certNo === cert.certNo;
                  return (
                    <li key={cert._id} className={isCurrent ? styles.rowCurrent : undefined}>
                      <div className={styles.rowMain}>
                        <span className={styles.mono}>{cert.certNo}</span>
                        <span className={styles.rowSub}>
                          Issued {formatDate(cert.issuedDate)} · valid to{' '}
                          {formatDate(cert.expiryDate)}
                          {cert.version && cert.version > 1 ? ` · v${cert.version}` : ''}
                          {typeof cert.verificationCount === 'number'
                            ? ` · checked ${cert.verificationCount}×`
                            : ''}
                        </span>
                      </div>
                      <div className={styles.rowSide}>
                        {isCurrent && <span className={styles.currentTag}>current</span>}
                        <span className={`clay-badge ${statusBadgeClass(cert.status)}`}>
                          {certificateStatusLabel(cert.status)}
                        </span>
                        <Link
                          href={`/verify/${encodeURIComponent(cert.certNo)}`}
                          className={styles.rowLink}
                          title="Open the public verification page"
                        >
                          <ExternalLink size={14} />
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className={styles.card}>
            <h2>
              <ClipboardCheck size={17} />
              Inspections
              {data.inspections.length > 0 && (
                <span className={styles.countPill}>{data.inspections.length}</span>
              )}
            </h2>
            {data.inspections.length === 0 ? (
              <p className={styles.empty}>No inspection has been recorded yet.</p>
            ) : (
              <ul className={styles.inspectionList}>
                {data.inspections.map((insp) => {
                  const worst = worstReading(insp.readings);
                  return (
                    <li
                      key={insp._id}
                      className={insp.isSuperseded ? styles.superseded : undefined}
                    >
                      <div className={styles.inspTop}>
                        <span className={styles.mono}>{insp.inspectionNo}</span>
                        <span className={`clay-badge ${resultBadge(insp.result)}`}>
                          {insp.result}
                        </span>
                        {insp.version > 1 && (
                          <span className={styles.versionTag}>version {insp.version}</span>
                        )}
                        {insp.isSuperseded && (
                          <span className={styles.versionTag}>corrected later</span>
                        )}
                      </div>
                      <p className={styles.inspMeta}>
                        {formatDateTime(insp.inspectedAt)}
                        {insp.readings && insp.readings.length > 0
                          ? ` · ${insp.readings.length} test point${insp.readings.length === 1 ? '' : 's'}`
                          : ''}
                        {worst !== null ? ` · largest error ${worst.toFixed(3)}%` : ''}
                        {typeof insp.gpsDriftMetres === 'number'
                          ? ` · ${Math.round(insp.gpsDriftMetres)} m from the registered site`
                          : ''}
                      </p>
                      {insp.sealDetails?.sealNo && (
                        <p className={styles.sealLine}>
                          <BadgeCheck size={13} />
                          Seal <code>{insp.sealDetails.sealNo}</code>
                          {insp.sealDetails.stampedAt
                            ? ` stamped ${formatDate(insp.sealDetails.stampedAt)}`
                            : ''}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className={styles.card}>
            <h2>
              <FileText size={17} />
              Applications
              {data.applications.length > 0 && (
                <span className={styles.countPill}>{data.applications.length}</span>
              )}
            </h2>
            {data.applications.length === 0 ? (
              <p className={styles.empty}>No application has been filed for this instrument.</p>
            ) : (
              <ul className={styles.rowList}>
                {data.applications.map((app) => (
                  <li key={app._id}>
                    <div className={styles.rowMain}>
                      <span className={styles.mono}>{app.applicationNo}</span>
                      <span className={styles.rowSub}>
                        {app.type}
                        {app.submittedDate ? ` · filed ${formatDate(app.submittedDate)}` : ''}
                        {app.completedDate ? ` · closed ${formatDate(app.completedDate)}` : ''}
                        {typeof app.feeAmount === 'number' && app.feeAmount > 0
                          ? ` · fee ₹${app.feeAmount}${app.feeStatus ? ` (${app.feeStatus})` : ''}`
                          : ''}
                      </span>
                    </div>
                    <div className={styles.rowSide}>
                      <span className={`clay-badge ${statusBadgeClass(app.status)}`}>
                        {applicationStatusLabel(app.status)}
                      </span>
                      <Link
                        href={`/dashboard/applications/${app._id}`}
                        className={styles.rowLink}
                        title="Open the application"
                      >
                        <ExternalLink size={14} />
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(data.photos.length > 0 || data.legacyPhotos.length > 0) && (
            <section className={styles.card}>
              <h2>
                <ImageIcon size={17} />
                Photographs
              </h2>
              <div className={styles.photoGrid}>
                {data.photos.map((photo) => (
                  <a
                    key={photo._id}
                    href={photo.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.photo}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- served by our own /api/documents route, not an optimisable static asset */}
                    <img src={photo.href} alt={photo.fileName || 'Instrument photograph'} />
                    <span>
                      {photo.documentType
                        ? DOCUMENT_TYPE_LABELS[photo.documentType]
                        : photo.fileName}
                    </span>
                  </a>
                ))}
                {data.legacyPhotos.map((url, i) => (
                  <a
                    key={`legacy-${i}`}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.photo}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- legacy inline URL from before document storage existed */}
                    <img src={url} alt="Instrument photograph" />
                    <span>Uploaded before document records</span>
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className={styles.colSide}>
          <section className={styles.card}>
            <h2>
              <Building2 size={17} />
              Registered to
            </h2>
            {owner ? (
              <dl className={styles.detailList}>
                <Row label="Owner">{owner.name || 'Not recorded'}</Row>
                {owner.organizationName && (
                  <Row label="Business">{owner.organizationName}</Row>
                )}
                {owner.phone && (
                  <Row label="Phone">
                    <a href={`tel:${owner.phone}`} className={styles.mapLink}>
                      <Phone size={13} />
                      {owner.phone}
                    </a>
                  </Row>
                )}
                {owner.email && (
                  <Row label="Email">
                    <a href={`mailto:${owner.email}`} className={styles.mapLink}>
                      <Mail size={13} />
                      {owner.email}
                    </a>
                  </Row>
                )}
              </dl>
            ) : (
              <p className={styles.empty}>Owner details are not available.</p>
            )}

            {(inst.ownershipHistory?.length ?? 0) > 1 && (
              <>
                <h3 className={styles.subHead}>
                  <History size={14} />
                  Previous owners
                </h3>
                <ol className={styles.history}>
                  {[...(inst.ownershipHistory ?? [])].reverse().map((entry, i) => (
                    <li key={`${entry.from}-${i}`}>
                      <div>
                        <strong>{entry.ownerName || 'Owner'}</strong>
                        {entry.note && <p className={styles.historyNote}>{entry.note}</p>}
                      </div>
                      <time>
                        {formatDate(entry.from)} — {entry.to ? formatDate(entry.to) : 'present'}
                      </time>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>

          <section className={styles.card}>
            <h2>
              <Calendar size={17} />
              Verification record
            </h2>
            <dl className={styles.detailList}>
              <Row label="Last verified">{formatDate(inst.lastVerifiedDate)}</Row>
              <Row label="Next due">
                {inst.nextVerificationDue ? (
                  <span
                    className={
                      inst.daysToDue !== null && inst.daysToDue < 0 ? styles.badText : undefined
                    }
                  >
                    {formatDate(inst.nextVerificationDue)}
                    {inst.daysToDue !== null
                      ? inst.daysToDue >= 0
                        ? ` · in ${inst.daysToDue} day${inst.daysToDue === 1 ? '' : 's'}`
                        : ` · overdue by ${Math.abs(inst.daysToDue)} day${Math.abs(inst.daysToDue) === 1 ? '' : 's'}`
                      : ''}
                  </span>
                ) : (
                  'Not scheduled'
                )}
              </Row>
              <Row label="Times verified">{inst.verificationCount ?? 0}</Row>
              {(inst.failedInspectionCount ?? 0) > 0 && (
                <Row label="Failed inspections">
                  <span className={styles.badText}>{inst.failedInspectionCount}</span>
                </Row>
              )}
            </dl>
          </section>

          {/*
            * Which rule governs this instrument, and what it demands. Shown because
            * the validity period, the documents an application must carry and the
            * permissible error are all rule-driven — an owner who cannot see the
            * tolerance table cannot tell why an inspection failed.
            */}
          <section className={styles.card}>
            <h2>
              <BookOpen size={17} />
              Applicable rule
            </h2>
            <dl className={styles.detailList}>
              <Row label="Rule">{rule.name}</Row>
              <Row label="Matched by">{rule.matchedScope}</Row>
              <Row label="Validity">
                {rule.validityMonths} month{rule.validityMonths === 1 ? '' : 's'}
              </Row>
              {rule.legalReference && <Row label="Legal basis">{rule.legalReference}</Row>}
            </dl>

            {rule.tolerances.length > 0 && (
              <>
                <h3 className={styles.subHead}>
                  <Gauge size={14} />
                  Permissible error
                </h3>
                <table className={styles.toleranceTable}>
                  <thead>
                    <tr>
                      <th>Test point</th>
                      <th>Max error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rule.tolerances.map((tol, i) => (
                      <tr key={i}>
                        <td>{tol.label}</td>
                        <td>±{tol.maxErrorPercent}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {rule.requiredDocuments.length > 0 && (
              <>
                <h3 className={styles.subHead}>
                  <FileText size={14} />
                  Documents required
                </h3>
                <ul className={styles.docList}>
                  {rule.requiredDocuments.map((doc) => (
                    <li key={doc}>{DOCUMENT_TYPE_LABELS[doc as DocumentType] ?? doc}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {role === 'Owner' && !inst.isDecommissioned && (
            <section className={`${styles.card} ${styles.actionCard}`}>
              <h2>
                <Factory size={17} />
                Need verification?
              </h2>
              <p className={styles.note}>
                File an application and the department will schedule an inspection at the address
                above.
              </p>
              <Link
                href={`/dashboard/applications/new?instrumentId=${inst._id}`}
                className="clay-btn clay-btn-primary clay-btn-sm"
              >
                Apply for verification
              </Link>
            </section>
          )}
        </aside>
      </div>

      {/*
        * The append-only record. Every state change writes an InstrumentEvent, so
        * this is the audit trail rather than a rendering of the current row.
        */}
      <section className={styles.card}>
        <h2>
          <History size={17} />
          Full history
          {data.timeline.length > 0 && (
            <span className={styles.countPill}>{data.timeline.length}</span>
          )}
        </h2>
        {data.timeline.length === 0 ? (
          <p className={styles.empty}>Nothing has happened to this instrument yet.</p>
        ) : (
          <ol className={styles.timeline}>
            {data.timeline.map((event) => {
              const actor =
                typeof event.actorId === 'object' && event.actorId ? event.actorId : null;
              return (
                <li key={event._id}>
                  <span className={`${styles.timelineDot} ${eventDotClass(event.eventType)}`} />
                  <div>
                    <strong>{event.title}</strong>
                    {event.description && <p>{event.description}</p>}
                    <time>
                      {formatDateTime(event.occurredAt)}
                      {actor?.name
                        ? ` · ${actor.name}${actor.designation ? `, ${actor.designation}` : ''}`
                        : event.isSystem
                          ? ' · automatic'
                          : event.actorRole
                            ? ` · ${event.actorRole}`
                            : ''}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Turns the server-derived verification block into the sentence a person needs.
 *
 * Note what this does *not* do: it never recomputes expiry from a date. The
 * status arrives already derived by `effectiveStatus` server-side; this only
 * chooses wording.
 */
function describeStanding(
  inst: PassportInstrument,
  verification: { certNo: string; expiryDate: string; status: string } | null
): {
  tone: 'toneOk' | 'toneWarn' | 'toneBad';
  icon: ReactNode;
  headline: string;
  detail: string;
} {
  if (inst.isDecommissioned) {
    return {
      tone: 'toneBad',
      icon: <CircleSlash size={26} />,
      headline: 'Decommissioned',
      detail: 'This instrument is retired from service and must not be used for trade.',
    };
  }

  if (!verification) {
    return {
      tone: 'toneWarn',
      icon: <ShieldAlert size={26} />,
      headline: 'Not verified',
      detail:
        'No current verification certificate. Under the Legal Metrology Act, 2009 an unverified instrument may not be used for trade.',
    };
  }

  const until = formatDate(verification.expiryDate);

  switch (verification.status) {
    case 'ACTIVE':
      return {
        tone: 'toneOk',
        icon: <ShieldCheck size={26} />,
        headline: `Verified until ${until}`,
        detail: `Certificate ${verification.certNo} is current. This instrument may be used for trade.`,
      };
    case 'EXPIRING_SOON':
      return {
        tone: 'toneWarn',
        icon: <ShieldAlert size={26} />,
        headline: `Verification expires ${until}`,
        detail: `Certificate ${verification.certNo} is still valid, but apply for re-verification now to avoid a lapse.`,
      };
    case 'EXPIRED':
      return {
        tone: 'toneBad',
        icon: <ShieldOff size={26} />,
        headline: `Verification lapsed on ${until}`,
        detail: `Certificate ${verification.certNo} has expired. Using this instrument for trade is an offence until it is re-verified.`,
      };
    case 'SUSPENDED':
      return {
        tone: 'toneBad',
        icon: <ShieldOff size={26} />,
        headline: 'Verification suspended',
        detail: `Certificate ${verification.certNo} is suspended pending departmental action. The instrument must not be used for trade.`,
      };
    case 'REVOKED':
      return {
        tone: 'toneBad',
        icon: <ShieldOff size={26} />,
        headline: 'Verification revoked',
        detail: `Certificate ${verification.certNo} has been revoked. The instrument must not be used for trade.`,
      };
    default:
      return {
        tone: 'toneWarn',
        icon: <ShieldAlert size={26} />,
        headline: 'Verification superseded',
        detail: `Certificate ${verification.certNo} has been replaced. Check the current certificate for this instrument's standing.`,
      };
  }
}

function riskBadge(level: string): string {
  switch (level) {
    case 'CRITICAL':
    case 'HIGH':
      return 'clay-badge-error';
    case 'MEDIUM':
      return 'clay-badge-warning';
    default:
      return 'clay-badge-info';
  }
}

function resultBadge(result: string): string {
  return result === 'PASS'
    ? 'clay-badge-success'
    : result === 'FAIL'
      ? 'clay-badge-error'
      : 'clay-badge-warning';
}

/** Largest absolute reading error, used as the one number that summarises a test. */
function worstReading(readings: Reading[] | undefined): number | null {
  if (!readings || readings.length === 0) return null;
  return readings.reduce((max, r) => Math.max(max, Math.abs(r.errorPercent ?? 0)), 0);
}

function eventDotClass(eventType: string): string {
  switch (eventType) {
    case 'CERTIFICATE_ISSUED':
    case 'REGISTERED':
      return styles.dotOk;
    case 'CERTIFICATE_EXPIRED':
    case 'CERTIFICATE_REVOKED':
    case 'FLAGGED':
    case 'ENFORCEMENT_ACTION':
    case 'DECOMMISSIONED':
      return styles.dotBad;
    case 'INSPECTION_SCHEDULED':
    case 'APPLICATION_SUBMITTED':
      return styles.dotInfo;
    default:
      return '';
  }
}
