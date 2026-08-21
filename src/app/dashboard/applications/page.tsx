'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  FileText,
  Plus,
  Search,
  Filter,
  Loader2,
  Calendar,
  IndianRupee,
} from 'lucide-react';
import styles from './applications.module.css';

interface ApplicationItem {
  _id: string;
  applicationNo: string;
  type: string;
  status: string;
  feePaid: number;
  feeStatus: string;
  submittedDate: string;
  scheduledDate?: string;
  instrumentId?: {
    type: string;
    brand: string;
    model: string;
    serialNo: string;
  };
}

export default function ApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  useEffect(() => {
    fetchApplications();
  }, []);

  const fetchApplications = async () => {
    try {
      const res = await fetch('/api/applications');
      const data = await res.json();
      if (data.success) {
        setApplications(data.applications);
      }
    } catch (error) {
      console.error('Fetch applications error:', error);
    } finally {
      setLoading(false);
    }
  };

  const filtered = applications.filter((app) => {
    const matchSearch =
      app.applicationNo.toLowerCase().includes(searchQuery.toLowerCase()) ||
      app.type.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (app.instrumentId?.serialNo || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchFilter = filterStatus === 'all' || app.status === filterStatus;
    return matchSearch && matchFilter;
  });

  const getStatusBadge = (status: string) => {
    const map: Record<string, string> = {
      Submitted: 'clay-badge-info',
      UnderReview: 'clay-badge-pending',
      Scheduled: 'clay-badge-pending',
      Approved: 'clay-badge-success',
      Rejected: 'clay-badge-error',
    };
    return map[status] || 'clay-badge-charcoal';
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading applications...</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Verification Applications</h1>
          <p>{applications.length} total application{applications.length !== 1 ? 's' : ''}</p>
        </div>
        <Link href="/dashboard/applications/new" className="clay-btn clay-btn-primary">
          <Plus size={18} />
          New Application
        </Link>
      </div>

      {/* Filters */}
      <div className={styles.filters}>
        <div className={styles.searchBar}>
          <Search size={18} />
          <input
            type="text"
            placeholder="Search by app #, type, or serial..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className={styles.filterGroup}>
          <Filter size={16} />
          <select
            className="clay-input clay-select"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ padding: '10px 38px 10px 14px', fontSize: '0.85rem' }}
          >
            <option value="all">All Status</option>
            <option value="Submitted">Submitted</option>
            <option value="UnderReview">Under Review</option>
            <option value="Scheduled">Scheduled</option>
            <option value="Approved">Approved</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>
      </div>

      {/* Applications Table */}
      {filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <FileText size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>No applications found</h3>
          <p>
            {applications.length === 0
              ? 'Submit your first verification application to start.'
              : 'No applications match your search filters.'}
          </p>
          {applications.length === 0 && (
            <Link href="/dashboard/applications/new" className="clay-btn clay-btn-primary">
              <Plus size={18} />
              Submit First Application
            </Link>
          )}
        </div>
      ) : (
        <div className="clay-table-wrapper">
          <table className="clay-table">
            <thead>
              <tr>
                <th>App Number</th>
                <th>Instrument</th>
                <th>Verification Type</th>
                <th>Submitted Date</th>
                <th>Fee</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((app) => (
                <tr key={app._id}>
                  <td>
                    <strong>{app.applicationNo}</strong>
                  </td>
                  <td>
                    {app.instrumentId ? (
                      <div>
                        <div style={{ fontWeight: 600 }}>{app.instrumentId.type}</div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          {app.instrumentId.serialNo}
                        </div>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{app.type === 'initial' ? 'Initial Verification' : 'Re-verification'}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Calendar size={14} style={{ color: 'var(--text-muted)' }} />
                      {formatDate(app.submittedDate)}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2, fontWeight: 600 }}>
                      <IndianRupee size={14} />
                      {app.feePaid}
                    </div>
                  </td>
                  <td>
                    <span className={`clay-badge ${getStatusBadge(app.status)}`}>
                      {app.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
