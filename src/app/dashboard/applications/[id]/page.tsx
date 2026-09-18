'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarClock,
  Camera,
  CheckCircle2,
  Circle,
  ClipboardList,
  Clock,
  ExternalLink,
  FileText,
  Gauge,
  IndianRupee,
  Loader2,
  MapPin,
  MessageSquareWarning,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Stamp,
  UserCheck,
  XCircle,
} from 'lucide-react';
import {
  APPLICATION_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  VERIFICATION_TYPE_LABELS,
  applicationStatusLabel,
  formatDate,
  formatDateTime,
  statusBadgeClass,
  type ApplicationStatus,
  type DocumentType,
  type VerificationType,
} from '@/lib/constants';
import OfficerDecision from './OfficerDecision';
import OwnerActions from './OwnerActions';
import styles from './application.module.css';

/**
 * One application, in full.
 *
 * This page did not exist. `GET /api/applications/[id]` was written for it and
 * had no caller, and three other places in the product already linked here:
 * the new-application page tells an owner whose payment fell through that they
 * "can pay from the application page"; the officer notification for a new filing
 * sets `actionUrl: /dashboard/applications/<id>`; and the instrument passport
 * links each application to its record. All three were dead ends — the two
 * user-facing ones being 404s at the exact moment a person was trying to act.
 *
 * What lives here that lived nowhere before:
 *  - the status history, so an applicant can see who moved their file and why,
 *    rather than watching a single opaque badge change;
 *  - the officer's query and the applicant's reply to it — `PATCH` has accepted a
 *    `queryResponse` all along, and no screen ever sent one, so a QUERY_RAISED
 *    application was unresolvable through the UI and simply aged out;
 *  - the inspection readings the decision rests on, with the tolerance each
 *    reading was judged against;
 *  - the fee, and a way to pay it after the fact;
 *  - the decision itself, with its written justification and legal reference.
 *
 * Every action shown to an officer comes from the server's own
 * `availableTransitions`, never from a status list written out again here. The
 * state machine is enforced in `src/lib/workflow.ts`; a second copy in the UI
 * would eventually offer a button the server refuses, which reads to the officer
 * as the system being broken.
 */

interface Populated {
  _id: string;
  name?: string;
  role?: string;
  designation?: string;
  officerCode?: string;
  phone?: string;
  email?: string;
  organizationName?: string;
}

interface StatusEntry {
  from?: string;
  to: string;
  actorId?: Populated | string;
  actorRole?: string;
  reason?: string;
  isSystem: boolean;
  at: string;
}

interface QueryEntry {
  raisedBy?: Populated | string;
  raisedAt: string;
  message: string;
  requestedDocuments: string[];
  dueBy?: string;
  resolvedAt?: string;
  response?: string;
  responseDocumentIds?: string[];
}

export interface ApplicationDetail {
  _id: string;
  applicationNo: string;
  type: VerificationType;
  status: ApplicationStatus;
  jurisdiction?: { state: string; district: string };
  submittedDate?: string;
  scheduledDate?: string;
  completedDate?: string;
  dueDate?: string;
  feeAmount: number;
  feePaid: number;
  feeStatus: string;
  paymentId?: string;
  paymentVerifiedAt?: string;
  assignedTo?: Populated | string;
  assignedType?: string;
  inspectionLocation: string;
  preferredDate?: string;
  remarks?: string;
  ownerId?: Populated | string;
  statusHistory: StatusEntry[];
  queries: QueryEntry[];
  decision?: {
    outcome: 'APPROVED' | 'REJECTED';
    decidedBy?: Populated | string;
    decidedByRole?: string;
    decidedAt: string;
    justification: string;
    legalReference?: string;
  };
  priorityScore?: number;
  priorityReasons?: string[];
  createdAt: string;
}

interface InstrumentBrief {
  _id: string;
  type: string;
  brand: string;
  model: string;
  serialNo: string;
  capacity?: string;
  accuracyClass?: string;
  address?: string;
  installationState: string;
  installationDistrict: string;
  status: string;
}

interface Reading {
  label: string;
  reference: number;
  observed: number;
  unit?: string;
  error?: number;
  errorPercent?: number;
  maxErrorPercent?: number;
  withinTolerance?: boolean;
}

interface InspectionDetail {
  _id: string;
  inspectionNo: string;
  inspectedAt: string;
  result: string;
  version: number;
  isSuperseded?: boolean;
  isSubmitted?: boolean;
  correctionReason?: string;
  readings?: Reading[];
  conformityChecks?: { code: string; label: string; result: string; note?: string }[];
  sealDetails?: { sealNo?: string; stampedAt?: string; stampLocation?: string };
  gpsDriftMetres?: number;
  remarks?: string;
  inspectedByRole?: string;
  /*
   * The photographs the rule required, resolved to links by the route.
   *
   * The rule sets a minimum count and `POST /api/inspections` refuses a submission
   * short of it — and until now the detail route returned only the ObjectIds, so
   * the officer who has to decide the application could see that four photographs
   * existed and open none of them.
   */
  evidence?: EvidenceItem[];
}

interface EvidenceItem {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  documentType?: string;
  sha256?: string;
  capturedAt?: string;
  gps?: { lat?: number; lng?: number };
  href?: string | null;
}

interface DocumentBrief {
  _id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  documentType: string;
  version: number;
  isSuperseded?: boolean;
  sha256?: string;
  createdAt: string;
  href?: string | null;
}

interface ScheduleBrief {
  _id: string;
  scheduledDate: string;
  slotStart?: string;
  slotEnd?: string;
  status: string;
  statusReason?: string;
  assignedTo?: Populated | string;
  assignmentRationale?: string[];
  location?: { address?: string; district?: string; state?: string };
}

interface RiskFlagBrief {
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

interface Payload {
  application: ApplicationDetail;
  instrument: InstrumentBrief | null;
  inspections: InspectionDetail[];
  certificate: { _id: string; certNo: string; issuedDate: string; expiryDate: string; status: string } | null;
  schedule: ScheduleBrief | null;
  documents: DocumentBrief[];
  riskFlags: RiskFlagBrief[];
  appliedRule: {
    name: string;
    matchedScope: string;
    validityMonths: number;
    requiredDocuments: string[];
    sla?: { reviewDays?: number; inspectionDays?: number; certificateDays?: number };
    legalReference?: string;
  } | null;
  availableTransitions: ApplicationStatus[];
}

/** The happy path, for the progress rail. Branches are shown in the timeline. */
const RAIL: { status: ApplicationStatus; short: string }[] = [
  { status: 'SUBMITTED', short: 'Filed' },
  { status: 'UNDER_REVIEW', short: 'Review' },
  { status: 'APPROVED_FOR_SCHEDULING', short: 'Cleared' },
  { status: 'SCHEDULED', short: 'Scheduled' },
  { status: 'INSPECTION_SUBMITTED', short: 'Inspected' },
  { status: 'APPROVED', short: 'Decided' },
  { status: 'ACTIVE', short: 'Certified' },
];

export default function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session } = useSession();

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/applications/${id}`);
      const body = (await res.json()) as Payload & { success: boolean; error?: string };
      if (!body.success) {
        setError(body.error || 'This application could not be loaded.');
        setData(null);
        return;
      }
      setError(null);
      setData(body);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // The awaited tick defers every setState in `load` past this commit; without
    // it the React compiler lint reads the fetch as a synchronous cascade.
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
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading application…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={styles.errorWrap}>
        <AlertTriangle size={44} />
        <h2>Application unavailable</h2>
        <p>{error ?? 'No such application.'}</p>
        <Link href="/dashboard/applications" className="clay-btn clay-btn-outline">
          <ArrowLeft size={16} />
          Back to applications
        </Link>
      </div>
    );
  }

  const {
    application: app,
    instrument,
    inspections,
    certificate,
    schedule,
    documents,
    riskFlags,
    appliedRule,
    availableTransitions,
  } = data;

  const role = session?.user?.role ?? 'Owner';
  const isOwner = role === 'Owner';
  const owner = asPopulated(app.ownerId);
  const officer = asPopulated(app.assignedTo);
  const stage = describeStage(app);
  const openQuery = [...(app.queries ?? [])].reverse().find((q) => !q.resolvedAt) ?? null;
  const outstanding = Math.max(0, (app.feeAmount ?? 0) - (app.feePaid ?? 0));
  /*
   * The current inspection is the latest *signed* one.
   *
   * This was `find((i) => !i.isSuperseded)`, which for an officer — who is shown
   * drafts, and should be — could select an unsubmitted report. Its `result` is
   * computed from whatever readings have been entered so far, so a half-filled
   * draft can read PASS, and that value is handed straight to `OfficerDecision`
   * below as `hasPassedInspection`. An approval could therefore be taken on
   * readings nobody had signed off. `isSubmitted` defaults to false on the model,
   * so the check is positive rather than `!== false`.
   */
  const currentInspection = inspections.find((i) => !i.isSuperseded && i.isSubmitted === true) ?? null;

  // Missing paperwork is worth naming rather than leaving an officer to
  // cross-check the rule by hand.
  const suppliedTypes = new Set(documents.filter((d) => !d.isSuperseded).map((d) => d.documentType));
  const missingDocs = (appliedRule?.requiredDocuments ?? []).filter((t) => !suppliedTypes.has(t));

  const railIndex = railPosition(app.status);

  return (
    <div className={styles.page}>
      <Link href="/dashboard/applications" className={styles.backLink}>
        <ArrowLeft size={15} />
        All applications
      </Link>

      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <FileText size={26} />
        </div>
        <div className={styles.headerText}>
          <div className={styles.headerTitleRow}>
            <h1>{app.applicationNo}</h1>
            <span className={`clay-badge ${statusBadgeClass(app.status)}`}>
              {applicationStatusLabel(app.status)}
            </span>
          </div>
          <p className={styles.headerMeta}>
            {VERIFICATION_TYPE_LABELS[app.type] ?? app.type}
            {instrument ? (
              <>
                {' · '}
                <Link href={`/dashboard/instruments/${instrument._id}`}>
                  {instrument.type} {instrument.serialNo}
                </Link>
              </>
            ) : null}
            {' · filed '}
            {formatDate(app.submittedDate ?? app.createdAt)}
          </p>
        </div>
      </div>

      <div className={`${styles.stage} ${styles[stage.tone]}`}>
        <span className={styles.stageIcon}>{stage.icon}</span>
        <span className={styles.stageText}>
          <strong>{stage.headline}</strong>
          <span>{stage.detail}</span>
        </span>
      </div>

      {railIndex >= 0 && (
        <ol className={styles.rail}>
          {RAIL.map((step, i) => {
            const state = i < railIndex ? styles.railDone : i === railIndex ? styles.railNow : '';
            return (
              <li key={step.status} className={`${styles.railStep} ${state}`}>
                <span className={styles.railDot}>
                  {i < railIndex ? <CheckCircle2 size={13} /> : null}
                </span>
                <span>{step.short}</span>
              </li>
            );
          })}
        </ol>
      )}

      {openQuery && (
        <div className={styles.noticeWarn}>
          <MessageSquareWarning size={18} />
          <span>
            <strong>The reviewing officer needs something from the applicant.</strong>
            {openQuery.message}
            {openQuery.dueBy ? ` Response requested by ${formatDate(openQuery.dueBy)}.` : ''}
          </span>
        </div>
      )}

      {app.decision?.outcome === 'REJECTED' && (
        <div className={styles.noticeBad}>
          <XCircle size={18} />
          <span>
            <strong>Rejected on {formatDate(app.decision.decidedAt)}.</strong>
            {app.decision.justification}
            {app.decision.legalReference ? ` (${app.decision.legalReference})` : ''}
          </span>
        </div>
      )}

      <div className={styles.columns}>
        <div className={styles.colMain}>
          {/* ── The instrument ── */}
          <section className={styles.card}>
            <h2>
              <Scale size={15} />
              Instrument
            </h2>
            {instrument ? (
              <>
                <dl className={styles.detailList}>
                  <Row label="Category" value={instrument.type} />
                  <Row
                    label="Make and model"
                    value={[instrument.brand, instrument.model].filter(Boolean).join(' ') || '—'}
                  />
                  <Row label="Serial number" value={<code>{instrument.serialNo}</code>} />
                  {instrument.capacity && <Row label="Capacity" value={instrument.capacity} />}
                  {instrument.accuracyClass && (
                    <Row label="Accuracy class" value={instrument.accuracyClass} />
                  )}
                  <Row
                    label="Instrument standing"
                    value={
                      <Link href={`/dashboard/instruments/${instrument._id}`}>
                        Open the full record
                      </Link>
                    }
                  />
                </dl>
                <h3 className={styles.subHead}>
                  <MapPin size={13} />
                  Where the inspection happens
                </h3>
                <dl className={styles.detailList}>
                  <Row label="Location" value={app.inspectionLocation} />
                  <Row
                    label="Jurisdiction"
                    value={
                      [app.jurisdiction?.district, app.jurisdiction?.state]
                        .filter(Boolean)
                        .join(', ') || '—'
                    }
                  />
                  {app.preferredDate && (
                    <Row label="Owner asked for" value={formatDate(app.preferredDate)} />
                  )}
                </dl>
              </>
            ) : (
              <p className={styles.empty}>
                The instrument this application was filed against is no longer readable.
              </p>
            )}
          </section>

          {/* ── Queries ── */}
          {(app.queries ?? []).length > 0 && (
            <section className={styles.card}>
              <h2>
                <MessageSquareWarning size={15} />
                Queries
                <span className={styles.countPill}>{app.queries.length}</span>
              </h2>
              <ul className={styles.queryList}>
                {[...app.queries].reverse().map((q, i) => {
                  const raiser = asPopulated(q.raisedBy);
                  return (
                    <li
                      key={`${q.raisedAt}-${i}`}
                      className={`${styles.query} ${q.resolvedAt ? '' : styles.queryOpen}`}
                    >
                      <div className={styles.queryHead}>
                        <strong>{raiser?.name ?? 'Reviewing officer'}</strong>
                        {raiser?.designation ? <span>{raiser.designation}</span> : null}
                        <span>· {formatDateTime(q.raisedAt)}</span>
                        <span
                          className={`clay-badge ${
                            q.resolvedAt ? 'clay-badge-success' : 'clay-badge-warning'
                          }`}
                        >
                          {q.resolvedAt ? 'Answered' : 'Awaiting response'}
                        </span>
                      </div>
                      <p className={styles.queryBody}>{q.message}</p>
                      {(q.requestedDocuments ?? []).length > 0 && (
                        <div className={styles.queryDocs}>
                          {q.requestedDocuments.map((t) => (
                            <span key={t} className={styles.docChip}>
                              {DOCUMENT_TYPE_LABELS[t as DocumentType] ?? t}
                            </span>
                          ))}
                        </div>
                      )}
                      {q.response && (
                        <div className={styles.queryResponse}>
                          <strong>
                            Applicant&apos;s response
                            {q.resolvedAt ? ` · ${formatDateTime(q.resolvedAt)}` : ''}
                          </strong>
                          <p>{q.response}</p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* ── Documents ── */}
          <section className={styles.card}>
            <h2>
              <ScrollText size={15} />
              Documents
              <span className={styles.countPill}>{documents.length}</span>
            </h2>
            {documents.length === 0 ? (
              <p className={styles.empty}>No documents are attached to this application.</p>
            ) : (
              <ul className={styles.docList}>
                {documents.map((doc) => (
                  <li
                    key={doc._id}
                    className={doc.isSuperseded ? styles.docSuperseded : undefined}
                  >
                    <span className={styles.docIcon}>
                      <FileText size={17} />
                    </span>
                    <span className={styles.docMain}>
                      <strong>{doc.fileName}</strong>
                      <span className={styles.docSub}>
                        {DOCUMENT_TYPE_LABELS[doc.documentType as DocumentType] ??
                          doc.documentType}
                        {' · '}
                        {formatBytes(doc.sizeBytes)}
                        {doc.version > 1 ? ` · v${doc.version}` : ''}
                        {doc.isSuperseded ? ' · replaced' : ''}
                        {doc.sha256 ? ` · sha256 ${doc.sha256.slice(0, 10)}…` : ''}
                      </span>
                    </span>
                    {doc.href && (
                      <a
                        href={doc.href}
                        target="_blank"
                        rel="noreferrer"
                        className={styles.rowLink}
                        aria-label={`Open ${doc.fileName}`}
                      >
                        <ExternalLink size={15} />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {missingDocs.length > 0 && (
              <div className={styles.missingDocs}>
                <strong>
                  Still required under {appliedRule?.name ?? 'the applicable rule'}:
                </strong>
                <ul>
                  {missingDocs.map((t) => (
                    <li key={t}>{DOCUMENT_TYPE_LABELS[t as DocumentType] ?? t}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* ── Inspection ── */}
          {inspections.length > 0 && (
            <section className={styles.card}>
              <h2>
                <Gauge size={15} />
                Inspection
                {inspections.length > 1 && (
                  <span className={styles.countPill}>{inspections.length} versions</span>
                )}
              </h2>
              {inspections.map((insp) => (
                <div
                  key={insp._id}
                  className={`${styles.inspection} ${insp.isSuperseded ? styles.superseded : ''}`}
                >
                  <div className={styles.inspTop}>
                    <span className={`clay-badge ${resultBadge(insp.result)}`}>{insp.result}</span>
                    <strong>{insp.inspectionNo}</strong>
                    <span className={styles.versionTag}>v{insp.version}</span>
                    {insp.isSuperseded && (
                      <span className={styles.versionTag}>corrected by a later version</span>
                    )}
                    {!insp.isSubmitted && <span className={styles.versionTag}>draft</span>}
                  </div>

                  <p className={styles.inspMeta}>
                    Inspected {formatDateTime(insp.inspectedAt)}
                    {insp.inspectedByRole ? ` by a ${insp.inspectedByRole}` : ''}
                    {typeof insp.gpsDriftMetres === 'number'
                      ? ` · ${Math.round(insp.gpsDriftMetres)} m from the registered location`
                      : ''}
                  </p>

                  {insp.correctionReason && (
                    <p className={styles.inspMeta}>
                      <em>Correction: {insp.correctionReason}</em>
                    </p>
                  )}

                  {(insp.readings ?? []).length > 0 && (
                    <table className={styles.readings}>
                      <thead>
                        <tr>
                          <th>Test point</th>
                          <th>Reference</th>
                          <th>Observed</th>
                          <th>Error</th>
                          <th>Permitted</th>
                          <th>Verdict</th>
                        </tr>
                      </thead>
                      <tbody>
                        {insp.readings!.map((r, i) => (
                          <tr key={`${r.label}-${i}`}>
                            <td>{r.label}</td>
                            <td>
                              {r.reference}
                              {r.unit ? ` ${r.unit}` : ''}
                            </td>
                            <td>
                              {r.observed}
                              {r.unit ? ` ${r.unit}` : ''}
                            </td>
                            <td>
                              {typeof r.errorPercent === 'number'
                                ? `${r.errorPercent.toFixed(3)}%`
                                : '—'}
                            </td>
                            <td>
                              {typeof r.maxErrorPercent === 'number'
                                ? `±${r.maxErrorPercent}%`
                                : '—'}
                            </td>
                            <td className={r.withinTolerance ? styles.pass : styles.fail}>
                              {r.withinTolerance ? 'Within' : 'Outside'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {(insp.conformityChecks ?? []).length > 0 && (
                    <ul className={styles.checkList}>
                      {insp.conformityChecks!.map((c) => (
                        <li key={c.code}>
                          {c.result === 'PASS' ? (
                            <CheckCircle2 size={14} className={styles.pass} />
                          ) : c.result === 'FAIL' ? (
                            <XCircle size={14} className={styles.fail} />
                          ) : (
                            <Circle size={14} />
                          )}
                          <span>
                            {c.label}
                            {c.note ? <span className={styles.checkNote}> — {c.note}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/*
                    The photographs the rule required.
                    A minimum count is enforced when the inspection is submitted, so
                    for a submitted report these are guaranteed present — and until
                    the detail route resolved the ids to links, they were also
                    guaranteed unreachable by the officer who has to weigh them.
                  */}
                  {(insp.evidence ?? []).length > 0 && (
                    <div className={styles.evidenceBlock}>
                      <h3 className={styles.evidenceHead}>
                        <Camera size={14} />
                        Site evidence
                        <span className={styles.countPill}>
                          {insp.evidence!.length}{' '}
                          {insp.evidence!.length === 1 ? 'file' : 'files'}
                        </span>
                      </h3>
                      <div className={styles.evidenceGrid}>
                        {insp.evidence!.map((ev) => {
                          const isImage = ev.mimeType?.startsWith('image/');
                          return (
                            <figure key={ev.id} className={styles.evidenceItem}>
                              <a
                                href={ev.href ?? '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={styles.evidenceThumb}
                              >
                                {isImage && ev.href ? (
                                  /* eslint-disable-next-line @next/next/no-img-element -- served by our own /api/documents route or Cloudinary, not an optimisable static asset */
                                  <img src={ev.href} alt={ev.fileName || 'Inspection evidence'} />
                                ) : (
                                  <span className={styles.evidenceFile}>
                                    <FileText size={20} />
                                    {ev.mimeType?.split('/')[1]?.toUpperCase() ?? 'FILE'}
                                  </span>
                                )}
                              </a>
                              <figcaption>
                                <span className={styles.evidenceName}>{ev.fileName}</span>
                                {/*
                                  Capture time and place are shown, not hidden behind
                                  the file: a photograph taken a day after the visit,
                                  or a kilometre from the registered site, is the kind
                                  of thing a decision should turn on.
                                */}
                                {ev.capturedAt && (
                                  <span className={styles.evidenceMeta}>
                                    <Clock size={11} />
                                    {formatDateTime(ev.capturedAt)}
                                  </span>
                                )}
                                {typeof ev.gps?.lat === 'number' && typeof ev.gps?.lng === 'number' && (
                                  <a
                                    className={styles.evidenceMeta}
                                    href={`https://www.google.com/maps/search/?api=1&query=${ev.gps.lat},${ev.gps.lng}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    <MapPin size={11} />
                                    {ev.gps.lat.toFixed(5)}, {ev.gps.lng.toFixed(5)}
                                  </a>
                                )}
                              </figcaption>
                            </figure>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {insp.sealDetails?.sealNo && (
                    <p className={styles.sealLine}>
                      <Stamp size={14} />
                      Seal <code>{insp.sealDetails.sealNo}</code>
                      {insp.sealDetails.stampLocation
                        ? ` applied at ${insp.sealDetails.stampLocation}`
                        : ''}
                      {insp.sealDetails.stampedAt
                        ? ` on ${formatDate(insp.sealDetails.stampedAt)}`
                        : ''}
                    </p>
                  )}

                  {insp.remarks && <p className={styles.inspMeta}>{insp.remarks}</p>}
                </div>
              ))}
            </section>
          )}

          {/* ── Risk flags: officials only ── */}
          {riskFlags.length > 0 && (
            <section className={`${styles.card} ${styles.riskCard}`}>
              <h2>
                <ShieldAlert size={15} />
                Risk flags
                <span className={styles.countPill}>{riskFlags.length}</span>
              </h2>
              <ul className={styles.riskList}>
                {riskFlags.map((flag) => (
                  <li key={flag._id}>
                    <AlertTriangle size={17} style={{ color: 'var(--status-warning)' }} />
                    <div>
                      <strong>{flag.title}</strong>
                      <span className={`clay-badge ${riskBadge(flag.level)}`}>{flag.level}</span>
                      {(flag.reasons ?? []).length > 0 && (
                        <ul className={styles.reasonList}>
                          {flag.reasons!.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      )}
                      {flag.recommendedAction && (
                        <p className={styles.recommended}>
                          Recommended: {flag.recommendedAction}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className={styles.note}>
                Flags are advisory. They raise where an officer looks first; they never decide an
                application.
              </p>
            </section>
          )}

          {/* ── History ── */}
          <section className={styles.card}>
            <h2>
              <ClipboardList size={15} />
              History
              <span className={styles.countPill}>{(app.statusHistory ?? []).length}</span>
            </h2>
            {(app.statusHistory ?? []).length === 0 ? (
              <p className={styles.empty}>Nothing has happened to this application yet.</p>
            ) : (
              <ol className={styles.timeline}>
                {[...app.statusHistory].reverse().map((entry, i) => {
                  const actor = asPopulated(entry.actorId);
                  return (
                    <li key={`${entry.at}-${i}`}>
                      <span className={`${styles.timelineDot} ${dotClass(entry.to)}`} />
                      <div className={styles.timelineBody}>
                        <strong>
                          {applicationStatusLabel(entry.to)}
                          {entry.isSystem && <span className={styles.systemTag}>automatic</span>}
                        </strong>
                        {entry.reason && <p>{entry.reason}</p>}
                        <time>
                          {formatDateTime(entry.at)}
                          {actor?.name
                            ? ` · ${actor.name}${
                                entry.actorRole ? ` (${entry.actorRole})` : ''
                              }`
                            : entry.actorRole
                              ? ` · ${entry.actorRole}`
                              : ''}
                          {entry.from ? ` · from ${applicationStatusLabel(entry.from)}` : ''}
                        </time>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>

        <div className={styles.colSide}>
          {/* ── What this account can do next ── */}
          {isOwner ? (
            <OwnerActions
              application={app}
              outstanding={outstanding}
              openQuery={
                openQuery
                  ? {
                      message: openQuery.message,
                      requestedDocuments: openQuery.requestedDocuments ?? [],
                      dueBy: openQuery.dueBy,
                    }
                  : null
              }
              availableTransitions={availableTransitions}
              owner={owner}
              onChanged={load}
            />
          ) : (
            <OfficerDecision
              application={app}
              availableTransitions={availableTransitions}
              hasPassedInspection={currentInspection?.result === 'PASS'}
              currentInspectionResult={currentInspection?.result ?? null}
              missingDocuments={missingDocs}
              onChanged={load}
            />
          )}

          {/* ── Fee ── */}
          <section className={styles.card}>
            <h2>
              <IndianRupee size={15} />
              Fee
            </h2>
            <div className={styles.feeAmount}>
              <IndianRupee size={20} />
              {app.feeAmount?.toLocaleString('en-IN') ?? 0}
            </div>
            <p className={styles.feeLine}>
              <span className={`clay-badge ${statusBadgeClass(app.feeStatus)}`}>
                {app.feeStatus}
              </span>
              {outstanding > 0 ? (
                <> · ₹{outstanding.toLocaleString('en-IN')} outstanding</>
              ) : app.feeStatus === 'Waived' ? (
                <> · no fee is payable under the applicable rule</>
              ) : (
                <> · paid in full</>
              )}
            </p>
            <dl className={styles.detailList}>
              <Row label="Paid so far" value={`₹${(app.feePaid ?? 0).toLocaleString('en-IN')}`} />
              {app.paymentVerifiedAt && (
                <Row label="Confirmed" value={formatDateTime(app.paymentVerifiedAt)} />
              )}
              {app.paymentId && <Row label="Payment id" value={<code>{app.paymentId}</code>} />}
            </dl>
          </section>

          {/* ── Assignment and schedule ── */}
          <section className={styles.card}>
            <h2>
              <CalendarClock size={15} />
              Assignment
            </h2>
            <dl className={styles.detailList}>
              <Row
                label="Officer"
                value={
                  officer?.name
                    ? `${officer.name}${officer.designation ? ` — ${officer.designation}` : ''}`
                    : 'Not yet assigned'
                }
              />
              {app.assignedType && <Row label="Assigned as" value={app.assignedType} />}
              {schedule ? (
                <>
                  <Row
                    label="Visit"
                    value={
                      <>
                        {formatDate(schedule.scheduledDate)}
                        {schedule.slotStart
                          ? `, ${schedule.slotStart}${schedule.slotEnd ? `–${schedule.slotEnd}` : ''}`
                          : ''}
                      </>
                    }
                  />
                  <Row
                    label="Visit status"
                    value={
                      <span className={`clay-badge ${statusBadgeClass(schedule.status)}`}>
                        {schedule.status}
                      </span>
                    }
                  />
                  {schedule.statusReason && <Row label="Note" value={schedule.statusReason} />}
                </>
              ) : (
                <Row label="Visit" value="Not scheduled yet" />
              )}
              {app.dueDate && (
                <Row
                  label="Department target"
                  value={
                    <span className={isOverdue(app) ? styles.overdue : undefined}>
                      {formatDate(app.dueDate)}
                      {isOverdue(app) ? ' — overdue' : ''}
                    </span>
                  }
                />
              )}
            </dl>
            {!isOwner && (schedule?.assignmentRationale ?? []).length > 0 && (
              <>
                <h3 className={styles.subHead}>
                  <UserCheck size={13} />
                  Why this officer
                </h3>
                <ul className={styles.priorityList}>
                  {schedule!.assignmentRationale!.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {/* ── Certificate ── */}
          {certificate && (
            <section className={styles.card}>
              <h2>
                <ShieldCheck size={15} />
                Certificate
              </h2>
              <dl className={styles.detailList}>
                <Row label="Number" value={<code>{certificate.certNo}</code>} />
                <Row label="Issued" value={formatDate(certificate.issuedDate)} />
                <Row label="Valid until" value={formatDate(certificate.expiryDate)} />
                <Row
                  label="Status"
                  value={
                    <span className={`clay-badge ${statusBadgeClass(certificate.status)}`}>
                      {certificate.status}
                    </span>
                  }
                />
                <Row
                  label="Public check"
                  value={<Link href={`/verify/${certificate.certNo}`}>Open the public page</Link>}
                />
              </dl>
            </section>
          )}

          {/* ── Decision ── */}
          {app.decision && (
            <section className={styles.card}>
              <h2>
                {app.decision.outcome === 'APPROVED' ? (
                  <CheckCircle2 size={15} />
                ) : (
                  <XCircle size={15} />
                )}
                Decision
              </h2>
              <dl className={styles.detailList}>
                <Row
                  label="Outcome"
                  value={
                    <span className={`clay-badge ${statusBadgeClass(app.decision.outcome)}`}>
                      {APPLICATION_STATUS_LABELS[app.decision.outcome]}
                    </span>
                  }
                />
                <Row label="Decided" value={formatDateTime(app.decision.decidedAt)} />
                <Row
                  label="By"
                  value={
                    asPopulated(app.decision.decidedBy)?.name ??
                    app.decision.decidedByRole ??
                    'Legal Metrology Officer'
                  }
                />
                {app.decision.legalReference && (
                  <Row label="Under" value={app.decision.legalReference} />
                )}
              </dl>
              <p className={styles.note}>{app.decision.justification}</p>
            </section>
          )}

          {/* ── The rule ── */}
          {appliedRule && (
            <section className={styles.card}>
              <h2>
                <ScrollText size={15} />
                Applicable rule
              </h2>
              <dl className={styles.detailList}>
                <Row label="Rule" value={appliedRule.name} />
                <Row label="Matched on" value={appliedRule.matchedScope} />
                <Row label="Certificate validity" value={`${appliedRule.validityMonths} months`} />
                {appliedRule.sla?.reviewDays !== undefined && (
                  <Row label="Review target" value={`${appliedRule.sla.reviewDays} days`} />
                )}
                {appliedRule.sla?.inspectionDays !== undefined && (
                  <Row label="Inspection target" value={`${appliedRule.sla.inspectionDays} days`} />
                )}
                {appliedRule.legalReference && (
                  <Row label="Legal reference" value={appliedRule.legalReference} />
                )}
              </dl>
            </section>
          )}

          {/* ── Applicant, for officers ── */}
          {!isOwner && owner && (
            <section className={styles.card}>
              <h2>
                <Building2 size={15} />
                Applicant
              </h2>
              <dl className={styles.detailList}>
                <Row label="Name" value={owner.name ?? '—'} />
                {owner.organizationName && (
                  <Row label="Business" value={owner.organizationName} />
                )}
                {owner.phone && (
                  <Row label="Phone" value={<a href={`tel:${owner.phone}`}>{owner.phone}</a>} />
                )}
                {owner.email && (
                  <Row label="Email" value={<a href={`mailto:${owner.email}`}>{owner.email}</a>} />
                )}
              </dl>
            </section>
          )}

          {/* ── Priority, for officers ── */}
          {!isOwner && (app.priorityReasons ?? []).length > 0 && (
            <section className={styles.card}>
              <h2>
                <Clock size={15} />
                Queue priority
                <span className={styles.countPill}>{app.priorityScore ?? 0}</span>
              </h2>
              <ul className={styles.priorityList}>
                {app.priorityReasons!.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              <p className={styles.note}>
                Priority orders the queue only. It carries no weight in the decision.
              </p>
            </section>
          )}

          {app.remarks && (
            <section className={styles.card}>
              <h2>
                <FileText size={15} />
                Applicant&apos;s remarks
              </h2>
              <p className={styles.note} style={{ margin: 0 }}>
                {app.remarks}
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Mongoose hands back either an id string or a populated document. */
function asPopulated(value: Populated | string | undefined): Populated | null {
  return value && typeof value === 'object' ? value : null;
}

/**
 * The one-line answer to "what is happening to my application".
 *
 * Written per status rather than derived from a date, so it cannot disagree with
 * the badge next to it.
 */
function describeStage(app: ApplicationDetail): {
  tone: 'toneOk' | 'toneWarn' | 'toneBad' | 'toneNeutral';
  icon: React.ReactNode;
  headline: string;
  detail: string;
} {
  const overdue = isOverdue(app);
  const lateNote = overdue && app.dueDate ? ` The department target of ${formatDate(app.dueDate)} has passed.` : '';

  switch (app.status) {
    case 'DRAFT':
      return {
        tone: 'toneNeutral',
        icon: <FileText size={26} />,
        headline: 'Not submitted yet',
        detail:
          'This is a draft. Nobody at the department can see it until it is submitted, and no officer is working on it.',
      };
    case 'SUBMITTED':
      return {
        tone: 'toneWarn',
        icon: <Clock size={26} />,
        headline: 'Waiting to be picked up',
        detail: `Filed and in the queue for the ${app.jurisdiction?.district ?? 'local'} office.${lateNote}`,
      };
    case 'UNDER_REVIEW':
    case 'RESUBMITTED':
      return {
        tone: 'toneWarn',
        icon: <ClipboardList size={26} />,
        headline: 'Being reviewed',
        detail: `An officer is checking the paperwork before an inspection is scheduled.${lateNote}`,
      };
    case 'QUERY_RAISED':
      return {
        tone: 'toneWarn',
        icon: <MessageSquareWarning size={26} />,
        headline: 'Waiting on the applicant',
        detail:
          'The officer has asked for something. Nothing moves until it is answered — see the query below.',
      };
    case 'APPROVED_FOR_SCHEDULING':
      return {
        tone: 'toneOk',
        icon: <CheckCircle2 size={26} />,
        headline: 'Paperwork cleared',
        detail: `The documents are in order. An inspection slot is being arranged.${lateNote}`,
      };
    case 'SCHEDULED':
      return {
        tone: 'toneOk',
        icon: <CalendarClock size={26} />,
        headline: 'Inspection scheduled',
        detail: 'An officer will attend the premises. Keep the instrument accessible on the day.',
      };
    case 'INSPECTION_IN_PROGRESS':
      return {
        tone: 'toneWarn',
        icon: <Gauge size={26} />,
        headline: 'Inspection under way',
        detail: 'Readings are being taken at the premises.',
      };
    case 'INSPECTION_SUBMITTED':
    case 'UNDER_DECISION':
      return {
        tone: 'toneWarn',
        icon: <Gauge size={26} />,
        headline: 'Inspection done, decision pending',
        detail: `The readings are in and an officer is deciding on them.${lateNote}`,
      };
    case 'APPROVED':
      return {
        tone: 'toneOk',
        icon: <CheckCircle2 size={26} />,
        headline: 'Approved',
        detail: 'The certificate is being generated. Nothing further is needed from the applicant.',
      };
    case 'CERTIFICATE_GENERATED':
    case 'ACTIVE':
      return {
        tone: 'toneOk',
        icon: <ShieldCheck size={26} />,
        headline: 'Certified',
        detail:
          'The certificate has been issued and the instrument is legal to use for trade until it expires.',
      };
    case 'REJECTED':
      return {
        tone: 'toneBad',
        icon: <XCircle size={26} />,
        headline: 'Rejected',
        detail:
          app.decision?.justification ??
          'The application was refused. The reason is recorded in the history below.',
      };
    case 'CANCELLED':
      return {
        tone: 'toneNeutral',
        icon: <XCircle size={26} />,
        headline: 'Cancelled',
        detail: 'This application was withdrawn and is closed. File a new one if it is still needed.',
      };
    case 'EXPIRED':
      return {
        tone: 'toneBad',
        icon: <Clock size={26} />,
        headline: 'Expired',
        detail: 'The certificate issued on this application has run out. A re-verification is due.',
      };
    case 'SUSPENDED':
      return {
        tone: 'toneBad',
        icon: <ShieldAlert size={26} />,
        headline: 'Suspended',
        detail:
          'The certificate is suspended. The instrument may not be used for trade until it is restored.',
      };
    case 'REVOKED':
      return {
        tone: 'toneBad',
        icon: <ShieldAlert size={26} />,
        headline: 'Revoked',
        detail: 'The certificate has been withdrawn. The instrument may not be used for trade.',
      };
    default:
      return {
        tone: 'toneNeutral',
        icon: <FileText size={26} />,
        headline: applicationStatusLabel(app.status),
        detail: 'See the history below for what has happened so far.',
      };
  }
}

/** How far along the happy path this status sits; -1 if it is off the path. */
function railPosition(status: ApplicationStatus): number {
  const direct = RAIL.findIndex((s) => s.status === status);
  if (direct >= 0) return direct;

  // Statuses that belong to a rail step without being it.
  const alias: Partial<Record<ApplicationStatus, ApplicationStatus>> = {
    RESUBMITTED: 'UNDER_REVIEW',
    QUERY_RAISED: 'UNDER_REVIEW',
    INSPECTION_IN_PROGRESS: 'SCHEDULED',
    UNDER_DECISION: 'INSPECTION_SUBMITTED',
    CERTIFICATE_GENERATED: 'ACTIVE',
    EXPIRED: 'ACTIVE',
    SUSPENDED: 'ACTIVE',
    REVOKED: 'ACTIVE',
  };
  const mapped = alias[status];
  if (mapped) return RAIL.findIndex((s) => s.status === mapped);

  // DRAFT, REJECTED and CANCELLED are not points on the path — a rail showing
  // partial progress towards a certificate that will never be issued would be a
  // lie, so it is not drawn at all.
  return -1;
}

function isOverdue(app: ApplicationDetail): boolean {
  if (!app.dueDate) return false;
  const closed = ['APPROVED', 'REJECTED', 'CERTIFICATE_GENERATED', 'ACTIVE', 'CANCELLED', 'EXPIRED', 'SUSPENDED', 'REVOKED'];
  if (closed.includes(app.status)) return false;
  return new Date(app.dueDate).getTime() < Date.now();
}

function dotClass(status: string): string {
  switch (status) {
    case 'APPROVED':
    case 'ACTIVE':
    case 'CERTIFICATE_GENERATED':
    case 'APPROVED_FOR_SCHEDULING':
      return styles.dotOk;
    case 'REJECTED':
    case 'REVOKED':
    case 'EXPIRED':
      return styles.dotBad;
    case 'QUERY_RAISED':
    case 'SUSPENDED':
      return styles.dotWarn;
    case 'SUBMITTED':
    case 'RESUBMITTED':
    case 'SCHEDULED':
      return styles.dotInfo;
    default:
      return '';
  }
}

function resultBadge(result: string): string {
  if (result === 'PASS') return 'clay-badge-success';
  if (result === 'FAIL') return 'clay-badge-error';
  return 'clay-badge-warning';
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

function formatBytes(bytes: number): string {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
