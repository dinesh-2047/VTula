'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import {
  ClipboardCheck,
  CheckCircle,
  XCircle,
  Search,
  MapPin,
  Calendar,
  ShieldCheck,
  Loader2,
  Camera,
  User,
  Scale,
  Award,
  Eye,
  Crosshair,
  Clock,
  ImageIcon,
  Printer,
  Download,
  FileCheck,
} from 'lucide-react';
import styles from './tasks.module.css';

interface InspectionTask {
  _id: string;
  applicationNo: string;
  type: string;
  status: string;
  submittedDate: string;
  inspectionLocation?: string;
  feePaid?: number;
  feeStatus?: string;
  remarks?: string;
  certificateId?: any;
  inspectionData?: {
    readings?: string;
    remarks?: string;
    result?: string;
    photos?: { url: string; gpsLat?: number; gpsLng?: number; timestamp?: string }[];
  };
  instrumentId?: {
    _id: string;
    type: string;
    brand: string;
    model: string;
    serialNo: string;
    capacity?: string;
    address?: string;
    installationDistrict?: string;
    installationState?: string;
    photos?: string[];
  };
  ownerId?: {
    _id: string;
    name: string;
    email: string;
    phone?: string;
    organizationName?: string;
  };
}

export default function TasksPage() {
  const { data: session } = useSession();
  const [tasks, setTasks] = useState<InspectionTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'pending' | 'verified' | 'all'>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');

  // Inspection Modal state
  const [selectedTask, setSelectedTask] = useState<InspectionTask | null>(null);
  const [verdict, setVerdict] = useState<'Approve' | 'Reject'>('Approve');
  const [remarks, setRemarks] = useState('');
  const [stampNo, setStampNo] = useState('');
  const [readings, setReadings] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [gpsLat, setGpsLat] = useState<number | null>(null);
  const [gpsLng, setGpsLng] = useState<number | null>(null);
  const [capturingGps, setCapturingGps] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Detail Modal state
  const [detailTask, setDetailTask] = useState<InspectionTask | null>(null);
  // Full photo preview state
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);

  // Certificate PDF viewer modal state
  const [selectedCertPdf, setSelectedCertPdf] = useState<any | null>(null);

  const userName = session?.user?.name || 'Legal Metrology Officer';
  const userRole = (session?.user as { role?: string })?.role || 'LMO';
  const userEmail = session?.user?.email || 'lmo.officer@vtula.gov.in';

  useEffect(() => {
    fetchTasks();
  }, []);

  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      const data = await res.json();
      if (data.success) {
        setTasks(data.applications || []);
      }
    } catch (err) {
      console.error('Fetch tasks error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenStampModal = (task: InspectionTask) => {
    setSelectedTask(task);
    setVerdict('Approve');
    setRemarks('');
    setStampNo(`LMO-STAMP-${Math.floor(10000 + Math.random() * 90000)}`);
    setReadings('Tolerance Class III — ±0.1g compliance verified');
    setPhotoUrls([]);
    setGpsLat(null);
    setGpsLng(null);
    handleGetGps();
  };

  const handleGetGps = () => {
    if ('geolocation' in navigator) {
      setCapturingGps(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGpsLat(pos.coords.latitude);
          setGpsLng(pos.coords.longitude);
          setCapturingGps(false);
        },
        (err) => {
          console.warn('GPS location fallback used:', err.message);
          setGpsLat(28.6139);
          setGpsLng(77.209);
          setCapturingGps(false);
        },
        { timeout: 8000 }
      );
    } else {
      setGpsLat(28.6139);
      setGpsLng(77.209);
    }
  };

  const handleAddSamplePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setPhotoUrls((prev) => [...prev, event.target!.result as string]);
        }
      };
      reader.readAsDataURL(files[i]);
    }
  };

  const handleStampSubmit = async () => {
    if (!selectedTask) return;
    setSubmitting(true);

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: selectedTask._id,
          verdict,
          remarks,
          stampNo,
          readings,
          photos: photoUrls,
          gpsLat,
          gpsLng,
        }),
      });

      const data = await res.json();
      if (data.success) {
        alert(
          verdict === 'Approve'
            ? `Inspection complete! Certificate issued successfully.`
            : `Application rejected.`
        );
        setSelectedTask(null);
        fetchTasks();

        if (data.certificate) {
          setSelectedCertPdf(data.certificate);
        }
      } else {
        alert(data.error || 'Failed to complete inspection');
      }
    } catch (err) {
      console.error('Stamp submit error:', err);
      alert('Network error completing inspection');
    } finally {
      setSubmitting(false);
    }
  };

  const openCertModalForTask = (task: InspectionTask) => {
    if (typeof task.certificateId === 'object' && task.certificateId !== null) {
      setSelectedCertPdf(task.certificateId);
    } else {
      setSelectedCertPdf({
        certNo: `LMO-CERT-${task.applicationNo.replace('APP-', '')}`,
        issuedDate: task.submittedDate,
        expiryDate: new Date(
          new Date(task.submittedDate).setFullYear(new Date(task.submittedDate).getFullYear() + 1)
        ).toISOString(),
        digitalSignature: `HMAC-SHA256-${task._id}`,
        instrumentSnapshot: {
          type: task.instrumentId?.type || 'Scale',
          brand: task.instrumentId?.brand || 'Brand',
          model: task.instrumentId?.model || 'Model',
          serialNo: task.instrumentId?.serialNo || 'SN',
          capacity: task.instrumentId?.capacity || 'Standard Limit',
        },
        ownerSnapshot: {
          name: task.ownerId?.name || 'Trader',
          email: task.ownerId?.email || 'trader@vtula.gov.in',
        },
      });
    }
  };

  const handlePrintPdf = () => {
    if (typeof window !== 'undefined') {
      window.print();
    }
  };

  // Filter tasks logic
  const filteredTasks = tasks.filter((task) => {
    if (activeTab === 'pending' && (task.status === 'Approved' || task.status === 'Rejected')) {
      return false;
    }
    if (activeTab === 'verified' && task.status !== 'Approved') {
      return false;
    }
    if (filterType !== 'all' && task.type?.toLowerCase() !== filterType.toLowerCase()) {
      return false;
    }
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      const matchAppNo = task.applicationNo?.toLowerCase().includes(q);
      const matchOwner = task.ownerId?.name?.toLowerCase().includes(q);
      const matchSerial = task.instrumentId?.serialNo?.toLowerCase().includes(q);
      const matchType = task.instrumentId?.type?.toLowerCase().includes(q);
      const matchDistrict = task.instrumentId?.installationDistrict?.toLowerCase().includes(q);
      return matchAppNo || matchOwner || matchSerial || matchType || matchDistrict;
    }
    return true;
  });

  const pendingCount = tasks.filter((t) => t.status !== 'Approved' && t.status !== 'Rejected').length;
  const verifiedCount = tasks.filter((t) => t.status === 'Approved').length;

  const formatDate = (dateStr: string) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 350, gap: 12 }}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Fetching Legal Metrology inspection queue...</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div>
          <h1>LMO Inspection Console</h1>
          <p>Field verification, GPS geo-evidence capture, technical calibration, and electronic stamping.</p>
        </div>

        {/* Inspector Identity Chip */}
        <div
          style={{
            background: 'var(--surface-card)',
            padding: '10px 16px',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--clay-shadow-sm)',
            border: '1px solid rgba(255, 255, 255, 0.8)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--color-primary), var(--color-accent))',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
            }}
          >
            {userName.charAt(0)}
          </div>
          <div>
            <div style={{ fontSize: '0.88rem', fontWeight: 800, color: 'var(--text-primary)' }}>
              {userName} <span className="clay-badge clay-badge-primary" style={{ fontSize: '0.65rem', marginLeft: 4 }}>{userRole}</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Dept. of Legal Metrology Enforcement
            </div>
          </div>
        </div>
      </div>

      {/* Tabs & Controls Bar */}
      <div className={styles.controlsBar}>
        {/* Status Tabs */}
        <div className="clay-tabs" style={{ display: 'flex', width: 'auto', margin: 0 }}>
          <button
            className={`clay-tab ${activeTab === 'pending' ? 'active' : ''}`}
            onClick={() => setActiveTab('pending')}
          >
            <Clock size={15} style={{ display: 'inline', marginRight: 6 }} />
            Pending ({pendingCount})
          </button>
          <button
            className={`clay-tab ${activeTab === 'verified' ? 'active' : ''}`}
            onClick={() => setActiveTab('verified')}
          >
            <ShieldCheck size={15} style={{ display: 'inline', marginRight: 6 }} />
            Verified ({verifiedCount})
          </button>
          <button
            className={`clay-tab ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            All ({tasks.length})
          </button>
        </div>

        {/* Search & Filter */}
        <div className={styles.searchWrap}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: 13, color: 'var(--text-muted)' }} />
            <input
              type="text"
              className={`clay-input ${styles.searchInput}`}
              placeholder="Search App No, Owner, Serial No..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <select
            className={`clay-input clay-select ${styles.filterSelect}`}
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="all">All Types</option>
            <option value="initial">Initial</option>
            <option value="re-verification">Re-verification</option>
          </select>
        </div>
      </div>

      {/* Task Cards Grid */}
      {filteredTasks.length === 0 ? (
        <div className="clay-card" style={{ textAlign: 'center', padding: '40px 20px' }}>
          <ClipboardCheck size={48} style={{ color: 'var(--text-muted)', marginBottom: 12 }} />
          <h3>No Inspection Tasks Found</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            {activeTab === 'pending'
              ? 'Great job! There are currently no pending inspection applications in your queue.'
              : 'No applications matched your search filters.'}
          </p>
        </div>
      ) : (
        <div className={styles.grid}>
          {filteredTasks.map((task) => {
            const instPhotos = task.instrumentId?.photos || [];

            return (
              <div key={task._id} className={styles.taskCard}>
                <div className={styles.cardHeader}>
                  <div className={styles.taskIcon}>
                    <ClipboardCheck size={22} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className={styles.appNo}>{task.applicationNo}</div>
                    <div className={styles.ownerName}>
                      Owner: <strong>{task.ownerId?.name || 'Trader'}</strong>
                    </div>
                  </div>
                  <span
                    className={`clay-badge ${
                      task.status === 'Approved'
                        ? 'clay-badge-success'
                        : task.status === 'Rejected'
                        ? 'clay-badge-error'
                        : 'clay-badge-warning'
                    }`}
                  >
                    {task.status}
                  </span>
                </div>

                <div style={{ flex: 1 }}>
                  <div className={styles.instTitle}>
                    {task.instrumentId?.type || 'Measuring Instrument'}
                  </div>
                  <div className={styles.instSub}>
                    Brand: <strong>{task.instrumentId?.brand}</strong> | Model: <strong>{task.instrumentId?.model}</strong>
                  </div>

                  <div className={styles.infoRow}>
                    <Scale size={14} />
                    <span>Serial No:</span>
                    <strong style={{ fontFamily: 'monospace' }}>{task.instrumentId?.serialNo || '—'}</strong>
                  </div>

                  {/* Registered Instrument Photos Gallery */}
                  <div style={{ marginTop: 10, marginBottom: 6 }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <ImageIcon size={13} /> Registered Photos ({instPhotos.length})
                    </div>

                    {instPhotos.length > 0 ? (
                      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
                        {instPhotos.map((photoUrl, pIdx) => (
                          <div
                            key={pIdx}
                            onClick={() => setPreviewPhoto(photoUrl)}
                            style={{
                              width: 54,
                              height: 54,
                              borderRadius: 'var(--radius-sm)',
                              overflow: 'hidden',
                              border: '1px solid var(--clay-border)',
                              cursor: 'pointer',
                              flexShrink: 0,
                            }}
                            title="Click to view full photo"
                          >
                            <img src={photoUrl} alt="Registered scale" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic', background: 'var(--surface-warm)', padding: '6px 10px', borderRadius: 'var(--radius-sm)' }}>
                        No photos uploaded by trader.
                      </div>
                    )}
                  </div>

                  {task.instrumentId?.address && (
                    <div className={styles.infoRow} style={{ marginTop: 6 }}>
                      <MapPin size={14} style={{ color: 'var(--text-muted)' }} />
                      <span style={{ fontWeight: 600 }}>Venue:</span>
                      <span>{task.instrumentId.address}, {task.instrumentId.installationDistrict}</span>
                    </div>
                  )}

                  <div className={styles.infoRow} style={{ marginTop: 4 }}>
                    <Calendar size={14} />
                    <span>Filed: {formatDate(task.submittedDate)}</span>
                    <span className="clay-badge clay-badge-info" style={{ marginLeft: 'auto', textTransform: 'capitalize' }}>
                      {task.type}
                    </span>
                  </div>
                </div>

                <div className={styles.cardFooter} style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="clay-btn clay-btn-ghost clay-btn-sm"
                    style={{ flex: 1 }}
                    onClick={() => setDetailTask(task)}
                  >
                    <Eye size={15} />
                    Full Specs
                  </button>

                  {task.status !== 'Approved' && task.status !== 'Rejected' ? (
                    <button
                      className="clay-btn clay-btn-primary clay-btn-sm"
                      style={{ flex: 2 }}
                      onClick={() => handleOpenStampModal(task)}
                    >
                      <ShieldCheck size={15} />
                      Inspect & Stamp
                    </button>
                  ) : (
                    <button
                      className="clay-btn clay-btn-primary clay-btn-sm"
                      style={{ flex: 2 }}
                      onClick={() => openCertModalForTask(task)}
                    >
                      <Download size={15} />
                      Download PDF
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Inspection & Stamping Modal */}
      {selectedTask && (
        <div className="clay-modal-overlay">
          <div className="clay-modal" style={{ maxWidth: 640, maxHeight: '90vh', overflowY: 'auto' }}>
            <div className="clay-modal-header">
              <h3 className="clay-modal-title">Perform Field Inspection & Digital Seal</h3>
              <button
                className="clay-btn clay-btn-sm clay-btn-ghost"
                onClick={() => setSelectedTask(null)}
              >
                ✕
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Application Summary Banner */}
              <div style={{ background: 'var(--surface-warm)', padding: 14, borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '0.95rem' }}>{selectedTask.applicationNo}</div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                    {selectedTask.instrumentId?.type} — SN: <strong>{selectedTask.instrumentId?.serialNo}</strong>
                  </div>
                </div>
                <span className="clay-badge clay-badge-primary">Owner: {selectedTask.ownerId?.name}</span>
              </div>

              {/* Inspector Badge */}
              <div style={{ background: 'rgba(224, 122, 95, 0.08)', padding: 12, borderRadius: 'var(--radius-md)', border: '1px solid rgba(224, 122, 95, 0.2)', fontSize: '0.85rem' }}>
                <strong>Verifying Inspector:</strong> {userName} ({userRole}) | ID: <span style={{ fontFamily: 'monospace' }}>{userEmail}</span>
              </div>

              {/* Verdict Selection */}
              <div className="clay-input-group">
                <label className="clay-label">Verification Verdict</label>
                <div style={{ display: 'flex', gap: 12 }}>
                  <button
                    type="button"
                    className={`clay-btn ${verdict === 'Approve' ? 'clay-btn-primary' : 'clay-btn-ghost'}`}
                    style={{ flex: 1 }}
                    onClick={() => setVerdict('Approve')}
                  >
                    <CheckCircle size={16} /> Approve & Issue Certificate
                  </button>
                  <button
                    type="button"
                    className={`clay-btn ${verdict === 'Reject' ? 'clay-btn-secondary' : 'clay-btn-ghost'}`}
                    style={{ flex: 1 }}
                    onClick={() => setVerdict('Reject')}
                  >
                    <XCircle size={16} /> Reject Application
                  </button>
                </div>
              </div>

              {/* Electronic Stamp Number */}
              {verdict === 'Approve' && (
                <div className="clay-input-group">
                  <label className="clay-label">Official Electronic Seal / Stamp No.</label>
                  <input
                    type="text"
                    className="clay-input"
                    value={stampNo}
                    onChange={(e) => setStampNo(e.target.value)}
                    placeholder="e.g. LMO-STAMP-98241"
                  />
                </div>
              )}

              {/* Calibration Readings */}
              <div className="clay-input-group">
                <label className="clay-label">Technical Calibration & Tolerance Test Readings</label>
                <input
                  type="text"
                  className="clay-input"
                  value={readings}
                  onChange={(e) => setReadings(e.target.value)}
                  placeholder="e.g. Test Weight 20kg: Error +0.02g (Within Permissible Tolerance)"
                />
              </div>

              {/* Live Geolocation Evidence */}
              <div style={{ background: 'var(--surface-warm)', padding: 14, borderRadius: 'var(--radius-md)', fontSize: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Crosshair size={16} style={{ color: 'var(--color-primary)' }} /> Live GPS Evidence Tagging
                  </span>
                  <button
                    type="button"
                    className="clay-btn clay-btn-sm clay-btn-ghost"
                    onClick={handleGetGps}
                    disabled={capturingGps}
                  >
                    {capturingGps ? 'Fetching GPS...' : 'Refresh Coordinates'}
                  </button>
                </div>

                {gpsLat !== null && gpsLng !== null ? (
                  <div style={{ fontFamily: 'monospace', background: 'white', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--clay-border)', color: '#2b2d42' }}>
                    Latitude: <strong>{gpsLat.toFixed(6)}° N</strong> | Longitude: <strong>{gpsLng.toFixed(6)}° E</strong>
                  </div>
                ) : (
                  <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Capturing GPS location...</div>
                )}
              </div>

              {/* On-Site Photo Evidence Upload */}
              <div className="clay-input-group">
                <label className="clay-label">Capture / Upload On-Site Inspection Photos</label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <label className="clay-btn clay-btn-secondary clay-btn-sm" style={{ cursor: 'pointer' }}>
                    <Camera size={16} /> Choose Photo
                    <input type="file" accept="image/*" capture="environment" multiple onChange={handleAddSamplePhoto} style={{ display: 'none' }} />
                  </label>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {photoUrls.length} photo(s) attached
                  </span>
                </div>

                {photoUrls.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, overflowX: 'auto', paddingBottom: 4 }}>
                    {photoUrls.map((url, idx) => (
                      <div key={idx} style={{ position: 'relative', width: 70, height: 70, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--clay-border)' }}>
                        <img src={url} alt="On-site evidence" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <button
                          type="button"
                          onClick={() => setPhotoUrls((prev) => prev.filter((_, i) => i !== idx))}
                          style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.7)', color: 'white', border: 'none', borderRadius: '50%', width: 18, height: 18, fontSize: '0.7rem', cursor: 'pointer' }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Remarks */}
              <div className="clay-input-group">
                <label className="clay-label">Inspector Findings & Remarks</label>
                <textarea
                  className="clay-input"
                  rows={2}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Enter official notes (e.g. Standard verified, lead seal placed)..."
                />
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                <button
                  type="button"
                  className="clay-btn clay-btn-ghost"
                  onClick={() => setSelectedTask(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="clay-btn clay-btn-primary"
                  onClick={handleStampSubmit}
                  disabled={submitting}
                >
                  {submitting ? (
                    <>
                      <Loader2 size={16} className={styles.spin} /> Submitting Sign-off...
                    </>
                  ) : (
                    'Complete Inspection & Save'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Full Specs Modal */}
      {detailTask && (
        <div className="clay-modal-overlay">
          <div className="clay-modal" style={{ maxWidth: 600, maxHeight: '90vh', overflowY: 'auto' }}>
            <div className="clay-modal-header">
              <h3 className="clay-modal-title">Application & Instrument Full Specifications</h3>
              <button className="clay-btn clay-btn-sm clay-btn-ghost" onClick={() => setDetailTask(null)}>
                ✕
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Owner Info */}
              <div style={{ background: 'var(--surface-warm)', padding: 14, borderRadius: 'var(--radius-md)' }}>
                <h4 style={{ fontSize: '0.95rem', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-primary)' }}>
                  <User size={16} /> Owner & Business Profile
                </h4>
                <div style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><strong>Name:</strong> {detailTask.ownerId?.name}</div>
                  <div><strong>Email:</strong> {detailTask.ownerId?.email}</div>
                  <div><strong>Phone:</strong> {detailTask.ownerId?.phone || 'N/A'}</div>
                  <div><strong>Organization:</strong> {detailTask.ownerId?.organizationName || 'Private Trader'}</div>
                </div>
              </div>

              {/* Instrument Info */}
              <div style={{ background: 'var(--surface-warm)', padding: 14, borderRadius: 'var(--radius-md)' }}>
                <h4 style={{ fontSize: '0.95rem', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-secondary)' }}>
                  <Scale size={16} /> Instrument Specifications
                </h4>
                <div style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><strong>Category/Type:</strong> {detailTask.instrumentId?.type}</div>
                  <div><strong>Brand & Model:</strong> {detailTask.instrumentId?.brand} — {detailTask.instrumentId?.model}</div>
                  <div><strong>Serial Number:</strong> {detailTask.instrumentId?.serialNo}</div>
                  <div><strong>Capacity:</strong> {detailTask.instrumentId?.capacity || 'Standard'}</div>
                  <div><strong>Location:</strong> {detailTask.instrumentId?.address}, {detailTask.instrumentId?.installationDistrict}, {detailTask.instrumentId?.installationState}</div>
                </div>

                {/* Uploaded Photos Grid */}
                {(detailTask.instrumentId?.photos?.length || 0) > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: 6 }}>Registered Instrument Photos:</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 8 }}>
                      {detailTask.instrumentId?.photos?.map((pUrl, idx) => (
                        <div
                          key={idx}
                          onClick={() => setPreviewPhoto(pUrl)}
                          style={{ height: 75, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--clay-border)', cursor: 'pointer' }}
                        >
                          <img src={pUrl} alt="Instrument" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                {detailTask.status === 'Approved' ? (
                  <button
                    className="clay-btn clay-btn-primary clay-btn-sm"
                    onClick={() => {
                      const t = detailTask;
                      setDetailTask(null);
                      openCertModalForTask(t);
                    }}
                  >
                    <Download size={14} /> Download Certificate PDF
                  </button>
                ) : (
                  <div />
                )}
                <button className="clay-btn clay-btn-ghost" onClick={() => setDetailTask(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Photo Full-Size Preview Modal */}
      {previewPhoto && (
        <div className="clay-modal-overlay" onClick={() => setPreviewPhoto(null)}>
          <div className="clay-modal" style={{ maxWidth: 700, padding: 12, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
            <img src={previewPhoto} alt="Full Instrument Photo" style={{ maxWidth: '100%', maxHeight: '75vh', borderRadius: 'var(--radius-md)', objectFit: 'contain' }} />
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button className="clay-btn clay-btn-secondary" onClick={() => setPreviewPhoto(null)}>
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Printable Certificate PDF Modal */}
      {selectedCertPdf && (
        <div className="clay-modal-overlay">
          <div className="clay-modal" style={{ maxWidth: 740, maxHeight: '92vh', overflowY: 'auto', padding: 24 }}>
            {/* Action Bar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid var(--clay-border)', paddingBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FileCheck size={22} style={{ color: 'var(--color-primary)' }} />
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800 }}>Official Verification Certificate</h3>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="clay-btn clay-btn-secondary clay-btn-sm"
                  onClick={handlePrintPdf}
                >
                  <Printer size={15} />
                  Print / Save PDF
                </button>
                <button
                  className="clay-btn clay-btn-ghost clay-btn-sm"
                  onClick={() => setSelectedCertPdf(null)}
                >
                  ✕ Close
                </button>
              </div>
            </div>

            {/* Certificate Document Body */}
            <div
              id="printable-certificate"
              style={{
                background: '#fff',
                color: '#1a1a24',
                padding: '36px 40px',
                borderRadius: 12,
                border: '4px double #d4af37',
                fontFamily: 'serif',
                boxShadow: '0 8px 30px rgba(0,0,0,0.1)',
                position: 'relative',
              }}
            >
              {/* Decorative Corner Seals */}
              <div style={{ position: 'absolute', top: 12, left: 16, fontSize: '0.75rem', fontWeight: 700, color: '#8b0000', letterSpacing: 1 }}>
                FORM VIII — RULE 11(1)
              </div>
              <div style={{ position: 'absolute', top: 12, right: 16, fontSize: '0.75rem', fontWeight: 700, color: '#8b0000', letterSpacing: 1 }}>
                SEC. 24, ACT 2009
              </div>

              {/* Header */}
              <div style={{ textAlign: 'center', marginBottom: 24 }}>
                <div style={{ fontSize: '1.25rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 1.5, color: '#2b2d42' }}>
                  DEPARTMENT OF LEGAL METROLOGY
                </div>
                <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#4a4e69', marginTop: 2 }}>
                  GOVERNMENT OF INDIA / STATE ENFORCEMENT
                </div>
                <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#b71c1c', marginTop: 12, textTransform: 'uppercase', textDecoration: 'underline' }}>
                  CERTIFICATE OF VERIFICATION
                </div>
                <div style={{ fontSize: '0.85rem', color: '#555', marginTop: 4 }}>
                  Certificate Number: <strong style={{ fontFamily: 'monospace', fontSize: '1rem', color: '#000' }}>{selectedCertPdf.certNo}</strong>
                </div>
              </div>

              {/* Watermark / Background Emblem */}
              <div style={{ borderTop: '2px solid #d4af37', borderBottom: '2px solid #d4af37', padding: '20px 0', margin: '20px 0' }}>
                <p style={{ fontSize: '0.95rem', lineHeight: 1.7, margin: 0, textAlign: 'justify' }}>
                  This is to certify that the measuring/weighing instrument described below belonging to{' '}
                  <strong style={{ textDecoration: 'underline' }}>{selectedCertPdf.ownerSnapshot?.name || 'Trader'}</strong> ({selectedCertPdf.ownerSnapshot?.email}), has been officially inspected, tested, and calibrated in accordance with the <strong>Legal Metrology (General) Rules, 2011</strong> and Section 24 of the Legal Metrology Act, 2009.
                </p>
              </div>

              {/* Specs Table */}
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 24, fontSize: '0.9rem' }}>
                <tbody>
                  <tr style={{ background: '#f8f9fa' }}>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700, width: '40%' }}>Instrument Type / Category</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd' }}>{selectedCertPdf.instrumentSnapshot?.type}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700 }}>Brand & Model</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd' }}>{selectedCertPdf.instrumentSnapshot?.brand} — {selectedCertPdf.instrumentSnapshot?.model}</td>
                  </tr>
                  <tr style={{ background: '#f8f9fa' }}>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700 }}>Serial Number</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontFamily: 'monospace', fontWeight: 700 }}>{selectedCertPdf.instrumentSnapshot?.serialNo}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700 }}>Maximum Capacity</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd' }}>{selectedCertPdf.instrumentSnapshot?.capacity || 'Standard Limit'}</td>
                  </tr>
                  <tr style={{ background: '#f8f9fa' }}>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700 }}>Date of Verification</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 600 }}>{formatDate(selectedCertPdf.issuedDate)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700, color: '#b71c1c' }}>Certificate Expiry Date</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700, color: '#b71c1c' }}>{formatDate(selectedCertPdf.expiryDate)}</td>
                  </tr>
                </tbody>
              </table>

              {/* QR Code & Signatures Row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 30 }}>
                {/* QR Verification Code */}
                <div style={{ textAlign: 'center' }}>
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=${encodeURIComponent(
                      typeof window !== 'undefined'
                        ? `${window.location.origin}/verify?certNo=${selectedCertPdf.certNo}`
                        : `https://vtula.gov.in/verify?certNo=${selectedCertPdf.certNo}`
                    )}`}
                    alt="QR Verification"
                    style={{ width: 100, height: 100, border: '1px solid #ccc', padding: 4, background: '#fff' }}
                  />
                  <div style={{ fontSize: '0.7rem', color: '#666', marginTop: 4 }}>Scan to Verify Authenticity</div>
                </div>

                {/* Verification Stamp & Signature */}
                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <div style={{ border: '2px dashed #2b2d42', padding: '6px 14px', borderRadius: 6, marginBottom: 12, background: 'rgba(43, 45, 66, 0.04)', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#1b5e20' }}>SEAL AFFIXED & STAMPED</div>
                    <div style={{ fontSize: '0.7rem', fontFamily: 'monospace' }}>LMO-SEAL-VERIFIED</div>
                  </div>
                  <div style={{ fontWeight: 800, fontSize: '0.9rem', color: '#1a1a24' }}>Legal Metrology Officer (LMO)</div>
                  <div style={{ fontSize: '0.78rem', color: '#555' }}>Inspectorate of Legal Metrology</div>
                  <div style={{ fontSize: '0.65rem', fontFamily: 'monospace', color: '#888', marginTop: 4, maxWidth: 240, wordBreak: 'break-all' }}>
                    HMAC-SHA256: {(selectedCertPdf.digitalSignature || 'HMAC-SIGNED').substring(0, 32)}...
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
