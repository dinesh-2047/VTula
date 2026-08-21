'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  Award,
  Search,
  Download,
  ExternalLink,
  ShieldCheck,
  Loader2,
  CheckCircle,
  Printer,
  QrCode,
  Building2,
  FileCheck,
} from 'lucide-react';
import styles from './certificates.module.css';

interface CertificateItem {
  _id: string;
  certNo: string;
  issuedDate: string;
  expiryDate: string;
  status: string;
  digitalSignature: string;
  dataHash: string;
  issuedByRole?: string;
  instrumentSnapshot: {
    type: string;
    brand: string;
    model: string;
    serialNo: string;
    capacity?: string;
  };
  ownerSnapshot: {
    name: string;
    email: string;
    phone?: string;
  };
}

export default function CertificatesPage() {
  const [certificates, setCertificates] = useState<CertificateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCert, setSelectedCert] = useState<CertificateItem | null>(null);

  const certPrintRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCertificates();
  }, []);

  const fetchCertificates = async () => {
    try {
      const res = await fetch('/api/certificates');
      const data = await res.json();
      if (data.success) {
        setCertificates(data.certificates || []);
      }
    } catch (err) {
      console.error('Cert fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handlePrintPdf = () => {
    if (typeof window !== 'undefined') {
      window.print();
    }
  };

  const filtered = certificates.filter(
    (c) =>
      c.certNo?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.instrumentSnapshot?.type?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.instrumentSnapshot?.serialNo?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.ownerSnapshot?.name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading legal metrology certificates...</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Metrology Verification Certificates</h1>
          <p>Official digital certificates signed with tamper-proof HMAC verification and dynamic QR codes.</p>
        </div>
      </div>

      {/* Search */}
      <div className={styles.filters}>
        <div className={styles.searchBar}>
          <Search size={18} />
          <input
            type="text"
            placeholder="Search by certificate #, owner, instrument, or serial..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Grid of Certificates */}
      {filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <Award size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>No Active Certificates Found</h3>
          <p>
            {certificates.length === 0
              ? 'Certificates are issued automatically once an LMO completes inspection of your application.'
              : 'No certificates matched your search criteria.'}
          </p>
          <Link href="/dashboard/applications/new" className="clay-btn clay-btn-primary">
            Apply for Verification
          </Link>
        </div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((cert) => {
            const qrUrl = typeof window !== 'undefined'
              ? `${window.location.origin}/verify?certNo=${cert.certNo}`
              : `https://vtula.gov.in/verify?certNo=${cert.certNo}`;

            return (
              <div key={cert._id} className={styles.certCard}>
                <div className={styles.certTop}>
                  <div className={styles.certIcon}>
                    <ShieldCheck size={26} />
                  </div>
                  <div>
                    <span className={styles.certBadge}>
                      <CheckCircle size={12} /> {cert.status}
                    </span>
                    <div className={styles.certNo}>{cert.certNo}</div>
                  </div>
                </div>

                <div className={styles.certBody}>
                  <h4>{cert.instrumentSnapshot?.type || 'Instrument'}</h4>
                  <p className={styles.certDetailText}>
                    {cert.instrumentSnapshot?.brand} {cert.instrumentSnapshot?.model}
                  </p>

                  {/* QR Code Container */}
                  <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(qrUrl)}`}
                      alt={`QR Code for ${cert.certNo}`}
                      style={{
                        borderRadius: 12,
                        padding: 8,
                        background: 'white',
                        boxShadow: 'var(--clay-shadow-sm)',
                        width: 120,
                        height: 120,
                        cursor: 'pointer',
                      }}
                      onClick={() => setSelectedCert(cert)}
                    />
                  </div>

                  <div className={styles.certRows}>
                    <div className={styles.certRow}>
                      <span>Trader / Owner</span>
                      <strong>{cert.ownerSnapshot?.name || 'Trader'}</strong>
                    </div>
                    <div className={styles.certRow}>
                      <span>Serial No.</span>
                      <strong>{cert.instrumentSnapshot?.serialNo || '—'}</strong>
                    </div>
                    <div className={styles.certRow}>
                      <span>Issued Date</span>
                      <span>{formatDate(cert.issuedDate)}</span>
                    </div>
                    <div className={styles.certRow}>
                      <span>Valid Until</span>
                      <span style={{ color: 'var(--color-secondary-dark)', fontWeight: 600 }}>
                        {formatDate(cert.expiryDate)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className={styles.certFooter}>
                  <Link
                    href={`/verify?certNo=${cert.certNo}`}
                    target="_blank"
                    className="clay-btn clay-btn-sm clay-btn-ghost"
                  >
                    <ExternalLink size={14} />
                    Verify
                  </Link>
                  <button
                    className="clay-btn clay-btn-sm clay-btn-primary"
                    onClick={() => setSelectedCert(cert)}
                  >
                    <Download size={14} />
                    View & Print PDF
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Official Certificate Modal & PDF View */}
      {selectedCert && (
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
                  onClick={() => setSelectedCert(null)}
                >
                  ✕ Close
                </button>
              </div>
            </div>

            {/* Certificate Document Body */}
            <div
              ref={certPrintRef}
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
                  Certificate Number: <strong style={{ fontFamily: 'monospace', fontSize: '1rem', color: '#000' }}>{selectedCert.certNo}</strong>
                </div>
              </div>

              {/* Watermark / Background Emblem */}
              <div style={{ borderTop: '2px solid #d4af37', borderBottom: '2px solid #d4af37', padding: '20px 0', margin: '20px 0' }}>
                <p style={{ fontSize: '0.95rem', lineHeight: 1.7, margin: 0, textAlign: 'justify' }}>
                  This is to certify that the measuring/weighing instrument described below belonging to{' '}
                  <strong style={{ textDecoration: 'underline' }}>{selectedCert.ownerSnapshot?.name || 'Trader'}</strong> ({selectedCert.ownerSnapshot?.email}), has been officially inspected, tested, and calibrated in accordance with the <strong>Legal Metrology (General) Rules, 2011</strong> and Section 24 of the Legal Metrology Act, 2009.
                </p>
              </div>

              {/* Specs Table */}
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 24, fontSize: '0.9rem' }}>
                <tbody>
                  <tr style={{ background: '#f8f9fa' }}>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700, width: '40%' }}>Instrument Type / Category</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd' }}>{selectedCert.instrumentSnapshot?.type}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700 }}>Brand & Model</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd' }}>{selectedCert.instrumentSnapshot?.brand} — {selectedCert.instrumentSnapshot?.model}</td>
                  </tr>
                  <tr style={{ background: '#f8f9fa' }}>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700 }}>Serial Number</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontFamily: 'monospace', fontWeight: 700 }}>{selectedCert.instrumentSnapshot?.serialNo}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700 }}>Maximum Capacity</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd' }}>{selectedCert.instrumentSnapshot?.capacity || 'Standard Limit'}</td>
                  </tr>
                  <tr style={{ background: '#f8f9fa' }}>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700 }}>Date of Verification</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 600 }}>{formatDate(selectedCert.issuedDate)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700, color: '#b71c1c' }}>Certificate Expiry Date</td>
                    <td style={{ padding: '8px 12px', border: '1px solid #ddd', fontWeight: 700, color: '#b71c1c' }}>{formatDate(selectedCert.expiryDate)}</td>
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
                        ? `${window.location.origin}/verify?certNo=${selectedCert.certNo}`
                        : `https://vtula.gov.in/verify?certNo=${selectedCert.certNo}`
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
                    HMAC-SHA256: {selectedCert.digitalSignature?.substring(0, 32)}...
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
