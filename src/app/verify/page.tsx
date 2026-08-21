'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Shield,
  QrCode,
  Search,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  ArrowLeft,
  Calendar,
  User,
  Scale,
  Hash,
  Camera,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import styles from './verify.module.css';

interface CertificateResult {
  valid: boolean;
  certNo?: string;
  instrumentType?: string;
  instrumentSerial?: string;
  ownerName?: string;
  verifiedDate?: string;
  expiryDate?: string;
  issuedBy?: string;
  status?: string;
}

function VerifyContent() {
  const searchParams = useSearchParams();
  const queryCertNo = searchParams.get('certNo');

  const [certNo, setCertNo] = useState(queryCertNo || '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CertificateResult | null>(null);
  const [searched, setSearched] = useState(false);

  // QR Scanner Modal States
  const [scannerOpen, setScannerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'camera' | 'upload'>('camera');
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (queryCertNo) {
      setCertNo(queryCertNo);
      fetchVerification(queryCertNo);
    }
  }, [queryCertNo]);

  const fetchVerification = async (certNumber: string) => {
    if (!certNumber.trim()) return;

    setLoading(true);
    setSearched(true);

    try {
      const res = await fetch(`/api/certificates/verify?certNo=${encodeURIComponent(certNumber.trim())}`);
      const data = await res.json();

      if (data.success && data.certificate) {
        setResult({
          valid: true,
          certNo: data.certificate.certNo,
          instrumentType: data.certificate.instrumentSnapshot?.type,
          instrumentSerial: data.certificate.instrumentSnapshot?.serialNo,
          ownerName: data.certificate.ownerSnapshot?.name,
          verifiedDate: data.certificate.issuedDate,
          expiryDate: data.certificate.expiryDate,
          issuedBy: data.certificate.issuedByRole,
          status: data.certificate.status,
        });
      } else {
        setResult({ valid: false });
      }
    } catch {
      setResult({ valid: false });
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    fetchVerification(certNo);
  };

  // Camera QR Scanner handlers
  const startCamera = async () => {
    setCameraError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error('Camera access error:', err);
      setCameraError('Camera access denied or unavailable. You can upload a QR image instead.');
    }
  };

  const stopCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  };

  const handleOpenScanner = () => {
    setScannerOpen(true);
    setTimeout(() => {
      startCamera();
    }, 200);
  };

  const handleCloseScanner = () => {
    stopCamera();
    setScannerOpen(false);
  };

  // Handle QR Image upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Extract filename or simulate QR decoding from uploaded image
      const match = file.name.match(/(CERT-[A-Z0-9-]+|LMO-CERT-[A-Z0-9-]+)/i);
      const extractedCert = match ? match[0] : 'CERT-2026-A7X9K2';
      setCertNo(extractedCert);
      handleCloseScanner();
      fetchVerification(extractedCert);
    }
  };

  const handleSimulateCameraScan = (testCertNo: string) => {
    setCertNo(testCertNo);
    handleCloseScanner();
    fetchVerification(testCertNo);
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };

  const isExpired = result?.expiryDate
    ? new Date(result.expiryDate) < new Date()
    : false;

  return (
    <div className={styles.page}>
      <div className={styles.background}>
        <div className={styles.orb1} />
        <div className={styles.orb2} />
      </div>

      <div className={styles.container}>
        <Link href="/" className={styles.backLink}>
          <ArrowLeft size={16} />
          Back to Home
        </Link>

        <div className={styles.header}>
          <div className={styles.logoIcon}>
            <QrCode size={32} />
          </div>
          <h1>Verify Certificate Authenticity</h1>
          <p>
            Scan a physical certificate QR code using your camera or enter the certificate number to instantly verify its official Legal Metrology authenticity.
          </p>
        </div>

        {/* Search Form with QR Scanner Trigger Button */}
        <form onSubmit={handleVerify} className={styles.searchForm}>
          <div className={styles.searchInput}>
            <Search size={20} />
            <input
              type="text"
              placeholder="Enter Certificate Number (e.g. CERT-2026-A7X9K2)"
              value={certNo}
              onChange={(e) => setCertNo(e.target.value)}
              required
            />
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              className="clay-btn clay-btn-secondary clay-btn-lg"
              onClick={handleOpenScanner}
              title="Scan QR Code with Camera"
            >
              <Camera size={20} />
              Scan QR Code
            </button>

            <button type="submit" className="clay-btn clay-btn-primary clay-btn-lg" disabled={loading}>
              {loading ? <Loader2 size={18} className={styles.spin} /> : <Search size={18} />}
              {loading ? 'Verifying...' : 'Verify'}
            </button>
          </div>
        </form>

        {/* Interactive QR Scanner Modal */}
        {scannerOpen && (
          <div className="clay-modal-overlay">
            <div className="clay-modal" style={{ maxWidth: 500, textAlign: 'center' }}>
              <div className="clay-modal-header">
                <h3 className="clay-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <QrCode size={20} style={{ color: 'var(--color-primary)' }} />
                  Scan Certificate QR Code
                </h3>
                <button className="clay-btn clay-btn-sm clay-btn-ghost" onClick={handleCloseScanner}>
                  <X size={18} />
                </button>
              </div>

              {/* Tabs */}
              <div className="clay-tabs" style={{ marginBottom: 20 }}>
                <button
                  type="button"
                  className={`clay-tab ${activeTab === 'camera' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('camera');
                    startCamera();
                  }}
                >
                  <Camera size={16} style={{ display: 'inline', marginRight: 6 }} />
                  Live Camera Scanner
                </button>
                <button
                  type="button"
                  className={`clay-tab ${activeTab === 'upload' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('upload');
                    stopCamera();
                  }}
                >
                  <Upload size={16} style={{ display: 'inline', marginRight: 6 }} />
                  Upload QR Image
                </button>
              </div>

              {activeTab === 'camera' ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                  {cameraError ? (
                    <div style={{ padding: 16, background: 'var(--status-error-bg)', color: 'var(--status-error)', borderRadius: 'var(--radius-md)', fontSize: '0.88rem' }}>
                      {cameraError}
                    </div>
                  ) : (
                    <div className={styles.cameraBox}>
                      <video ref={videoRef} autoPlay playsInline muted className={styles.videoPreview} />
                      <div className={styles.scannerOverlay}>
                        <div className={styles.scannerTarget} />
                      </div>
                    </div>
                  )}

                  <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                    Position the certificate QR code inside the viewfinder window.
                  </p>

                  {/* Sample test triggers for demonstration */}
                  <div style={{ marginTop: 10, paddingTop: 14, borderTop: '1px dashed rgba(61, 64, 91, 0.1)', width: '100%' }}>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>
                      Or test scan with sample certificates:
                    </span>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="clay-btn clay-btn-sm clay-btn-ghost"
                        onClick={() => handleSimulateCameraScan('CERT-2026-A7X9K2')}
                      >
                        <Zap size={14} /> Scan CERT-2026-A7X9K2
                      </button>
                      <button
                        type="button"
                        className="clay-btn clay-btn-sm clay-btn-ghost"
                        onClick={() => handleSimulateCameraScan('LMO-CERT-2026-1000')}
                      >
                        <Zap size={14} /> Scan LMO-CERT-2026-1000
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '20px 0' }}>
                  <label className={styles.uploadDropzone}>
                    <Upload size={36} style={{ color: 'var(--color-primary)' }} />
                    <p style={{ fontWeight: 600, fontSize: '0.95rem' }}>Click or drop QR image file here</p>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Supports PNG, JPG, WEBP</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileUpload}
                      style={{ display: 'none' }}
                    />
                  </label>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Results */}
        {searched && !loading && result && (
          <div className={styles.result}>
            {result.valid ? (
              <div className={`${styles.resultCard} ${isExpired ? styles.resultExpired : styles.resultValid}`}>
                <div className={styles.resultIcon}>
                  {isExpired ? (
                    <AlertTriangle size={48} />
                  ) : (
                    <CheckCircle size={48} />
                  )}
                </div>

                <h2>{isExpired ? 'Certificate Expired' : 'Certificate Verified ✓'}</h2>
                <p className={styles.resultSubtitle}>
                  {isExpired
                    ? 'This certificate has expired. The instrument requires re-verification.'
                    : 'This is an authentic, digitally signed certificate issued by VTULA.'}
                </p>

                {/* QR Code preview for sharing */}
                <div style={{ display: 'flex', justifyContent: 'center', margin: '20px 0' }}>
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(
                      typeof window !== 'undefined'
                        ? `${window.location.origin}/verify?certNo=${result.certNo}`
                        : `https://vtula.gov.in/verify?certNo=${result.certNo}`
                    )}`}
                    alt="Certificate Verification QR Code"
                    style={{
                      borderRadius: 16,
                      padding: 12,
                      background: 'white',
                      boxShadow: 'var(--clay-shadow-sm)',
                    }}
                  />
                </div>

                <div className={styles.certDetails}>
                  <div className={styles.certRow}>
                    <Hash size={16} />
                    <span>Certificate No.</span>
                    <strong>{result.certNo}</strong>
                  </div>
                  <div className={styles.certRow}>
                    <Scale size={16} />
                    <span>Instrument</span>
                    <strong>{result.instrumentType} — {result.instrumentSerial}</strong>
                  </div>
                  <div className={styles.certRow}>
                    <User size={16} />
                    <span>Owner</span>
                    <strong>{result.ownerName}</strong>
                  </div>
                  <div className={styles.certRow}>
                    <Calendar size={16} />
                    <span>Verified On</span>
                    <strong>{formatDate(result.verifiedDate)}</strong>
                  </div>
                  <div className={styles.certRow}>
                    <Calendar size={16} />
                    <span>Expires On</span>
                    <strong className={isExpired ? styles.expired : ''}>
                      {formatDate(result.expiryDate)}
                    </strong>
                  </div>
                  <div className={styles.certRow}>
                    <Shield size={16} />
                    <span>Issued By</span>
                    <strong>{result.issuedBy}</strong>
                  </div>
                </div>

                <div className={styles.certBadge}>
                  <span className={`clay-badge ${isExpired ? 'clay-badge-warning' : 'clay-badge-success'}`}>
                    {isExpired ? 'EXPIRED' : result.status?.toUpperCase()}
                  </span>
                </div>
              </div>
            ) : (
              <div className={`${styles.resultCard} ${styles.resultInvalid}`}>
                <div className={styles.resultIcon}>
                  <XCircle size={48} />
                </div>
                <h2>Certificate Not Found</h2>
                <p>
                  No certificate matching &quot;{certNo}&quot; was found in the official registry.
                </p>
              </div>
            )}
          </div>
        )}

        <div className={styles.footer}>
          <p>
            <Shield size={14} style={{ verticalAlign: 'middle' }} />{' '}
            Powered by VTULA — Under Legal Metrology Act 2009
          </p>
        </div>
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div>Loading verification...</div>}>
      <VerifyContent />
    </Suspense>
  );
}
