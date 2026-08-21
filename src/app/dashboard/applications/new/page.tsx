'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  FileText,
  ArrowLeft,
  Loader2,
  CheckCircle,
  CreditCard,
  Scale,
} from 'lucide-react';
import { calculateFee } from '@/lib/utils';
import styles from './newApp.module.css';

interface InstrumentOption {
  _id: string;
  type: string;
  brand: string;
  model: string;
  serialNo: string;
  address?: string;
  installationDistrict?: string;
  installationState?: string;
}

declare global {
  interface Window {
    Razorpay: any;
  }
}

function NewApplicationForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedInstId = searchParams.get('instrumentId');

  const [instruments, setInstruments] = useState<InstrumentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const [formData, setFormData] = useState({
    instrumentId: preselectedInstId || '',
    type: 'initial',
    inspectionLocation: 'On-Site Business Premises',
    proposedDate: '',
    notes: '',
  });

  useEffect(() => {
    fetchInstruments();
    loadRazorpayScript();
  }, []);

  const loadRazorpayScript = () => {
    if (document.getElementById('razorpay-checkout-script')) return;
    const script = document.createElement('script');
    script.id = 'razorpay-checkout-script';
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);
  };

  const fetchInstruments = async () => {
    try {
      const res = await fetch('/api/instruments');
      const data = await res.json();
      if (data.success) {
        setInstruments(data.instruments);
        if (!preselectedInstId && data.instruments.length > 0) {
          setFormData((prev) => ({ ...prev, instrumentId: data.instruments[0]._id }));
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const selectedInstrument = instruments.find((i) => i._id === formData.instrumentId);
  const calculatedFee = selectedInstrument
    ? calculateFee(selectedInstrument.type)
    : 500;

  const createApplication = async (paymentId?: string, orderId?: string) => {
    const locationText =
      formData.inspectionLocation === 'On-Site Business Premises' && selectedInstrument?.address
        ? `${selectedInstrument.address}, ${selectedInstrument.installationDistrict || ''}, ${selectedInstrument.installationState || ''}`
        : formData.inspectionLocation;

    const res = await fetch('/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...formData,
        inspectionLocation: locationText,
        paymentId,
        orderId,
        feeStatus: paymentId ? 'Paid' : 'Unpaid',
      }),
    });

    const data = await res.json();
    if (data.success) {
      setSuccess(true);
      setTimeout(() => {
        router.push('/dashboard/applications');
      }, 1500);
    } else {
      setError(data.error || 'Failed to submit application');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.instrumentId) {
      setError('Please select an instrument');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      // 1. Create Razorpay order from backend
      const orderRes = await fetch('/api/payments/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: calculatedFee,
          currency: 'INR',
          notes: {
            instrumentId: formData.instrumentId,
            type: formData.type,
          },
        }),
      });

      const orderData = await orderRes.json();

      if (!orderData.success) {
        setError(orderData.error || 'Could not initiate payment order');
        setSubmitting(false);
        return;
      }

      // 2. Open Razorpay Checkout modal
      const razorpayKey = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_TSXVVEQ0vFzSGZ';

      const options = {
        key: razorpayKey,
        amount: orderData.order.amount,
        currency: orderData.order.currency,
        name: 'VTULA Legal Metrology',
        description: `Statutory Fee for ${selectedInstrument?.type || 'Instrument'} Verification`,
        order_id: orderData.order.id,
        handler: async function (response: any) {
          try {
            // 3. Verify Payment signature
            const verifyRes = await fetch('/api/payments/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });

            const verifyData = await verifyRes.json();

            if (verifyData.success) {
              // 4. Save Application with feeStatus: 'Paid'
              await createApplication(response.razorpay_payment_id, response.razorpay_order_id);
            } else {
              setError('Payment verification failed. Please contact support.');
            }
          } catch {
            setError('Payment verification failed.');
          } finally {
            setSubmitting(false);
          }
        },
        modal: {
          ondismiss: function () {
            setSubmitting(false);
          },
        },
        theme: {
          color: '#E07A5F',
        },
      };

      if (window.Razorpay) {
        const rzp = new window.Razorpay(options);
        rzp.on('payment.failed', function (response: any) {
          setError(`Payment Failed: ${response.error?.description || 'Transaction declined'}`);
          setSubmitting(false);
        });
        rzp.open();
      } else {
        setError('Razorpay SDK failed to load. Please refresh and try again.');
        setSubmitting(false);
      }
    } catch {
      setError('Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading form...</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Link href="/dashboard/applications" className={styles.backLink}>
        <ArrowLeft size={16} />
        Back to Applications
      </Link>

      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerIcon}>
            <FileText size={28} />
          </div>
          <div>
            <h1>Submit Verification Application</h1>
            <p>Apply for Legal Metrology stamping & verification with auto fee calculation.</p>
          </div>
        </div>

        {success ? (
          <div className={styles.successCard}>
            <CheckCircle size={48} style={{ color: 'var(--color-secondary)' }} />
            <h2>Application Submitted & Fee Paid!</h2>
            <p>Your payment was verified and the application filed successfully. Redirecting...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className={styles.formCard}>
            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formGrid}>
              <div className="clay-input-group" style={{ gridColumn: 'span 2' }}>
                <label className="clay-label">Select Instrument *</label>
                {instruments.length === 0 ? (
                  <div className={styles.noInstWarning}>
                    <p>No instruments registered yet.</p>
                    <Link href="/dashboard/instruments/new" className="clay-btn clay-btn-sm clay-btn-primary">
                      Register Instrument First
                    </Link>
                  </div>
                ) : (
                  <select
                    className="clay-input clay-select"
                    value={formData.instrumentId}
                    onChange={(e) => setFormData((prev) => ({ ...prev, instrumentId: e.target.value }))}
                    required
                  >
                    {instruments.map((i) => (
                      <option key={i._id} value={i._id}>
                        {i.type} — {i.brand} ({i.serialNo})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Verification Type *</label>
                <select
                  className="clay-input clay-select"
                  value={formData.type}
                  onChange={(e) => setFormData((prev) => ({ ...prev, type: e.target.value }))}
                >
                  <option value="initial">Initial Verification</option>
                  <option value="re-verification">Periodic Re-verification</option>
                </select>
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Inspection Venue *</label>
                <select
                  className="clay-input clay-select"
                  value={formData.inspectionLocation}
                  onChange={(e) => setFormData((prev) => ({ ...prev, inspectionLocation: e.target.value }))}
                >
                  <option value="On-Site Business Premises">On-Site Business Premises</option>
                  <option value="Government Approved Test Centre (GATC Lab)">Government Test Centre (GATC Lab)</option>
                  <option value="Regional Metrology Office">Regional Metrology Office</option>
                </select>
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Preferred Inspection Date</label>
                <input
                  type="date"
                  className="clay-input"
                  value={formData.proposedDate}
                  onChange={(e) => setFormData((prev) => ({ ...prev, proposedDate: e.target.value }))}
                  min={new Date().toISOString().split('T')[0]}
                />
              </div>

              <div className="clay-input-group" style={{ gridColumn: 'span 2' }}>
                <label className="clay-label">Additional Instructions / Notes</label>
                <textarea
                  className="clay-input"
                  placeholder="e.g. Please call before arrival at factory premises"
                  value={formData.notes}
                  onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                  rows={3}
                />
              </div>
            </div>

            {/* Fee Summary Box */}
            <div className={styles.feeCard}>
              <div className={styles.feeHeader}>
                <Scale size={20} />
                <span>Statutory Government Fee Breakdown</span>
              </div>
              <div className={styles.feeRow}>
                <span>Verification Fee ({selectedInstrument?.type || 'Standard'})</span>
                <span>₹{calculatedFee}</span>
              </div>
              <div className={styles.feeRow}>
                <span>Portal Service Charge</span>
                <span>₹0 (Waived)</span>
              </div>
              <div className={`${styles.feeRow} ${styles.feeTotal}`}>
                <span>Total Amount Due</span>
                <span>₹{calculatedFee}</span>
              </div>
            </div>

            {/* Submit Actions */}
            <div className={styles.formActions}>
              <Link href="/dashboard/applications" className="clay-btn clay-btn-ghost">
                Cancel
              </Link>
              <button
                type="submit"
                className="clay-btn clay-btn-primary clay-btn-lg"
                disabled={submitting || instruments.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                {submitting ? (
                  <Loader2 size={18} className={styles.spin} />
                ) : (
                  <CreditCard size={18} />
                )}
                {submitting ? 'Processing Payment...' : `Pay ₹${calculatedFee} & Submit Application`}
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
    <Suspense fallback={<div>Loading...</div>}>
      <NewApplicationForm />
    </Suspense>
  );
}
