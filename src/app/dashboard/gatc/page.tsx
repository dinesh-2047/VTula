'use client';

import { useState, useEffect } from 'react';
import {
  Building2,
  CheckCircle,
  Award,
  Calendar,
  Loader2,
} from 'lucide-react';
import styles from './gatc.module.css';

interface GatcTestItem {
  _id: string;
  applicationNo: string;
  type: string;
  status: string;
  submittedDate: string;
  instrumentId?: {
    type: string;
    brand: string;
    model: string;
    serialNo: string;
    accuracyClass?: string;
  };
  ownerId?: {
    name: string;
  };
}

export default function GatcDashboardPage() {
  const [tests, setTests] = useState<GatcTestItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchGatcTests();
  }, []);

  const fetchGatcTests = async () => {
    try {
      const res = await fetch('/api/tasks');
      const data = await res.json();
      if (data.success) {
        setTests(data.applications || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleIssueGatcCert = async (appId: string) => {
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: appId,
          verdict: 'Approve',
          remarks: 'GATC Calibration test passed within ISO/IEC 17025 tolerances.',
          stampNo: `GATC-STAMP-${Math.floor(10000 + Math.random() * 90000)}`,
        }),
      });

      const data = await res.json();
      if (data.success) {
        fetchGatcTests();
      } else {
        alert(data.error || 'Failed to issue GATC report');
      }
    } catch {
      alert('Error issuing report');
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300, gap: 12 }}>
        <Loader2 size={36} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-primary)' }} />
        <p>Loading GATC calibration queue...</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Government Approved Test Centre (GATC)</h1>
          <p>Calibration lab testing, standards traceability, and verification test reports.</p>
        </div>
      </div>

      {tests.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', background: 'var(--surface-card)', borderRadius: 'var(--radius-xl)' }}>
          <Building2 size={48} style={{ color: 'var(--text-muted)', marginBottom: 12 }} />
          <h3>No GATC Calibration Requests</h3>
          <p style={{ color: 'var(--text-secondary)' }}>High-precision instruments requiring GATC lab testing will be queued here.</p>
        </div>
      ) : (
        <div className={styles.grid}>
          {tests.map((t) => (
            <div key={t._id} className={styles.gatcCard}>
              <div className={styles.cardHeader}>
                <div className={styles.gatcIcon}>
                  <Building2 size={24} />
                </div>
                <div>
                  <span className={styles.testNo}>{t.applicationNo}</span>
                  <div className={styles.reqBy}>{t.ownerId?.name || 'Applicant'}</div>
                </div>
                <span
                  className={`clay-badge ${
                    t.status === 'Approved' ? 'clay-badge-success' : 'clay-badge-pending'
                  }`}
                  style={{ marginLeft: 'auto' }}
                >
                  {t.status}
                </span>
              </div>

              <div className={styles.cardBody}>
                <h4>{t.instrumentId?.type || 'Precision Instrument'}</h4>
                <p className={styles.classBadge}>{t.instrumentId?.accuracyClass || 'Standard Precision'}</p>

                <div className={styles.row}>
                  <Calendar size={14} />
                  <span>Received Date: {formatDate(t.submittedDate)}</span>
                </div>
              </div>

              <div className={styles.cardFooter}>
                {t.status === 'Approved' ? (
                  <div className={styles.certDone}>
                    <CheckCircle size={16} /> GATC Report & Cert Issued
                  </div>
                ) : (
                  <button
                    className="clay-btn clay-btn-primary clay-btn-sm w-full"
                    onClick={() => handleIssueGatcCert(t._id)}
                  >
                    <Award size={15} /> Perform Lab Test & Certify
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
