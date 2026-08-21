'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Scale,
  ArrowLeft,
  Loader2,
  MapPin,
  Camera,
  CheckCircle,
  Building,
  X,
  Upload,
} from 'lucide-react';
import { INDIAN_STATES, INSTRUMENT_TYPES } from '@/lib/utils';
import styles from './new.module.css';

interface PhotoItem {
  id: string;
  name: string;
  url: string;
}

export default function NewInstrumentPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const [photos, setPhotos] = useState<PhotoItem[]>([]);

  const [formData, setFormData] = useState({
    type: 'Weighing Scale',
    brand: '',
    model: '',
    serialNo: '',
    capacity: '',
    accuracyClass: '',
    installationState: '',
    installationDistrict: '',
    address: '',
    gpsLat: '',
    gpsLng: '',
  });

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setError('');
  };

  const handleGetLocation = () => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setFormData((prev) => ({
            ...prev,
            gpsLat: pos.coords.latitude.toFixed(6),
            gpsLng: pos.coords.longitude.toFixed(6),
          }));
        },
        (err) => {
          console.error('Geo error:', err);
          setError('Could not get GPS coordinates. Please allow location permissions.');
        }
      );
    }
  };

  // Handle Photo selection with canvas auto-compression
  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const maxDim = 800;
            let width = img.width;
            let height = img.height;

            if (width > maxDim || height > maxDim) {
              if (width > height) {
                height = Math.round((height * maxDim) / width);
                width = maxDim;
              } else {
                width = Math.round((width * maxDim) / height);
                height = maxDim;
              }
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(img, 0, 0, width, height);

            const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.8);
            setPhotos((prev) => [
              ...prev,
              {
                id: Math.random().toString(36).substring(2, 9),
                name: file.name,
                url: compressedDataUrl,
              },
            ]);
          };
          img.src = event.target?.result as string;
        };
        reader.readAsDataURL(file);
      }
    });
  };

  const removePhoto = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/instruments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          photos: photos.map((p) => p.url),
          gpsCoordinates:
            formData.gpsLat && formData.gpsLng
              ? { lat: parseFloat(formData.gpsLat), lng: parseFloat(formData.gpsLng) }
              : undefined,
        }),
      });

      const data = await res.json();

      if (data.success) {
        setSuccess(true);
        setTimeout(() => {
          router.push('/dashboard/instruments');
        }, 1500);
      } else {
        setError(data.error || 'Failed to register instrument');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <Link href="/dashboard/instruments" className={styles.backLink}>
        <ArrowLeft size={16} />
        Back to Instruments
      </Link>

      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerIcon}>
            <Scale size={28} />
          </div>
          <div>
            <h1>Register New Instrument</h1>
            <p>Add commercial weight or measure details to the official registry.</p>
          </div>
        </div>

        {success ? (
          <div className={styles.successCard}>
            <CheckCircle size={48} style={{ color: 'var(--color-secondary)' }} />
            <h2>Instrument Registered!</h2>
            <p>Redirecting to your instruments list...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className={styles.formCard}>
            {error && <div className={styles.error}>{error}</div>}

            {/* Instrument Info */}
            <div className={styles.sectionTitle}>
              <Scale size={18} />
              <span>Instrument Specification</span>
            </div>

            <div className={styles.formGrid}>
              <div className="clay-input-group">
                <label className="clay-label">Instrument Type *</label>
                <select
                  className="clay-input clay-select"
                  value={formData.type}
                  onChange={(e) => updateField('type', e.target.value)}
                  required
                >
                  {INSTRUMENT_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Make / Brand *</label>
                <input
                  type="text"
                  className="clay-input"
                  placeholder="e.g. Avery Weigh-Tronix"
                  value={formData.brand}
                  onChange={(e) => updateField('brand', e.target.value)}
                  required
                />
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Model Number *</label>
                <input
                  type="text"
                  className="clay-input"
                  placeholder="e.g. ZM510"
                  value={formData.model}
                  onChange={(e) => updateField('model', e.target.value)}
                  required
                />
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Serial Number *</label>
                <input
                  type="text"
                  className="clay-input"
                  placeholder="e.g. SN-2026-9842"
                  value={formData.serialNo}
                  onChange={(e) => updateField('serialNo', e.target.value)}
                  required
                />
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Maximum Capacity / Range *</label>
                <input
                  type="text"
                  className="clay-input"
                  placeholder="e.g. 50 kg / 0.1g"
                  value={formData.capacity}
                  onChange={(e) => updateField('capacity', e.target.value)}
                  required
                />
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Accuracy Class</label>
                <select
                  className="clay-input clay-select"
                  value={formData.accuracyClass}
                  onChange={(e) => updateField('accuracyClass', e.target.value)}
                >
                  <option value="">Select Class (Optional)</option>
                  <option value="Class I (Special)">Class I (Special)</option>
                  <option value="Class II (High)">Class II (High)</option>
                  <option value="Class III (Medium)">Class III (Medium)</option>
                  <option value="Class IIII (Ordinary)">Class IIII (Ordinary)</option>
                </select>
              </div>
            </div>

            {/* Location Info */}
            <div className={styles.sectionTitle} style={{ marginTop: 28 }}>
              <Building size={18} />
              <span>Installation Location</span>
            </div>

            <div className={styles.formGrid}>
              <div className="clay-input-group">
                <label className="clay-label">State *</label>
                <select
                  className="clay-input clay-select"
                  value={formData.installationState}
                  onChange={(e) => updateField('installationState', e.target.value)}
                  required
                >
                  <option value="">Select State</option>
                  {INDIAN_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              <div className="clay-input-group">
                <label className="clay-label">District *</label>
                <input
                  type="text"
                  className="clay-input"
                  placeholder="e.g. Ahmedabad"
                  value={formData.installationDistrict}
                  onChange={(e) => updateField('installationDistrict', e.target.value)}
                  required
                />
              </div>

              <div className="clay-input-group" style={{ gridColumn: 'span 2' }}>
                <label className="clay-label">Full Commercial Address *</label>
                <textarea
                  className="clay-input"
                  placeholder="Shop No., Market / Factory Name, Street Address"
                  value={formData.address}
                  onChange={(e) => updateField('address', e.target.value)}
                  required
                  rows={3}
                />
              </div>

              <div className="clay-input-group" style={{ gridColumn: 'span 2' }}>
                <label className="clay-label">GPS Geo-Coordinates (Optional)</label>
                <div style={{ display: 'flex', gap: 12 }}>
                  <input
                    type="text"
                    className="clay-input"
                    placeholder="Latitude"
                    value={formData.gpsLat}
                    onChange={(e) => updateField('gpsLat', e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <input
                    type="text"
                    className="clay-input"
                    placeholder="Longitude"
                    value={formData.gpsLng}
                    onChange={(e) => updateField('gpsLng', e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="clay-btn clay-btn-ghost"
                    onClick={handleGetLocation}
                    title="Auto-detect current GPS location"
                  >
                    <MapPin size={18} />
                    Auto GPS
                  </button>
                </div>
              </div>
            </div>

            {/* Photo Attachment Section */}
            <div className={styles.sectionTitle} style={{ marginTop: 28 }}>
              <Camera size={18} />
              <span>Instrument Photo Evidence</span>
            </div>

            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              multiple
              onChange={handlePhotoSelect}
              style={{ display: 'none' }}
            />

            <div
              className={styles.photoUploadBox}
              onClick={() => fileInputRef.current?.click()}
              style={{ cursor: 'pointer' }}
            >
              <Camera size={32} style={{ color: 'var(--color-primary)' }} />
              <p style={{ fontWeight: 600, marginTop: 6 }}>
                Click or drag photos of serial number tag and full instrument
              </p>
              <span className={styles.uploadHint}>JPG, PNG up to 5MB (Optional)</span>
            </div>

            {/* Photo Thumbnails Preview Grid */}
            {photos.length > 0 && (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
                {photos.map((photo) => (
                  <div
                    key={photo.id}
                    style={{
                      position: 'relative',
                      width: 90,
                      height: 90,
                      borderRadius: 'var(--radius-md)',
                      overflow: 'hidden',
                      boxShadow: 'var(--clay-shadow-sm)',
                      border: '2px solid white',
                    }}
                  >
                    <img
                      src={photo.url}
                      alt={photo.name}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    <button
                      type="button"
                      onClick={(e) => removePhoto(photo.id, e)}
                      style={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        background: 'rgba(0, 0, 0, 0.6)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '50%',
                        width: 22,
                        height: 22,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Submit */}
            <div className={styles.formActions}>
              <Link href="/dashboard/instruments" className="clay-btn clay-btn-ghost">
                Cancel
              </Link>
              <button
                type="submit"
                className="clay-btn clay-btn-primary clay-btn-lg"
                disabled={loading}
              >
                {loading ? <Loader2 size={18} className={styles.spin} /> : null}
                {loading ? 'Saving Instrument...' : 'Register Instrument'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
