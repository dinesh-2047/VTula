'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  FileText,
  ArrowLeft,
  ArrowRight,
  Loader2,
  CheckCircle,
  CreditCard,
  Scale,
  AlertTriangle,
  Info,
  Clock,
} from 'lucide-react';
import {
  VERIFICATION_TYPES,
  VERIFICATION_TYPE_LABELS,
  type VerificationType,
} from '@/lib/constants';
import { payApplicationFee, prefetchCheckout } from '@/lib/razorpayCheckout';
import styles from './newApp.module.css';

/**
 * Filing an application, then paying for it.
 *
 * The old page had the order backwards: it created a Razorpay order for a fee it
 * calculated in the browser, took the payment, and only then created the
 * application — passing `feeStatus: 'Paid'` along with it. That meant the price
 * was whatever the client believed, the charge was whatever the client asked for,
 * and a payment that succeeded while the application creation failed left money
 * taken against nothing.
 *
 * The order now matches the server: file the application (the server computes the
 * fee from the applicable rule), open an order *for that application*, pay, and
 * let `/api/payments/verify` be the only thing that marks it paid.
 *
 * Two further things were wrong once the payment could fail:
 *
 *  - Checkout lived here, with its own `Window.Razorpay` declaration and its own
 *    copy of the order → pay → verify sequence. It now calls
 *    `payApplicationFee()` from `@/lib/razorpayCheckout`, which is the single
 *    implementation the application page uses too. Two copies of a payment flow
 *    drift, and the copy that drifts is the one that credits money.
 *  - An abandoned or failed payment dropped the applicant back onto the *form*
 *    with a message saying they could "pay from the application page". Pressing
 *    the only button in front of them would try to file the application a second
 *    time, and the page they were sent to went unnamed. There is now a filed-but-
 *    unpaid state that says what happened, offers the payment again, and links to
 *    the application itself.
 *
 * The verification types come from `@/lib/constants` rather than a local list:
 * the local one labelled `repair` "After Repair" while the rest of the product
 * calls it "Post-repair Verification".
 */

interface InstrumentOption {
  _id: string;
  type: string;
  brand: string;
  model: string;
  serialNo: string;
  address?: string;
  installationDistrict?: string;
  installationState?: string;
  isDecommissioned?: boolean;
}

interface Preview {
  verificationType: { effective: string; label: string; reclassified?: string };
  fee: { amount: number; base: number; payable: boolean; note?: string };
  rule: {
    name: string;
    matchedScope: string;
    validityMonths: number;
    requiredDocuments: string[];
    legalReference?: string;
  };
  blockers: { code: string; message: string }[];
}

interface FiledApplication {
  id: string;
  applicationNo: string;
  feeStatus: string;
  feeAmount: number;
}

function NewApplicationForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const preselectedInstId = searchParams.get('instrumentId');

  const [instruments, setInstruments] = useState<InstrumentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stage, setStage] = useState<'form' | 'filing' | 'paying' | 'unpaid' | 'done'>('form');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filed, setFiled] = useState<FiledApplication | null>(null);

  const [formData, setFormData] = useState({
    instrumentId: preselectedInstId || '',
    type: 'initial',
    inspectionLocation: 'On-Site Business Premises',
    preferredDate: '',
    remarks: '',
  });

  // Warm the checkout script now rather than at the moment pay is pressed. The
  // fee falls due immediately after filing, and racing the download there is what
  // made the old page tell people to refresh mid-payment.
  useEffect(() => {
    prefetchCheckout();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The default excludes decommissioned instruments, which cannot be
        // submitted for verification anyway.
        const res = await fetch('/api/instruments');
        const data = (await res.json()) as {
          success: boolean;
          error?: string;
          instruments?: InstrumentOption[];
        };
        if (cancelled) return;

        if (data.success) {
          const list = data.instruments ?? [];
          setInstruments(list);
          if (!preselectedInstId && list.length > 0) {
            setFormData((prev) => ({ ...prev, instrumentId: list[0]._id }));
          }
        } else {
          setError(data.error || 'Could not load your instruments');
        }
      } catch {
        if (!cancelled) {
          setError('Could not load your instruments. Check your connection and try again.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preselectedInstId]);

  /**
   * The fee, the rule and any blockers all come from the server.
   *
   * `seq` drops the answer to a superseded request: changing instrument twice in
   * quick succession could otherwise leave the first instrument's fee on screen
   * next to the second instrument's name.
   */
  const previewSeq = useRef(0);
  const loadPreview = useCallback(async (instrumentId: string, type: string) => {
    const seq = ++previewSeq.current;
    if (!instrumentId) {
      setPreview(null);
      return;
    }
    setPreviewing(true);
    try {
      const res = await fetch(
        `/api/applications/preview?instrumentId=${encodeURIComponent(instrumentId)}&type=${encodeURIComponent(type)}`
      );
      const data = (await res.json()) as Preview & { success: boolean; error?: string };
      if (seq !== previewSeq.current) return;
      setPreview(data.success ? data : null);
      if (!data.success) setError(data.error || 'Could not price this application');
    } catch {
      if (seq === previewSeq.current) setPreview(null);
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await loadPreview(formData.instrumentId, formData.type);
    })();
    return () => {
      cancelled = true;
    };
  }, [formData.instrumentId, formData.type, loadPreview]);

  const selectedInstrument = instruments.find((i) => i._id === formData.instrumentId);
  const fee = preview?.fee.amount ?? null;
  const blocked = (preview?.blockers.length ?? 0) > 0;

  const finish = useCallback(() => {
    setError('');
    setStage('done');
    setTimeout(() => router.push('/dashboard/applications'), 2200);
  }, [router]);

  /** Step 2: pay the fee the server computed for the filed application. */
  const payFor = useCallback(
    async (application: FiledApplication) => {
      setError('');
      setNotice('');
      setSubmitting(true);
      setStage('paying');

      const result = await payApplicationFee({
        applicationId: application.id,
        applicationNo: application.applicationNo,
        prefill: {
          name: session?.user?.name ?? undefined,
          email: session?.user?.email ?? undefined,
        },
      });

      setSubmitting(false);

      if (result.status === 'paid') {
        setFiled({ ...application, feeStatus: result.feeStatus ?? 'Paid' });
        finish();
        return;
      }

      // The application exists either way. Everything from here on is about the
      // fee, and the wording must never suggest filing again.
      setStage('unpaid');
      setNotice(
        result.status === 'dismissed'
          ? 'The payment window was closed before the fee was paid.'
          : result.message
      );
    },
    [finish, session?.user?.email, session?.user?.name]
  );

  /** Step 1: file the application. The server prices it. */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.instrumentId) {
      setError('Select the instrument this application is for');
      return;
    }
    if (blocked) return;

    setSubmitting(true);
    setError('');
    setStage('filing');

    try {
      const locationText =
        formData.inspectionLocation === 'On-Site Business Premises' && selectedInstrument?.address
          ? `${selectedInstrument.address}, ${selectedInstrument.installationDistrict ?? ''}, ${selectedInstrument.installationState ?? ''}`
          : formData.inspectionLocation;

      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrumentId: formData.instrumentId,
          type: formData.type,
          inspectionLocation: locationText,
          preferredDate: formData.preferredDate || undefined,
          remarks: formData.remarks || undefined,
        }),
      });
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        application?: {
          id: string;
          applicationNo: string;
          feeStatus: string;
          feeAmount: number;
        };
      };

      if (!data.success || !data.application) {
        setError(data.error || 'The application could not be filed');
        setSubmitting(false);
        setStage('form');
        return;
      }

      const app = data.application;
      const record: FiledApplication = {
        id: app.id,
        applicationNo: app.applicationNo,
        feeStatus: app.feeStatus,
        feeAmount: app.feeAmount ?? 0,
      };
      setFiled(record);

      // A waived fee has nothing to pay for.
      if (app.feeStatus === 'Waived' || !app.feeAmount) {
        setSubmitting(false);
        finish();
        return;
      }

      await payFor(record);
    } catch {
      setError('Something went wrong. Check your connection and try again.');
      setSubmitting(false);
      setStage('form');
    }
  };

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading your instruments…</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Link href="/dashboard/applications" className={styles.backLink}>
        <ArrowLeft size={16} />
        Back to applications
      </Link>

      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerIcon}>
            <FileText size={28} />
          </div>
          <div>
            <h1>Apply for verification</h1>
            <p>
              File an application for stamping and verification under the Legal Metrology Act, 2009.
            </p>
          </div>
        </div>

        {stage === 'done' ? (
          <div className={styles.successCard}>
            <CheckCircle size={48} style={{ color: 'var(--color-secondary)' }} />
            <h2>{filed?.applicationNo} filed</h2>
            <p>
              {filed?.feeStatus === 'Paid'
                ? 'Your fee has been received. The application is now with the Legal Metrology department — you will be notified when an inspection is scheduled.'
                : 'No fee is payable. The application is now with the Legal Metrology department for review.'}
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Taking you to your applications…
            </p>
          </div>
        ) : stage === 'unpaid' && filed ? (
          /*
           * Filed, fee outstanding. The application is real and must not be filed
           * again, so the form is gone and both routes forward are named.
           */
          <div className={styles.successCard}>
            <Clock size={44} style={{ color: 'var(--status-warning)' }} />
            <h2>{filed.applicationNo} filed — fee outstanding</h2>
            <p>{notice}</p>
            <p className={styles.filedNote}>
              Nothing has been charged and the application has not been lost: it is filed and will
              be reviewed. The certificate cannot be issued until the ₹
              {filed.feeAmount.toLocaleString('en-IN')} fee is paid, and you can pay it here or from
              the application at any time.
            </p>
            <div className={styles.filedActions}>
              <button
                type="button"
                className="clay-btn clay-btn-primary"
                onClick={() => void payFor(filed)}
                disabled={submitting}
              >
                {submitting ? (
                  <Loader2 size={18} className={styles.spin} />
                ) : (
                  <CreditCard size={18} />
                )}
                Pay ₹{filed.feeAmount.toLocaleString('en-IN')} now
              </button>
              <Link
                href={`/dashboard/applications/${filed.id}`}
                className="clay-btn clay-btn-outline"
              >
                Open {filed.applicationNo}
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className={styles.formCard}>
            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formGrid}>
              <div className="clay-input-group" style={{ gridColumn: 'span 2' }}>
                <label className="clay-label">Instrument *</label>
                {instruments.length === 0 ? (
                  <div className={styles.noInstWarning}>
                    <p>You have no instruments registered yet.</p>
                    <Link
                      href="/dashboard/instruments/new"
                      className="clay-btn clay-btn-sm clay-btn-primary"
                    >
                      Register an instrument
                    </Link>
                  </div>
                ) : (
                  <select
                    className="clay-input clay-select"
                    value={formData.instrumentId}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, instrumentId: e.target.value }))
                    }
                    required
                  >
                    {instruments.map((i) => (
                      <option key={i._id} value={i._id}>
                        {i.type} — {i.brand} {i.model} ({i.serialNo})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Type of verification *</label>
                <select
                  className="clay-input clay-select"
                  value={formData.type}
                  onChange={(e) => setFormData((prev) => ({ ...prev, type: e.target.value }))}
                >
                  {VERIFICATION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {VERIFICATION_TYPE_LABELS[t as VerificationType]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Where the inspection will happen *</label>
                <select
                  className="clay-input clay-select"
                  value={formData.inspectionLocation}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, inspectionLocation: e.target.value }))
                  }
                >
                  <option value="On-Site Business Premises">At my business premises</option>
                  <option value="Government Approved Test Centre (GATC Lab)">
                    Government Approved Test Centre (GATC)
                  </option>
                  <option value="Regional Metrology Office">Regional Metrology office</option>
                </select>
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Preferred date (optional)</label>
                <input
                  type="date"
                  className="clay-input"
                  value={formData.preferredDate}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, preferredDate: e.target.value }))
                  }
                  min={new Date().toISOString().split('T')[0]}
                />
              </div>

              <div className="clay-input-group" style={{ gridColumn: 'span 2' }}>
                <label className="clay-label">Anything the officer should know (optional)</label>
                <textarea
                  className="clay-input"
                  placeholder="e.g. Please call before arriving — the premises are inside a gated market."
                  value={formData.remarks}
                  onChange={(e) => setFormData((prev) => ({ ...prev, remarks: e.target.value }))}
                  rows={3}
                />
              </div>
            </div>

            {preview?.verificationType.reclassified && (
              <div className={styles.feeCard} style={{ marginTop: 20 }}>
                <div className={styles.feeHeader}>
                  <Info size={18} />
                  <span>Filed as {preview.verificationType.label}</span>
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {preview.verificationType.reclassified}
                </p>
              </div>
            )}

            {preview?.blockers.map((b) => (
              <div key={b.code} className={styles.error} style={{ marginTop: 20, marginBottom: 0 }}>
                <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                {b.message}
              </div>
            ))}

            {/* The fee, as quoted by the server that will charge it. */}
            <div className={styles.feeCard}>
              <div className={styles.feeHeader}>
                <Scale size={20} />
                <span>Statutory fee</span>
              </div>

              {previewing ? (
                <div className={styles.feeRow}>
                  <span>Calculating from the applicable rule…</span>
                  <Loader2 size={14} className={styles.spin} />
                </div>
              ) : preview ? (
                <>
                  <div className={styles.feeRow}>
                    <span>{preview.verificationType.label}</span>
                    <span>₹{preview.fee.amount}</span>
                  </div>
                  <div className={styles.feeRow}>
                    <span>Portal charge</span>
                    <span>None</span>
                  </div>
                  <div className={`${styles.feeRow} ${styles.feeTotal}`}>
                    <span>Payable now</span>
                    <span>₹{preview.fee.amount}</span>
                  </div>
                  <div
                    className={styles.feeRow}
                    style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 8 }}
                  >
                    <span>
                      {preview.rule.name} · {preview.rule.matchedScope} · certificate valid{' '}
                      {preview.rule.validityMonths} months
                    </span>
                  </div>
                  {preview.rule.legalReference && (
                    <div
                      className={styles.feeRow}
                      style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}
                    >
                      <span>{preview.rule.legalReference}</span>
                    </div>
                  )}
                  {preview.fee.note && (
                    <div className={styles.feeRow} style={{ fontSize: '0.8rem' }}>
                      <span>{preview.fee.note}</span>
                    </div>
                  )}
                </>
              ) : (
                <div className={styles.feeRow}>
                  <span>Select an instrument to see the fee.</span>
                </div>
              )}
            </div>

            {preview && preview.rule.requiredDocuments.length > 0 && (
              <div className={styles.feeCard}>
                <div className={styles.feeHeader}>
                  <FileText size={18} />
                  <span>Documents the officer will ask for</span>
                </div>
                {preview.rule.requiredDocuments.map((d) => (
                  <div key={d} className={styles.feeRow}>
                    <span>{d}</span>
                  </div>
                ))}
                <div
                  className={styles.feeRow}
                  style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 8 }}
                >
                  <span>
                    You can upload these from the application page after filing — they are not
                    needed to submit.
                  </span>
                </div>
              </div>
            )}

            <div className={styles.formActions}>
              <Link href="/dashboard/applications" className="clay-btn clay-btn-ghost">
                Cancel
              </Link>
              <button
                type="submit"
                className="clay-btn clay-btn-primary clay-btn-lg"
                disabled={submitting || previewing || blocked || instruments.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                {submitting ? (
                  <Loader2 size={18} className={styles.spin} />
                ) : (
                  <CreditCard size={18} />
                )}
                {stage === 'filing'
                  ? 'Filing application…'
                  : stage === 'paying'
                    ? 'Waiting for payment…'
                    : fee === 0
                      ? 'File application'
                      : `File and pay ₹${fee ?? '—'}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function NewApplicationPageWrapper() {
  return (
    <Suspense
      fallback={
        <div className={styles.loadingWrap}>
          <Loader2 size={36} className={styles.spin} />
        </div>
      }
    >
      <NewApplicationForm />
    </Suspense>
  );
}
