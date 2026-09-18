'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  X,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Download,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  History,
  Ban,
  PauseCircle,
  PlayCircle,
  FileText,
} from 'lucide-react';
import {
  DECISION_ROLES,
  certificateStatusLabel,
  statusBadgeClass,
  formatDate,
  formatDateTime,
  type Role,
} from '@/lib/constants';
import styles from './certificates.module.css';

/**
 * One certificate, in full.
 *
 * Everything here comes from `GET /api/certificates/[id]`, which is the only
 * place the issuer identity, the seal number, the signature and the event history
 * exist. The list endpoint deliberately strips `dataHash` and `digitalSignature`,
 * which is why the old page's signature line rendered as
 * `HMAC-SHA256: undefined...` — it was reading a field that was never sent.
 *
 * The QR is the server's, rendered locally by the `qrcode` package. The previous
 * version built an `<img>` against `api.qrserver.com`, which sent every
 * certificate number of every business in the district to a third-party image
 * host on page load, and left the certificate blank without internet access.
 */

interface Snapshot {
  type?: string;
  brand?: string;
  model?: string;
  serialNo?: string;
  capacity?: string;
  accuracyClass?: string;
  address?: string;
  installationDistrict?: string;
  installationState?: string;
}

interface Detail {
  _id: string;
  certNo: string;
  status: string;
  effectiveStatus: string;
  daysToExpiry: number;
  issuedDate: string;
  expiryDate: string;
  version: number;
  supersedesId?: string;
  supersededById?: string;
  verifyUrl: string;
  issuedByRole?: string;
  signatureKeyId?: string;
  digitalSignature?: string;
  dataHash?: string;
  downloadCount?: number;
  verificationCount?: number;
  lastVerifiedAt?: string;
  instrumentSnapshot: Snapshot;
  ownerSnapshot: { name?: string; email?: string; phone?: string; organizationName?: string };
  issuerSnapshot?: {
    name?: string;
    designation?: string;
    officerCode?: string;
    state?: string;
    district?: string;
  };
  inspectionSummary?: {
    inspectedAt?: string;
    result?: string;
    readingCount?: number;
    maxErrorPercent?: number;
    sealNo?: string;
  };
  appliedRuleSnapshot?: { validityMonths?: number; legalReference?: string };
  suspension?: { reason: string; at: string; until?: string };
  revocation?: { reason: string; at: string; legalReference?: string };
}

interface EventRow {
  _id: string;
  eventType: string;
  summary: string;
  internalNote?: string;
  fromStatus?: string;
  toStatus?: string;
  actorId?: { name?: string; role?: string; designation?: string } | null;
  actorRole?: string;
  isSystem: boolean;
  occurredAt: string;
}

interface Payload {
  success: boolean;
  error?: string;
  code?: string;
  certificate?: Detail;
  integrity?: { signatureValid: boolean; hashValid: boolean; detail: string };
  qrDataUrl?: string;
  events?: EventRow[];
  application?: { applicationNo?: string; type?: string; _id?: string } | null;
  inspection?: {
    inspectionNo?: string;
    inspectedAt?: string;
    result?: string;
    readings?: unknown[];
    sealDetails?: { sealNo?: string };
    inspectedBy?: { name?: string; designation?: string; officerCode?: string } | null;
  } | null;
  isCurrentForInstrument?: boolean;
}

type Action = 'suspend' | 'reinstate' | 'revoke';

export default function CertificateDrawer({
  certificateId,
  role,
  onClose,
  onChanged,
}: {
  certificateId: string;
  role: Role;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [action, setAction] = useState<Action | null>(null);

  const canDecide = (DECISION_ROLES as readonly string[]).includes(role);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/certificates/${certificateId}`);
      const data = (await res.json()) as Payload;
      if (!data.success || !data.certificate) {
        setError(data.error ?? 'This certificate could not be loaded.');
        return;
      }
      setError(null);
      setPayload(data);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [certificateId]);

  useEffect(() => {
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

  /*
   * Re-reads the record with `download=true` before rendering. That parameter is
   * what increments the download counter and writes the audit entry, and reading
   * again means a certificate suspended two minutes ago cannot be saved as a
   * clean PDF from a stale drawer.
   */
  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/certificates/${certificateId}?download=true`);
      const fresh = (await res.json()) as Payload;
      if (!fresh.success || !fresh.certificate || !fresh.qrDataUrl) {
        setError(fresh.error ?? 'The certificate could not be prepared for download.');
        return;
      }
      setPayload(fresh);

      const c = fresh.certificate;
      const { certificatePdfBlob } = await import('./CertificatePdf');
      const blob = await certificatePdfBlob({
        certNo: c.certNo,
        status: c.status,
        effectiveStatus: certificateStatusLabel(c.effectiveStatus),
        issuedDate: c.issuedDate,
        expiryDate: c.expiryDate,
        version: c.version ?? 1,
        supersedes: Boolean(c.supersedesId),
        verifyUrl: c.verifyUrl,
        qrDataUrl: fresh.qrDataUrl,
        signatureKeyId: c.signatureKeyId,
        digitalSignature: c.digitalSignature,
        dataHash: c.dataHash,
        integrity: fresh.integrity,
        instrument: c.instrumentSnapshot ?? {},
        owner: c.ownerSnapshot ?? {},
        issuer: { ...(c.issuerSnapshot ?? {}), role: c.issuedByRole },
        inspection: {
          inspectionNo: fresh.inspection?.inspectionNo,
          inspectedAt: fresh.inspection?.inspectedAt ?? c.inspectionSummary?.inspectedAt,
          result: fresh.inspection?.result ?? c.inspectionSummary?.result,
          readingCount: fresh.inspection?.readings?.length ?? c.inspectionSummary?.readingCount,
          maxErrorPercent: c.inspectionSummary?.maxErrorPercent,
          sealNo: fresh.inspection?.sealDetails?.sealNo ?? c.inspectionSummary?.sealNo,
        },
        rule: c.appliedRuleSnapshot,
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${c.certNo}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('The PDF could not be generated in this browser.');
    } finally {
      setDownloading(false);
    }
  }

  async function submitAction(kind: Action, body: Record<string, unknown>) {
    setError(null);
    const res = await fetch(`/api/certificates/${certificateId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: kind, ...body }),
    });
    const data = (await res.json()) as { success: boolean; error?: string };
    if (!data.success) {
      setError(data.error ?? 'The change could not be recorded.');
      return;
    }
    setAction(null);
    setNotice(
      kind === 'suspend'
        ? 'The certificate is suspended. It now reads as suspended on the public verification page.'
        : kind === 'reinstate'
          ? 'The certificate is reinstated.'
          : 'The certificate is revoked. This cannot be undone.'
    );
    onChanged(
      kind === 'revoke' ? 'Certificate revoked.' : kind === 'suspend' ? 'Certificate suspended.' : 'Certificate reinstated.'
    );
    await load();
  }

  const cert = payload?.certificate;
  const shown = cert?.effectiveStatus ?? cert?.status;

  return (
    <div className={styles.drawerBackdrop} onClick={onClose} role="presentation">
      <aside
        className={styles.drawer}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Certificate"
      >
        <header className={styles.drawerHeader}>
          <div>
            <h2>{cert?.certNo ?? 'Certificate'}</h2>
            {shown && (
              <span className={`clay-badge ${statusBadgeClass(shown)}`}>
                {certificateStatusLabel(shown)}
              </span>
            )}
          </div>
          <button className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className={styles.drawerBody}>
          {loading ? (
            <div className={styles.drawerLoading}>
              <Loader2 size={28} className={styles.spin} />
              <p>Loading the certificate…</p>
            </div>
          ) : !cert ? (
            <div className={styles.errorBox}>
              <AlertTriangle size={17} />
              <span>{error ?? 'This certificate could not be loaded.'}</span>
            </div>
          ) : (
            <>
              {notice && (
                <div className={styles.noticeOk}>
                  <CheckCircle2 size={17} />
                  <span>{notice}</span>
                </div>
              )}
              {error && (
                <div className={styles.errorBox}>
                  <AlertTriangle size={17} />
                  <span>{error}</span>
                </div>
              )}

              {/* Why the certificate is not simply "valid", when it is not. */}
              {cert.revocation && (
                <div className={styles.errorBox}>
                  <Ban size={17} />
                  <span>
                    <strong>Revoked on {formatDate(cert.revocation.at)}.</strong>{' '}
                    {cert.revocation.reason}
                    {cert.revocation.legalReference && ` (${cert.revocation.legalReference})`}
                  </span>
                </div>
              )}
              {cert.suspension && cert.status === 'SUSPENDED' && (
                <div className={styles.warnBox}>
                  <PauseCircle size={17} />
                  <span>
                    <strong>Suspended on {formatDate(cert.suspension.at)}.</strong>{' '}
                    {cert.suspension.reason}
                    {cert.suspension.until && ` Suspension runs until ${formatDate(cert.suspension.until)}.`}
                  </span>
                </div>
              )}
              {cert.supersededById && (
                <div className={styles.infoBox}>
                  <FileText size={17} />
                  <span>
                    A later certificate has replaced this one. This copy remains on record as
                    history.
                  </span>
                </div>
              )}

              <section className={styles.qrSection}>
                {payload?.qrDataUrl && (
                  /* A locally generated data URL: next/image has nothing to
                     optimise and does not document `data:` as a supported
                     `src`, so a plain img is the correct element here. */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={payload.qrDataUrl}
                    alt={`Verification QR code for ${cert.certNo}`}
                    width={148}
                    height={148}
                    className={styles.qrImage}
                  />
                )}
                <div className={styles.qrText}>
                  <strong>Anyone can check this certificate</strong>
                  <p>
                    The code resolves to the department&apos;s record, not to this file — so a
                    printed copy with an altered date is caught by scanning it.
                  </p>
                  <Link
                    href={`/verify/${encodeURIComponent(cert.certNo)}`}
                    target="_blank"
                    className="clay-btn clay-btn-sm clay-btn-outline"
                  >
                    <ExternalLink size={14} />
                    Open the public page
                  </Link>
                  {(cert.verificationCount ?? 0) > 0 && (
                    <span className={styles.hint}>
                      Checked {cert.verificationCount} time
                      {cert.verificationCount === 1 ? '' : 's'}
                      {cert.lastVerifiedAt && `, most recently ${formatDate(cert.lastVerifiedAt)}`}.
                    </span>
                  )}
                </div>
              </section>

              {/* Integrity, stated as the server computed it — not asserted by the UI. */}
              {payload?.integrity && (
                <section
                  className={
                    payload.integrity.hashValid && payload.integrity.signatureValid
                      ? styles.integrityOk
                      : styles.integrityBad
                  }
                >
                  {payload.integrity.hashValid && payload.integrity.signatureValid ? (
                    <ShieldCheck size={18} />
                  ) : (
                    <ShieldAlert size={18} />
                  )}
                  <div>
                    <strong>
                      {payload.integrity.hashValid && payload.integrity.signatureValid
                        ? 'Integrity check passed'
                        : 'Integrity check failed'}
                    </strong>
                    <p>{payload.integrity.detail}</p>
                  </div>
                </section>
              )}

              <section className={styles.drawerSection}>
                <h3>Instrument</h3>
                <div className={styles.factGrid}>
                  <Fact label="Type" value={cert.instrumentSnapshot?.type} />
                  <Fact
                    label="Make and model"
                    value={[cert.instrumentSnapshot?.brand, cert.instrumentSnapshot?.model]
                      .filter(Boolean)
                      .join(' ')}
                  />
                  <Fact label="Serial number" value={cert.instrumentSnapshot?.serialNo} />
                  <Fact label="Capacity" value={cert.instrumentSnapshot?.capacity} />
                  <Fact label="Accuracy class" value={cert.instrumentSnapshot?.accuracyClass} />
                  <Fact
                    label="Place of use"
                    value={
                      cert.instrumentSnapshot?.address ??
                      [
                        cert.instrumentSnapshot?.installationDistrict,
                        cert.instrumentSnapshot?.installationState,
                      ]
                        .filter(Boolean)
                        .join(', ')
                    }
                  />
                </div>
              </section>

              <section className={styles.drawerSection}>
                <h3>Validity</h3>
                <div className={styles.factGrid}>
                  <Fact label="Issued" value={formatDate(cert.issuedDate)} />
                  <Fact label="Valid until" value={formatDate(cert.expiryDate)} />
                  <Fact
                    label="Time remaining"
                    value={
                      cert.daysToExpiry > 0
                        ? `${cert.daysToExpiry} day${cert.daysToExpiry === 1 ? '' : 's'}`
                        : `Lapsed ${Math.abs(cert.daysToExpiry)} day${
                            Math.abs(cert.daysToExpiry) === 1 ? '' : 's'
                          } ago`
                    }
                  />
                  <Fact
                    label="Validity applied"
                    value={
                      cert.appliedRuleSnapshot?.validityMonths
                        ? `${cert.appliedRuleSnapshot.validityMonths} months`
                        : undefined
                    }
                  />
                  <Fact label="Provision applied" value={cert.appliedRuleSnapshot?.legalReference} />
                  <Fact
                    label="Revision"
                    value={cert.version > 1 ? `Revision ${cert.version}` : 'First issue'}
                  />
                </div>
              </section>

              <section className={styles.drawerSection}>
                <h3>Holder</h3>
                <div className={styles.factGrid}>
                  <Fact
                    label="Name"
                    value={cert.ownerSnapshot?.organizationName ?? cert.ownerSnapshot?.name}
                  />
                  <Fact
                    label="Contact person"
                    value={
                      cert.ownerSnapshot?.organizationName ? cert.ownerSnapshot?.name : undefined
                    }
                  />
                  <Fact label="Email" value={cert.ownerSnapshot?.email} />
                  <Fact label="Telephone" value={cert.ownerSnapshot?.phone} />
                </div>
              </section>

              {(payload?.inspection || cert.inspectionSummary) && (
                <section className={styles.drawerSection}>
                  <h3>The inspection it rests on</h3>
                  <div className={styles.factGrid}>
                    <Fact label="Reference" value={payload?.inspection?.inspectionNo} />
                    <Fact
                      label="Inspected"
                      value={formatDate(
                        payload?.inspection?.inspectedAt ?? cert.inspectionSummary?.inspectedAt
                      )}
                    />
                    <Fact
                      label="Result"
                      value={payload?.inspection?.result ?? cert.inspectionSummary?.result}
                    />
                    <Fact
                      label="Test points"
                      value={
                        payload?.inspection?.readings?.length ??
                        cert.inspectionSummary?.readingCount
                      }
                    />
                    <Fact
                      label="Maximum error"
                      value={
                        cert.inspectionSummary?.maxErrorPercent === undefined
                          ? undefined
                          : `${cert.inspectionSummary.maxErrorPercent}%`
                      }
                    />
                    <Fact
                      label="Seal number"
                      value={
                        payload?.inspection?.sealDetails?.sealNo ?? cert.inspectionSummary?.sealNo
                      }
                    />
                    <Fact
                      label="Inspected by"
                      value={payload?.inspection?.inspectedBy?.name}
                    />
                  </div>
                </section>
              )}

              <section className={styles.drawerSection}>
                <h3>Issued by</h3>
                <div className={styles.factGrid}>
                  <Fact label="Officer" value={cert.issuerSnapshot?.name} />
                  <Fact
                    label="Designation"
                    value={cert.issuerSnapshot?.designation ?? cert.issuedByRole}
                  />
                  <Fact label="Officer code" value={cert.issuerSnapshot?.officerCode} />
                  <Fact
                    label="Office"
                    value={[cert.issuerSnapshot?.district, cert.issuerSnapshot?.state]
                      .filter(Boolean)
                      .join(', ')}
                  />
                  <Fact label="Signing key" value={cert.signatureKeyId} />
                  <Fact
                    label="Application"
                    value={payload?.application?.applicationNo}
                  />
                </div>
              </section>

              {payload?.events && payload.events.length > 0 && (
                <section className={styles.drawerSection}>
                  <h3>
                    <History size={15} /> History
                  </h3>
                  <ol className={styles.timeline}>
                    {payload.events.map((e) => (
                      <li key={e._id}>
                        <div className={styles.timelineDot} />
                        <div>
                          <strong>{e.summary}</strong>
                          <span className={styles.timelineMeta}>
                            {formatDateTime(e.occurredAt)}
                            {' · '}
                            {e.isSystem
                              ? 'Recorded automatically'
                              : (e.actorId?.name ?? e.actorRole ?? 'Department')}
                            {e.fromStatus && e.toStatus && (
                              <>
                                {' · '}
                                {certificateStatusLabel(e.fromStatus)} →{' '}
                                {certificateStatusLabel(e.toStatus)}
                              </>
                            )}
                          </span>
                          {e.internalNote && (
                            <span className={styles.timelineNote}>{e.internalNote}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {/*
                * Suspension, reinstatement and revocation. The server restricts
                * these to LMO / StateAdmin / Admin and demands a written reason of
                * at least ten characters, because the reason is shown to the
                * business and on the public page. The form asks for exactly that
                * rather than letting the request bounce.
                */}
              {canDecide && cert.status !== 'REVOKED' && cert.status !== 'SUPERSEDED' && (
                <section className={styles.drawerSection}>
                  <h3>Departmental action</h3>
                  <p className={styles.sectionNote}>
                    Whatever you record here appears on the public verification page for this
                    certificate, with your reason.
                  </p>

                  {action === null ? (
                    <div className={styles.sectionActions}>
                      {cert.status === 'SUSPENDED' ? (
                        <button
                          className="clay-btn clay-btn-sm clay-btn-secondary"
                          onClick={() => setAction('reinstate')}
                        >
                          <PlayCircle size={15} />
                          Reinstate
                        </button>
                      ) : (
                        <button
                          className="clay-btn clay-btn-sm clay-btn-outline"
                          onClick={() => setAction('suspend')}
                        >
                          <PauseCircle size={15} />
                          Suspend
                        </button>
                      )}
                      <button
                        className={`clay-btn clay-btn-sm ${styles.dangerBtn}`}
                        onClick={() => setAction('revoke')}
                      >
                        <Ban size={15} />
                        Revoke
                      </button>
                    </div>
                  ) : (
                    <ActionForm
                      kind={action}
                      onCancel={() => setAction(null)}
                      onSubmit={(body) => submitAction(action, body)}
                    />
                  )}
                </section>
              )}
            </>
          )}
        </div>

        {cert && (
          <footer className={styles.drawerFooter}>
            <Link
              href={`/verify/${encodeURIComponent(cert.certNo)}`}
              target="_blank"
              className="clay-btn clay-btn-ghost"
            >
              <ExternalLink size={16} />
              Verify
            </Link>
            <button className="clay-btn clay-btn-primary" onClick={download} disabled={downloading}>
              {downloading ? <Loader2 size={16} className={styles.spin} /> : <Download size={16} />}
              {downloading ? 'Preparing…' : 'Download PDF'}
            </button>
          </footer>
        )}
      </aside>
    </div>
  );
}

function Fact({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === '' || value === 'N/A') return null;
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** Collects the reason the server requires, before it is asked for. */
function ActionForm({
  kind,
  onCancel,
  onSubmit,
}: {
  kind: Action;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [legalReference, setLegalReference] = useState('');
  const [busy, setBusy] = useState(false);

  const tooShort = reason.trim().length < 10;

  const heading =
    kind === 'suspend'
      ? 'Suspend this certificate'
      : kind === 'reinstate'
        ? 'Reinstate this certificate'
        : 'Revoke this certificate';

  return (
    <form
      className={styles.reasonForm}
      onSubmit={async (e) => {
        e.preventDefault();
        if (tooShort) return;
        setBusy(true);
        try {
          await onSubmit({
            reason: reason.trim(),
            ...(kind === 'suspend' && until ? { until } : {}),
            ...(kind === 'revoke' && legalReference.trim()
              ? { legalReference: legalReference.trim() }
              : {}),
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <strong>{heading}</strong>
      {kind === 'revoke' && (
        <p className={styles.sectionNote}>
          A revocation is permanent. If the instrument may return to service, suspend it instead.
        </p>
      )}

      <label className="clay-label" htmlFor="reason">
        Reason (shown to the business and on the public page)
      </label>
      <textarea
        id="reason"
        className="clay-input"
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. Instrument found operating outside permitted error during a market check on 12 Aug 2026."
        required
      />
      <span className={styles.hint}>
        At least 10 characters. {reason.trim().length}/10.
      </span>

      {kind === 'suspend' && (
        <>
          <label className="clay-label" htmlFor="until">
            Suspension ends (optional)
          </label>
          <input
            id="until"
            type="date"
            className="clay-input"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
          <span className={styles.hint}>
            Leave blank for an open-ended suspension that only you can lift.
          </span>
        </>
      )}

      {kind === 'revoke' && (
        <>
          <label className="clay-label" htmlFor="legalReference">
            Provision relied on (optional)
          </label>
          <input
            id="legalReference"
            className="clay-input"
            value={legalReference}
            onChange={(e) => setLegalReference(e.target.value)}
            placeholder="e.g. Legal Metrology Act 2009, s.24"
          />
        </>
      )}

      <div className={styles.sectionActions}>
        <button
          type="submit"
          className={`clay-btn clay-btn-sm ${kind === 'revoke' ? styles.dangerBtn : 'clay-btn-primary'}`}
          disabled={busy || tooShort}
        >
          {busy && <Loader2 size={15} className={styles.spin} />}
          {kind === 'suspend' ? 'Suspend' : kind === 'reinstate' ? 'Reinstate' : 'Revoke'}
        </button>
        <button type="button" className="clay-btn clay-btn-sm clay-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
