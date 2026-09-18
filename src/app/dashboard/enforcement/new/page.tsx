'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Gavel,
  Loader2,
  Scale,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  ENFORCEMENT_CASE_TYPES,
  ENFORCEMENT_CASE_TYPE_LABELS,
  ENFORCEMENT_SEVERITIES,
  RISK_FLAG_TYPE_LABELS,
  riskLevelBadgeClass,
  formatDate,
  type EnforcementCaseType,
  type EnforcementSeverity,
  type RiskFlagType,
} from '@/lib/constants';
import styles from './newCase.module.css';

/**
 * Opening an enforcement case.
 *
 * Whoever opens a case is assigned it — the API does that, not this form — so this
 * page is deliberately blunt about what pressing the button starts: a record against
 * a named business that only an administrator can later reopen, and a notification
 * to that business the moment it exists. Enforcement without notice is not due
 * process, so the notice is not optional and the form says so before submission
 * rather than after.
 *
 * The `?riskFlagId=` path is the one the risk queue hands off to. It is not a
 * shortcut: the API refuses a flag that is not `CONFIRMED`, because a case resting
 * on a detector's output rather than on an officer's finding is exactly the failure
 * the risk subsystem was built to avoid. The form checks the same thing up front so
 * the officer is sent back to triage instead of into a rejected submission.
 */

interface FlagPayload {
  flag: {
    id: string;
    flagType: string;
    level: string;
    score: number;
    title: string;
    reasons: string[];
    recommendedAction?: string;
    status: string;
    detectedAt: string;
  };
  subject: {
    instrument?: { _id: string; serialNo?: string; type?: string; brand?: string } | null;
    owner?: { name?: string; organizationName?: string } | null;
  };
}

/**
 * A starting point for the case type when one is opened from a risk finding.
 *
 * A suggestion, not a rule — the officer can change it, and several detectors map
 * onto nothing more specific than OTHER. Pre-filling the obvious ones saves a step;
 * pre-filling the ambiguous ones would be guessing on the officer's behalf about
 * what a case is actually about.
 */
const FLAG_TO_CASE_TYPE: Partial<Record<RiskFlagType, EnforcementCaseType>> = {
  DUPLICATE_SERIAL: 'TAMPERED_SEAL',
  CERTIFICATE_CONFLICT: 'FAKE_CERTIFICATE',
  OVERDUE_VERIFICATION: 'UNVERIFIED_INSTRUMENT',
  REPEATED_FAILURE: 'REPEAT_OFFENDER',
  HIGH_FOOTFALL_UNVERIFIED: 'UNVERIFIED_INSTRUMENT',
};

/** Risk level and case severity are the same scale with four grades against three. */
function severityFromLevel(level: string): EnforcementSeverity {
  if (level === 'CRITICAL' || level === 'HIGH') return 'HIGH';
  if (level === 'LOW') return 'LOW';
  return 'MEDIUM';
}

const TITLE_MIN = 5;
const DESCRIPTION_MIN = 20;

type SubjectMode = 'serialNo' | 'certNo';

function NewEnforcementCaseView() {
  const router = useRouter();
  const search = useSearchParams();
  const riskFlagId = search.get('riskFlagId');
  const instrumentIdParam = search.get('instrumentId');

  const [flag, setFlag] = useState<FlagPayload | null>(null);
  const [flagLoading, setFlagLoading] = useState(Boolean(riskFlagId));
  const [flagError, setFlagError] = useState<string | null>(null);

  const [subjectMode, setSubjectMode] = useState<SubjectMode>('serialNo');
  const [serialNo, setSerialNo] = useState('');
  const [certNo, setCertNo] = useState('');
  const [caseType, setCaseType] = useState<EnforcementCaseType>('OTHER');
  const [severity, setSeverity] = useState<EnforcementSeverity>('MEDIUM');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFlag = useCallback(async () => {
    if (!riskFlagId) return;
    try {
      const res = await fetch(`/api/risk/${riskFlagId}`);
      const body = (await res.json()) as FlagPayload & { success: boolean; error?: string };
      if (!body.success) {
        setFlagError(body.error || 'That risk finding could not be loaded.');
        return;
      }
      setFlag(body);
      setFlagError(null);

      // Prefill from the finding. Everything here stays editable — the officer is
      // the one signing their name to the case, not the detector.
      const mapped = FLAG_TO_CASE_TYPE[body.flag.flagType as RiskFlagType];
      if (mapped) setCaseType(mapped);
      setSeverity(severityFromLevel(body.flag.level));
      setTitle(body.flag.title.slice(0, 140));
      setDescription(
        [
          body.flag.recommendedAction ?? '',
          body.flag.reasons.length ? `Findings:\n${body.flag.reasons.map((r) => `• ${r}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      );
      if (body.subject.instrument?.serialNo) {
        setSubjectMode('serialNo');
        setSerialNo(body.subject.instrument.serialNo);
      }
    } catch {
      setFlagError('Could not reach the server to load that risk finding.');
    } finally {
      setFlagLoading(false);
    }
  }, [riskFlagId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await loadFlag();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFlag]);

  const flagUnconfirmed = Boolean(flag) && flag!.flag.status !== 'CONFIRMED';

  const subjectGiven = Boolean(instrumentIdParam) || (subjectMode === 'serialNo' ? serialNo.trim() : certNo.trim());
  const ready =
    Boolean(subjectGiven) &&
    title.trim().length >= TITLE_MIN &&
    description.trim().length >= DESCRIPTION_MIN &&
    !flagUnconfirmed &&
    !submitting;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        caseType,
        severity,
        title: title.trim(),
        description: description.trim(),
      };
      if (riskFlagId) payload.riskFlagId = riskFlagId;

      // One identifier, in the order the API resolves them. Sending both would
      // silently let the certificate win and confuse anyone reading the log.
      if (instrumentIdParam) payload.instrumentId = instrumentIdParam;
      else if (subjectMode === 'certNo') payload.certNo = certNo.trim();
      else payload.serialNo = serialNo.trim();

      const res = await fetch('/api/enforcement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as {
        success: boolean;
        error?: string;
        case?: { id: string; caseNo: string };
      };
      if (!body.success || !body.case) {
        setError(body.error || 'The case could not be opened.');
        return;
      }
      router.push(`/dashboard/enforcement/${body.case.id}`);
    } catch {
      setError('Could not reach the server. No case was opened.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <Link href="/dashboard/enforcement" className={styles.backLink}>
        <ArrowLeft size={15} />
        Enforcement register
      </Link>

      <div className={styles.pageHeader}>
        <h1>Open an enforcement case</h1>
        <p>
          A case is a record against a named business. The business is notified the moment it is
          opened — that is the point, not a side effect — and the case is assigned to you until
          somebody reassigns it. Nothing here can be deleted afterwards; a case that turns out to be
          unfounded is dismissed with a reason, which stays on the register.
        </p>
      </div>

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" className={styles.boxDismiss} onClick={() => setError(null)}>
            <X size={15} />
          </button>
        </div>
      )}

      {/* ── The risk finding this case comes from ── */}
      {flagLoading && (
        <div className={styles.flagLoading}>
          <Loader2 size={18} className={styles.spin} />
          Loading the risk finding…
        </div>
      )}

      {flagError && (
        <div className={styles.errorBox}>
          <AlertTriangle size={18} />
          <span>{flagError}</span>
        </div>
      )}

      {flag && (
        <section className={flagUnconfirmed ? styles.flagBlocked : styles.flagCard}>
          <div className={styles.flagHead}>
            <ShieldAlert size={17} />
            <div>
              <span className={styles.flagKind}>
                {RISK_FLAG_TYPE_LABELS[flag.flag.flagType as RiskFlagType] ?? flag.flag.flagType}
              </span>
              <strong>{flag.flag.title}</strong>
            </div>
            <span className={`clay-badge ${riskLevelBadgeClass(flag.flag.level)}`}>
              {flag.flag.level.charAt(0) + flag.flag.level.slice(1).toLowerCase()}
            </span>
          </div>

          {flag.flag.reasons.length > 0 && (
            <ul className={styles.flagReasons}>
              {flag.flag.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}

          <p className={styles.flagMeta}>Detected {formatDate(flag.flag.detectedAt)}</p>

          {flagUnconfirmed ? (
            <div className={styles.blockedNote}>
              <AlertTriangle size={16} />
              <div>
                <strong>This finding has not been confirmed yet.</strong>
                <p>
                  A case has to rest on an officer’s finding, not on a detector’s output — so the
                  flag must be confirmed first, with a written reason. Confirming it is not itself an
                  enforcement action; it records that somebody looked and agreed.
                </p>
                <Link href="/dashboard/risk" className="clay-btn clay-btn-outline clay-btn-sm">
                  Triage the finding
                </Link>
              </div>
            </div>
          ) : (
            <p className={styles.confirmedNote}>
              <CheckCircle2 size={15} />
              Confirmed. Its reasons are carried into the case description by the API, so the case
              file shows what the finding was without depending on this page.
            </p>
          )}
        </section>
      )}

      {/* ── The form ── */}
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          <Scale size={16} />
          Which instrument
        </h2>

        {instrumentIdParam ? (
          <p className={styles.hint}>
            Opened against a specific registered instrument. Its owner, jurisdiction and
            organisation are taken from the record rather than typed here — a case in the wrong
            district goes to the wrong office.
          </p>
        ) : (
          <>
            <div className={styles.modeRow}>
              <button
                type="button"
                className={`${styles.modeBtn} ${subjectMode === 'serialNo' ? styles.modeActive : ''}`}
                onClick={() => setSubjectMode('serialNo')}
              >
                By serial number
              </button>
              <button
                type="button"
                className={`${styles.modeBtn} ${subjectMode === 'certNo' ? styles.modeActive : ''}`}
                onClick={() => setSubjectMode('certNo')}
              >
                By certificate number
              </button>
            </div>

            {subjectMode === 'serialNo' ? (
              <div className={styles.field}>
                <label className="clay-label" htmlFor="serialNo">
                  Serial number on the instrument
                </label>
                <input
                  id="serialNo"
                  className="clay-input"
                  value={serialNo}
                  onChange={(e) => setSerialNo(e.target.value)}
                  placeholder="As stamped on the plate"
                  autoComplete="off"
                />
                <p className={styles.hint}>
                  Punctuation and case do not matter — the lookup normalises both. An instrument
                  that is not registered at all cannot have a case opened against it here; that is
                  a different violation and needs a field visit.
                </p>
              </div>
            ) : (
              <div className={styles.field}>
                <label className="clay-label" htmlFor="certNo">
                  Certificate number
                </label>
                <input
                  id="certNo"
                  className="clay-input"
                  value={certNo}
                  onChange={(e) => setCertNo(e.target.value)}
                  placeholder="VT-CERT-2026-000123"
                  autoComplete="off"
                />
                <p className={styles.hint}>
                  The number printed on the verification sticker. The instrument and its owner are
                  resolved from it.
                </p>
              </div>
            )}
          </>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          <Gavel size={16} />
          What kind of case
        </h2>

        <div className={styles.field}>
          <label className="clay-label" htmlFor="caseType">
            Case type
          </label>
          <select
            id="caseType"
            className="clay-select"
            value={caseType}
            onChange={(e) => setCaseType(e.target.value as EnforcementCaseType)}
          >
            {ENFORCEMENT_CASE_TYPES.map((t) => (
              <option key={t} value={t}>
                {ENFORCEMENT_CASE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <span className="clay-label">Severity</span>
          <div className={styles.severityRow}>
            {ENFORCEMENT_SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                className={`${styles.severityBtn} ${severity === s ? styles.severityActive : ''}`}
                onClick={() => setSeverity(s)}
              >
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          <p className={styles.hint}>
            Severity orders the register and nothing else. It does not set the penalty, and it can
            be retriaged later with the change logged.
          </p>
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          <Gavel size={16} />
          What is alleged
        </h2>

        <div className={styles.field}>
          <label className="clay-label" htmlFor="title">
            One line describing the problem
          </label>
          <input
            id="title"
            className="clay-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Platform scale in use with a broken verification seal"
            maxLength={160}
          />
          <p className={title.trim().length < TITLE_MIN ? styles.hintWarn : styles.hint}>
            At least {TITLE_MIN} characters. This is what appears in the register and in the
            business’s notification.
          </p>
        </div>

        <div className={styles.field}>
          <label className="clay-label" htmlFor="description">
            What was observed
          </label>
          <textarea
            id="description"
            className="clay-input"
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What you saw, when, and why it breaches the Act. Written for somebody who was not there — this is the case file, and it may be read by a court."
          />
          <p className={description.trim().length < DESCRIPTION_MIN ? styles.hintWarn : styles.hint}>
            At least {DESCRIPTION_MIN} characters. Evidence files are attached to the case once it
            exists.
          </p>
        </div>
      </section>

      <div className={styles.actions}>
        <Link href="/dashboard/enforcement" className="clay-btn clay-btn-ghost">
          Cancel
        </Link>
        <button
          type="button"
          className="clay-btn clay-btn-primary"
          disabled={!ready}
          onClick={() => void submit()}
        >
          {submitting ? <Loader2 size={17} className={styles.spin} /> : <Gavel size={17} />}
          Open the case
        </button>
      </div>

      <p className={styles.footNote}>
        Opening a case notifies the business immediately and assigns the case to you. Notice
        precedes a hearing and a hearing precedes a penalty — the case cannot skip those steps, and
        the sequence is what makes any penalty at the end of it defensible.
      </p>
    </div>
  );
}

export default function NewEnforcementCasePage() {
  return (
    <Suspense
      fallback={
        <div className={styles.loadingWrap}>
          <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
          <p>Loading…</p>
        </div>
      }
    >
      <NewEnforcementCaseView />
    </Suspense>
  );
}
