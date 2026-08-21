'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  Scale,
  FileText,
  Award,
  Clock,
  Plus,
  ArrowRight,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  ClipboardCheck,
  Building2,
} from 'lucide-react';
import styles from './page.module.css';

interface DashboardStats {
  totalInstruments: number;
  pendingApplications: number;
  activeCertificates: number;
  upcomingExpiries: number;
  inspectionsCompletedToday?: number;
}

interface RecentItem {
  _id: string;
  type: string;
  title: string;
  status: string;
  date: string;
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const userRole = (session?.user as { role?: string })?.role || 'Owner';
  const isOfficer = userRole === 'LMO' || userRole === 'GATC' || userRole === 'Admin';

  const [stats, setStats] = useState<DashboardStats>({
    totalInstruments: 0,
    pendingApplications: 0,
    activeCertificates: 0,
    upcomingExpiries: 0,
    inspectionsCompletedToday: 0,
  });
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
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

      const pendingApps = applications.filter((a: any) => a.status === 'Pending' || a.status === 'Submitted' || a.status === 'Scheduled');
      const approvedApps = applications.filter((a: any) => a.status === 'Approved');
      const activeCerts = certificates.filter((c: any) => c.status === 'Active');

      setStats({
        totalInstruments: instruments.length,
        pendingApplications: pendingApps.length,
        activeCertificates: activeCerts.length,
        inspectionsCompletedToday: approvedApps.length,
        upcomingExpiries: certificates.filter((c: any) => {
          const exp = new Date(c.expiryDate).getTime();
          const thirtyDays = Date.now() + 30 * 24 * 60 * 60 * 1000;
          return exp <= thirtyDays && c.status === 'Active';
        }).length,
      });

      const recent: RecentItem[] = [
        ...applications.slice(0, 3).map((a: any) => ({
          _id: a._id,
          type: 'application',
          title: `App ${a.applicationNo} — ${a.instrumentId?.type || 'Instrument'}`,
          status: a.status,
          date: new Date(a.createdAt || a.submittedDate).toLocaleDateString('en-IN'),
        })),
        ...certificates.slice(0, 3).map((c: any) => ({
          _id: c._id,
          type: 'certificate',
          title: `Cert ${c.certNo} issued`,
          status: c.status,
          date: new Date(c.issuedDate || c.createdAt).toLocaleDateString('en-IN'),
        })),
      ];

      setRecentItems(recent);
    } catch (err) {
      console.error('Dashboard data fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const statCards = isOfficer
    ? [
        {
          label: 'Pending Inspection Tasks',
          value: stats.pendingApplications,
          icon: ClipboardCheck,
          color: 'var(--status-pending)',
          bg: 'var(--status-pending-bg)',
          href: '/dashboard/tasks',
        },
        {
          label: 'Inspections Verified',
          value: stats.inspectionsCompletedToday || 0,
          icon: ShieldCheck,
          color: 'var(--color-secondary)',
          bg: 'rgba(129, 178, 154, 0.08)',
          href: '/dashboard/tasks',
        },
        {
          label: 'Certificates Issued',
          value: stats.activeCertificates,
          icon: Award,
          color: 'var(--color-primary)',
          bg: 'rgba(224, 122, 95, 0.08)',
          href: '/dashboard/certificates',
        },
        {
          label: 'Jurisdiction Region',
          value: (session?.user as any)?.district || 'Central District',
          icon: Building2,
          color: 'var(--text-primary)',
          bg: 'var(--surface-warm)',
          href: '/dashboard/reports',
        },
      ]
    : [
        {
          label: 'Total Instruments',
          value: stats.totalInstruments,
          icon: Scale,
          color: 'var(--color-primary)',
          bg: 'rgba(224, 122, 95, 0.08)',
          href: '/dashboard/instruments',
        },
        {
          label: 'Pending Applications',
          value: stats.pendingApplications,
          icon: FileText,
          color: 'var(--status-pending)',
          bg: 'var(--status-pending-bg)',
          href: '/dashboard/applications',
        },
        {
          label: 'Active Certificates',
          value: stats.activeCertificates,
          icon: Award,
          color: 'var(--color-secondary)',
          bg: 'rgba(129, 178, 154, 0.08)',
          href: '/dashboard/certificates',
        },
        {
          label: 'Upcoming Expiries',
          value: stats.upcomingExpiries,
          icon: Clock,
          color: 'var(--status-warning)',
          bg: 'var(--status-warning-bg)',
          href: '/dashboard/certificates',
        },
      ];

  const getStatusBadge = (status: string) => {
    const map: Record<string, string> = {
      Submitted: 'clay-badge-info',
      Pending: 'clay-badge-pending',
      Active: 'clay-badge-success',
      Scheduled: 'clay-badge-info',
      Warning: 'clay-badge-warning',
      Approved: 'clay-badge-success',
      Rejected: 'clay-badge-error',
    };
    return map[status] || 'clay-badge-charcoal';
  };

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading dashboard telemetry...</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Page Header */}
      <div className={styles.pageHeader}>
        <div>
          <h1>{isOfficer ? 'LMO Inspection Telemetry' : 'Dashboard Overview'}</h1>
          <p>
            {isOfficer
              ? `Legal Metrology Field Verification & Compliance Workspace (${userRole})`
              : 'Real-time telemetry and Legal Metrology activity.'}
          </p>
        </div>

        <div className={styles.quickActions}>
          {isOfficer ? (
            <>
              <Link href="/dashboard/tasks" className="clay-btn clay-btn-primary">
                <ClipboardCheck size={18} />
                Inspection Tasks ({stats.pendingApplications})
              </Link>
              <Link href="/dashboard/reports" className="clay-btn clay-btn-secondary">
                <FileText size={18} />
                View Analytics & Reports
              </Link>
            </>
          ) : (
            <>
              <Link href="/dashboard/instruments/new" className="clay-btn clay-btn-secondary">
                <Plus size={18} />
                Add Instrument
              </Link>
              <Link href="/dashboard/applications/new" className="clay-btn clay-btn-primary">
                <Plus size={18} />
                New Application
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Stats Grid */}
      <div className={styles.statsGrid}>
        {statCards.map((card) => (
          <Link key={card.label} href={card.href} className={styles.statCard}>
            <div className={styles.statIcon} style={{ background: card.bg, color: card.color }}>
              <card.icon size={24} />
            </div>
            <div className={styles.statInfo}>
              <div className={styles.statValue}>{card.value}</div>
              <div className={styles.statLabel}>{card.label}</div>
            </div>
            <TrendingUp size={18} className={styles.statArrow} />
          </Link>
        ))}
      </div>

      {/* Content Grid */}
      <div className={styles.contentGrid}>
        {/* Recent Activity */}
        <div className={`clay-card ${styles.activityCard}`}>
          <div className={styles.cardHeader}>
            <h3>{isOfficer ? 'Recent Inspection Stream' : 'Recent Activity'}</h3>
            <Link href={isOfficer ? '/dashboard/tasks' : '/dashboard/applications'} className={styles.viewAll}>
              View All <ArrowRight size={14} />
            </Link>
          </div>

          <div className={styles.activityList}>
            {recentItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)' }}>
                No recent activity recorded.
              </div>
            ) : (
              recentItems.map((item) => (
                <div key={item._id} className={styles.activityItem}>
                  <div className={styles.activityIcon}>
                    {item.type === 'certificate' ? (
                      <Award size={18} />
                    ) : (
                      <FileText size={18} />
                    )}
                  </div>
                  <div className={styles.activityInfo}>
                    <span className={styles.activityTitle}>{item.title}</span>
                    <span className={styles.activityDate}>{item.date}</span>
                  </div>
                  <span className={`clay-badge ${getStatusBadge(item.status)}`}>
                    {item.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Quick Guidelines */}
        <div className={`clay-card ${styles.tipsCard}`}>
          <h3>{isOfficer ? 'Legal Metrology Inspection Mandates' : 'Quick Guidelines'}</h3>

          {isOfficer ? (
            <>
              <div className={styles.tipItem}>
                <ShieldCheck size={18} style={{ color: 'var(--color-secondary)', flexShrink: 0 }} />
                <div>
                  <strong>Mandatory Geo-Tagged Evidence</strong>
                  <p>Capture clear field inspection photos with live GPS coordinates before issuing electronic stamps.</p>
                </div>
              </div>

              <div className={styles.tipItem}>
                <AlertTriangle size={18} style={{ color: 'var(--status-warning)', flexShrink: 0 }} />
                <div>
                  <strong>Standard Tolerance Checks</strong>
                  <p>Verify instrument error margin against Legal Metrology (General) Rules 2011 standard weight limits.</p>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className={styles.tipItem}>
                <CheckCircle2 size={18} style={{ color: 'var(--color-secondary)', flexShrink: 0 }} />
                <div>
                  <strong>Register all commercial instruments</strong>
                  <p>Ensure every commercial weight and measure is registered before applying for verification.</p>
                </div>
              </div>

              <div className={styles.tipItem}>
                <AlertTriangle size={18} style={{ color: 'var(--status-warning)', flexShrink: 0 }} />
                <div>
                  <strong>Re-verify before expiry</strong>
                  <p>Apply for re-verification at least 30 days before your certificate expires to avoid statutory penalties.</p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
