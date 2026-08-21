'use client';

import { useState, useEffect } from 'react';
import {
  Download,
  IndianRupee,
  FileCheck,
  Building,
  Shield,
  Loader2,
} from 'lucide-react';
import styles from './reports.module.css';

interface ReportSummary {
  totalInstruments: number;
  totalCertificates: number;
  totalApplications: number;
  totalRevenue: number;
  districtStats: {
    district: string;
    instrumentsCount: number;
    certsCount: number;
    revenue: number;
  }[];
}

export default function ReportsDashboardPage() {
  const [summary, setSummary] = useState<ReportSummary>({
    totalInstruments: 0,
    totalCertificates: 0,
    totalApplications: 0,
    totalRevenue: 0,
    districtStats: [],
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchReportData();
  }, []);

  const fetchReportData = async () => {
    try {
      const [instRes, appRes, certRes] = await Promise.all([
        fetch('/api/instruments'),
        fetch('/api/applications'),
        fetch('/api/certificates'),
      ]);

      const instData = await instRes.json();
      const appData = await appRes.json();
      const certData = await certRes.json();

      const instruments = instData.instruments || [];
      const applications = appData.applications || [];
      const certificates = certData.certificates || [];

      // Calculate statutory revenue sum
      const totalRev = applications.reduce((acc: number, app: any) => acc + (app.feePaid || 0), 0);

      // Group by district
      const districtsMap: Record<string, { instrumentsCount: number; certsCount: number; revenue: number }> = {};

      instruments.forEach((inst: any) => {
        const dist = inst.installationDistrict || 'Central Division';
        if (!districtsMap[dist]) {
          districtsMap[dist] = { instrumentsCount: 0, certsCount: 0, revenue: 0 };
        }
        districtsMap[dist].instrumentsCount += 1;
      });

      applications.forEach((app: any) => {
        const dist = app.instrumentId?.installationDistrict || 'Central Division';
        if (!districtsMap[dist]) {
          districtsMap[dist] = { instrumentsCount: 0, certsCount: 0, revenue: 0 };
        }
        districtsMap[dist].revenue += app.feePaid || 0;
      });

      certificates.forEach((cert: any) => {
        const dist = cert.instrumentSnapshot?.installationDistrict || 'Central Division';
        if (!districtsMap[dist]) {
          districtsMap[dist] = { instrumentsCount: 0, certsCount: 0, revenue: 0 };
        }
        districtsMap[dist].certsCount += 1;
      });

      const districtStats = Object.keys(districtsMap).map((d) => ({
        district: d,
        ...districtsMap[d],
      }));

      setSummary({
        totalInstruments: instruments.length,
        totalCertificates: certificates.length,
        totalApplications: applications.length,
        totalRevenue: totalRev,
        districtStats,
      });
    } catch (err) {
      console.error('Reports fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExportCsv = () => {
    const headers = ['District Jurisdiction', 'Instruments Registered', 'Certificates Issued', 'Revenue Collected (INR)', 'Status'];
    const rows = summary.districtStats.map((st) => [
      `"${st.district}"`,
      st.instrumentsCount,
      st.certsCount,
      st.revenue,
      '"Active"',
    ]);

    const csvContent = [
      'LEGAL METROLOGY STATE ENFORCEMENT & COMPLIANCE AUDIT REPORT',
      `Generated On: ${new Date().toLocaleString('en-IN')}`,
      `Total Revenue: INR ${summary.totalRevenue}`,
      `Total Certificates: ${summary.totalCertificates}`,
      `Total Instruments: ${summary.totalInstruments}`,
      `Total Applications: ${summary.totalApplications}`,
      '',
      headers.join(','),
      ...rows.map((r) => r.join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `legal_metrology_audit_report_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 350, gap: 12 }}>
        <Loader2 size={36} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-primary)' }} />
        <p>Calculating Legal Metrology state analytics...</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Legal Metrology State Analytics</h1>
          <p>Real-time revenue monitoring, compliance stats, and district verification reports.</p>
        </div>
        <button
          className="clay-btn clay-btn-primary"
          onClick={handleExportCsv}
        >
          <Download size={18} />
          Export Audit Report (CSV)
        </button>
      </div>

      {/* Metrics Row */}
      <div className={styles.metricsGrid}>
        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <div className={styles.metricIcon} style={{ background: 'rgba(224, 122, 95, 0.1)', color: 'var(--color-primary)' }}>
              <IndianRupee size={22} />
            </div>
            <span className="clay-badge clay-badge-success">Statutory</span>
          </div>
          <div className={styles.metricVal}>₹{summary.totalRevenue.toLocaleString('en-IN')}</div>
          <div className={styles.metricLabel}>Total Fees Collected</div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <div className={styles.metricIcon} style={{ background: 'rgba(129, 178, 154, 0.12)', color: 'var(--color-secondary-dark)' }}>
              <FileCheck size={22} />
            </div>
            <span className="clay-badge clay-badge-info">Active</span>
          </div>
          <div className={styles.metricVal}>{summary.totalCertificates}</div>
          <div className={styles.metricLabel}>Certificates Issued</div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <div className={styles.metricIcon} style={{ background: 'rgba(242, 204, 143, 0.2)', color: 'var(--color-accent-dark)' }}>
              <Building size={22} />
            </div>
            <span className="clay-badge clay-badge-primary">Registered</span>
          </div>
          <div className={styles.metricVal}>{summary.totalInstruments}</div>
          <div className={styles.metricLabel}>Registered Commercial Instruments</div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <div className={styles.metricIcon} style={{ background: 'rgba(61, 64, 91, 0.1)', color: 'var(--color-charcoal)' }}>
              <Shield size={22} />
            </div>
            <span className="clay-badge clay-badge-success">100% Authentic</span>
          </div>
          <div className={styles.metricVal}>{summary.totalApplications}</div>
          <div className={styles.metricLabel}>Applications Processed</div>
        </div>
      </div>

      {/* District Compliance Performance Table */}
      <div className={styles.tableCard}>
        <div className={styles.tableCardHeader}>
          <h3>District Compliance & Revenue Breakdown</h3>
          <p>Jurisdiction performance across state divisions based on database telemetry</p>
        </div>

        {summary.districtStats.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)' }}>
            No district telemetry recorded yet. Register instruments to populate district analytics.
          </div>
        ) : (
          <table className="clay-table">
            <thead>
              <tr>
                <th>District Jurisdiction</th>
                <th>Instruments Registered</th>
                <th>Certificates Issued</th>
                <th>Revenue Collected</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {summary.districtStats.map((st, i) => (
                <tr key={i}>
                  <td><strong>{st.district}</strong></td>
                  <td>{st.instrumentsCount}</td>
                  <td>{st.certsCount}</td>
                  <td>₹{st.revenue.toLocaleString('en-IN')}</td>
                  <td><span className="clay-badge clay-badge-success">Active</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
