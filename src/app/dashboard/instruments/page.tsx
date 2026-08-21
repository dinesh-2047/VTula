'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Plus,
  Search,
  Scale,
  MapPin,
  Calendar,
  Loader2,
  Filter,
  MoreHorizontal,
  Eye,
  Trash2,
  FileCheck,
  X,
  Camera,
} from 'lucide-react';
import styles from './instruments.module.css';

interface InstrumentItem {
  _id: string;
  type: string;
  brand: string;
  model: string;
  serialNo: string;
  capacity: string;
  accuracyClass?: string;
  installationState: string;
  installationDistrict: string;
  address?: string;
  status: string;
  photos?: string[];
  gpsCoordinates?: { lat: number; lng: number };
  lastVerifiedDate?: string;
  nextVerificationDue?: string;
  createdAt: string;
}

export default function InstrumentsPage() {
  const [instruments, setInstruments] = useState<InstrumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  // Interactive Menu & Modal States
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [selectedInst, setSelectedInst] = useState<InstrumentItem | null>(null);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchInstruments();
  }, []);

  const fetchInstruments = async () => {
    try {
      const res = await fetch('/api/instruments');
      const data = await res.json();
      if (data.success) {
        setInstruments(data.instruments);
      }
    } catch (error) {
      console.error('Fetch error:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteInstrument = async (id: string) => {
    if (!confirm('Are you sure you want to delete this instrument?')) return;
    setDeletingId(id);

    try {
      const res = await fetch(`/api/instruments?id=${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setInstruments((prev) => prev.filter((i) => i._id !== id));
        setActiveMenuId(null);
      } else {
        alert(data.error || 'Failed to delete instrument');
      }
    } catch (err) {
      console.error(err);
      alert('Failed to delete instrument');
    } finally {
      setDeletingId(null);
    }
  };

  const filteredInstruments = instruments.filter((inst) => {
    const matchSearch =
      inst.type.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inst.serialNo.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inst.brand.toLowerCase().includes(searchQuery.toLowerCase());
    const matchFilter = filterStatus === 'all' || inst.status === filterStatus;
    return matchSearch && matchFilter;
  });

  const getStatusBadge = (status: string) => {
    const map: Record<string, string> = {
      Active: 'clay-badge-info',
      PendingVerification: 'clay-badge-pending',
      Verified: 'clay-badge-success',
      Expired: 'clay-badge-warning',
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
        <p>Loading instruments...</p>
      </div>
    );
  }

  return (
    <div className={styles.page} onClick={() => setActiveMenuId(null)}>
      <div className={styles.pageHeader}>
        <div>
          <h1>My Instruments</h1>
          <p>{instruments.length} registered instrument{instruments.length !== 1 ? 's' : ''}</p>
        </div>
        <Link href="/dashboard/instruments/new" className="clay-btn clay-btn-primary">
          <Plus size={18} />
          Add Instrument
        </Link>
      </div>

      {/* Filters */}
      <div className={styles.filters}>
        <div className={styles.searchBar}>
          <Search size={18} />
          <input
            type="text"
            placeholder="Search by type, serial, or brand..."
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
            <option value="Active">Active</option>
            <option value="PendingVerification">Pending</option>
            <option value="Verified">Verified</option>
            <option value="Expired">Expired</option>
          </select>
        </div>
      </div>

      {/* Instruments Grid */}
      {filteredInstruments.length === 0 ? (
        <div className={styles.emptyState}>
          <Scale size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>No instruments found</h3>
          <p>
            {instruments.length === 0
              ? 'Start by adding your first instrument to the registry.'
              : 'No instruments match your search or filter.'}
          </p>
          {instruments.length === 0 && (
            <Link href="/dashboard/instruments/new" className="clay-btn clay-btn-primary">
              <Plus size={18} />
              Add First Instrument
            </Link>
          )}
        </div>
      ) : (
        <div className={styles.grid}>
          {filteredInstruments.map((inst) => (
            <div key={inst._id} className={styles.card}>
              {/* Photo Evidence Gallery Banner */}
              {inst.photos && inst.photos.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    marginBottom: 14,
                    overflowX: 'auto',
                    paddingBottom: 4,
                  }}
                >
                  {inst.photos.map((photo, pIdx) => (
                    <div
                      key={pIdx}
                      onClick={() => setPreviewPhoto(photo)}
                      style={{
                        position: 'relative',
                        width: 56,
                        height: 56,
                        borderRadius: 'var(--radius-md)',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        flexShrink: 0,
                        border: '2px solid white',
                        boxShadow: 'var(--clay-shadow-sm)',
                      }}
                      title="Click to view full photo"
                    >
                      <img
                        src={photo}
                        alt={`Photo ${pIdx + 1}`}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.cardTop}>
                <div className={styles.cardIcon}>
                  <Scale size={22} />
                </div>
                <span className={`clay-badge ${getStatusBadge(inst.status)}`}>
                  {inst.status.replace(/([A-Z])/g, ' $1').trim()}
                </span>

                {/* Interactive Three Dots Menu Button */}
                <div style={{ position: 'relative', marginLeft: 'auto' }}>
                  <button
                    className={styles.moreBtn}
                    style={{ margin: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveMenuId(activeMenuId === inst._id ? null : inst._id);
                    }}
                    title="Options"
                  >
                    <MoreHorizontal size={18} />
                  </button>

                  {/* Dropdown Menu */}
                  {activeMenuId === inst._id && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 36,
                        right: 0,
                        zIndex: 20,
                        background: 'var(--surface-card)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: 'var(--clay-shadow-md)',
                        border: '1px solid rgba(61, 64, 91, 0.1)',
                        minWidth: 190,
                        overflow: 'hidden',
                        padding: 6,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: '0.85rem',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          borderRadius: 'var(--radius-sm)',
                          color: 'var(--text-primary)',
                        }}
                        onClick={() => {
                          setSelectedInst(inst);
                          setActiveMenuId(null);
                        }}
                      >
                        <Eye size={15} style={{ color: 'var(--color-secondary)' }} />
                        View Specs & Photos
                      </button>

                      <Link
                        href={`/dashboard/applications/new?instrumentId=${inst._id}`}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: '0.85rem',
                          color: 'var(--color-primary)',
                          textDecoration: 'none',
                          borderRadius: 'var(--radius-sm)',
                        }}
                        onClick={() => setActiveMenuId(null)}
                      >
                        <FileCheck size={15} />
                        Apply for Verification
                      </Link>

                      <button
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: '0.85rem',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--status-error)',
                          borderRadius: 'var(--radius-sm)',
                        }}
                        onClick={() => handleDeleteInstrument(inst._id)}
                        disabled={deletingId === inst._id}
                      >
                        {deletingId === inst._id ? <Loader2 size={15} className={styles.spin} /> : <Trash2 size={15} />}
                        Delete Instrument
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <h4 style={{ fontSize: '1.2rem', marginBottom: '8px' }}>{inst.type}</h4>
              <p className={styles.cardModel} style={{ marginBottom: '20px' }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Make/Model:</span> {inst.brand} — {inst.model}
              </p>

              <div className={styles.cardDetails} style={{ background: 'var(--surface-warm)', padding: '12px', borderRadius: 'var(--radius-md)' }}>
                <div className={styles.detailRow}>
                  <span style={{ minWidth: '80px' }}>Serial No.</span>
                  <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{inst.serialNo}</span>
                </div>
                <div className={styles.detailRow}>
                  <span style={{ minWidth: '80px' }}>Capacity</span>
                  <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{inst.capacity}</span>
                </div>
                <div className={styles.detailRow} style={{ marginTop: '4px' }}>
                  <MapPin size={14} style={{ color: 'var(--text-muted)' }} />
                  <span style={{ minWidth: 'auto', marginLeft: '-4px' }}>Location:</span>
                  <span style={{ fontWeight: 500, color: 'var(--text-primary)', flex: 1 }}>{inst.installationDistrict}, {inst.installationState}</span>
                </div>
                {inst.nextVerificationDue && (
                  <div className={styles.detailRow} style={{ marginTop: '4px' }}>
                    <Calendar size={14} style={{ color: 'var(--status-warning)' }} />
                    <span style={{ minWidth: 'auto', marginLeft: '-4px', color: 'var(--status-warning)' }}>Due Date:</span>
                    <span style={{ fontWeight: 600, color: 'var(--status-warning)', flex: 1 }}>{formatDate(inst.nextVerificationDue)}</span>
                  </div>
                )}
              </div>

              <div className={styles.cardActions} style={{ borderTop: 'none', paddingTop: 0 }}>
                <Link
                  href={`/dashboard/applications/new?instrumentId=${inst._id}`}
                  className="clay-btn clay-btn-outline"
                  style={{ width: '100%', justifyContent: 'center', fontWeight: 600 }}
                >
                  Apply for Verification
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Full Instrument Specs & Photos Modal */}
      {selectedInst && (
        <div className="clay-modal-overlay">
          <div className="clay-modal" style={{ maxWidth: 540 }}>
            <div className="clay-modal-header">
              <h3 className="clay-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Scale size={20} style={{ color: 'var(--color-primary)' }} />
                {selectedInst.type} Specifications
              </h3>
              <button className="clay-btn clay-btn-sm clay-btn-ghost" onClick={() => setSelectedInst(null)}>
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: '16px 0', fontSize: '0.9rem', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed rgba(61,64,91,0.1)', paddingBottom: 8 }}>
                <span style={{ color: 'var(--text-muted)' }}>Make / Model</span>
                <strong>{selectedInst.brand} — {selectedInst.model}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed rgba(61,64,91,0.1)', paddingBottom: 8 }}>
                <span style={{ color: 'var(--text-muted)' }}>Serial Number</span>
                <strong>{selectedInst.serialNo}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed rgba(61,64,91,0.1)', paddingBottom: 8 }}>
                <span style={{ color: 'var(--text-muted)' }}>Capacity / Class</span>
                <strong>{selectedInst.capacity} {selectedInst.accuracyClass ? `(${selectedInst.accuracyClass})` : ''}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed rgba(61,64,91,0.1)', paddingBottom: 8 }}>
                <span style={{ color: 'var(--text-muted)' }}>Installation Location</span>
                <strong>{selectedInst.address || `${selectedInst.installationDistrict}, ${selectedInst.installationState}`}</strong>
              </div>
              {selectedInst.gpsCoordinates?.lat && (
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed rgba(61,64,91,0.1)', paddingBottom: 8 }}>
                  <span style={{ color: 'var(--text-muted)' }}>GPS Coordinates</span>
                  <strong>{selectedInst.gpsCoordinates.lat}, {selectedInst.gpsCoordinates.lng}</strong>
                </div>
              )}

              {/* Photos Gallery */}
              <div style={{ marginTop: 8 }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <Camera size={16} /> Uploaded Photo Evidence ({selectedInst.photos?.length || 0})
                </span>
                {selectedInst.photos && selectedInst.photos.length > 0 ? (
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {selectedInst.photos.map((p, idx) => (
                      <img
                        key={idx}
                        src={p}
                        alt={`Evidence ${idx + 1}`}
                        onClick={() => setPreviewPhoto(p)}
                        style={{
                          width: 100,
                          height: 100,
                          borderRadius: 'var(--radius-md)',
                          objectFit: 'cover',
                          cursor: 'pointer',
                          boxShadow: 'var(--clay-shadow-sm)',
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No photos uploaded for this instrument.
                  </p>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="clay-btn clay-btn-primary" onClick={() => setSelectedInst(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full Photo Modal */}
      {previewPhoto && (
        <div className="clay-modal-overlay" onClick={() => setPreviewPhoto(null)}>
          <div
            className="clay-modal"
            style={{ maxWidth: 640, textAlign: 'center', padding: 16 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h4 style={{ margin: 0 }}>Instrument Photo Evidence</h4>
              <button className="clay-btn clay-btn-sm clay-btn-ghost" onClick={() => setPreviewPhoto(null)}>
                <X size={18} />
              </button>
            </div>
            <img
              src={previewPhoto}
              alt="Full Instrument Evidence"
              style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: 'var(--radius-md)' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
