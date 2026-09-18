'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Copy,
  FileText,
  Film,
  MapPin,
  Send,
  Store,
  Trash2,
  User,
  X,
} from 'lucide-react';
import {
  COMPLAINT_TYPES,
  COMPLAINT_TYPE_LABELS,
  MAX_COMPLAINT_EVIDENCE_FILES,
  MAX_COMPLAINT_UPLOAD_BYTES,
  ALLOWED_COMPLAINT_MIME_TYPES,
  INDIAN_STATES,
} from '@/lib/constants';
import { districtsFor } from '@/lib/districts';
import styles from './complaint.module.css';

/**
 * The public complaint form.
 *
 * Deliberately one long page rather than a wizard. A citizen filing this is
 * standing in a shop or has just left one; a multi-step flow that loses their
 * typing on a back-button or a dropped connection is worse than a form they can
 * see the whole of. The three numbered sections give the same sense of progress
 * without holding the data hostage between steps.
 *
 * Validation here is for the person's benefit only — every rule is enforced again
 * in `fileComplaint`, which is the one that counts. The client copy exists so the
 * message arrives before a 25 MB upload, not because the server trusts it.
 */

interface Attachment {
  file: File;
  /** Object URL, kept so image thumbnails render, revoked on removal. */
  previewUrl?: string;
}

interface FiledComplaint {
  complaintNo: string;
  trackUrl: string;
  filedOn: string;
}

const ACCEPT = ALLOWED_COMPLAINT_MIME_TYPES.join(',');
const MAX_MB = MAX_COMPLAINT_UPLOAD_BYTES / 1_048_576;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export default function ComplaintForm() {
  /* ---------- complainant ---------- */
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [complainantAddress, setComplainantAddress] = useState('');
  const [anonymousToTrader, setAnonymousToTrader] = useState(true);

  /* ---------- the business complained about ---------- */
  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [traderPhone, setTraderPhone] = useState('');
  const [address, setAddress] = useState('');
  const [state, setState] = useState('');
  const [district, setDistrict] = useState('');
  const [pincode, setPincode] = useState('');
  const [landmark, setLandmark] = useState('');

  /* ---------- the complaint ---------- */
  const [complaintType, setComplaintType] = useState<string>('');
  const [description, setDescription] = useState('');
  const [instrumentDescription, setInstrumentDescription] = useState('');
  const [certNo, setCertNo] = useState('');
  const [incidentDate, setIncidentDate] = useState('');

  /* ---------- evidence + location ---------- */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy?: number } | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---------- submission ---------- */
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<FiledComplaint | null>(null);
  const [copied, setCopied] = useState(false);

  /*
   * Districts are derived, never stored twice. Changing the state has to clear the
   * district: leaving "Shimla" selected under Kerala would send the complaint to a
   * jurisdiction that does not exist, and the server would reject it after the
   * uploads had already been sent.
   */
  const districts = useMemo(() => districtsFor(state), [state]);

  /*
   * Filtering happens outside the state updater on purpose. An updater that also
   * collected error messages and minted object URLs would be an impure reducer —
   * which React 19 may call twice — and the second pass would leak a blob URL for
   * every image.
   */
  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const accepted: Attachment[] = [];
      const problems: string[] = [];
      let room = MAX_COMPLAINT_EVIDENCE_FILES - attachments.length;

      for (const file of Array.from(incoming)) {
        if (attachments.some((a) => a.file.name === file.name && a.file.size === file.size)) {
          continue;
        }
        if (room <= 0) {
          problems.push(`Only ${MAX_COMPLAINT_EVIDENCE_FILES} files can be attached.`);
          break;
        }
        if (!ALLOWED_COMPLAINT_MIME_TYPES.includes(file.type as never)) {
          problems.push(`"${file.name}" is not a photo, video or PDF.`);
          continue;
        }
        if (file.size > MAX_COMPLAINT_UPLOAD_BYTES) {
          problems.push(`"${file.name}" is ${formatBytes(file.size)} — the limit is ${MAX_MB} MB.`);
          continue;
        }
        accepted.push({
          file,
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        });
        room -= 1;
      }

      if (accepted.length > 0) setAttachments([...attachments, ...accepted]);
      setError(problems.length > 0 ? problems.join(' ') : null);
    },
    [attachments]
  );

  const removeFile = useCallback(
    (index: number) => {
      const target = attachments[index];
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      setAttachments(attachments.filter((_, i) => i !== index));
    },
    [attachments]
  );

  const captureLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError('This browser cannot share a location. You can skip it — the address is enough.');
      return;
    }
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setGpsBusy(false);
      },
      () => {
        setGpsBusy(false);
        setError(
          'Could not read your location. That is fine — the written address is what the officer uses.'
        );
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    // Cheap checks first, so nobody waits through an upload to be told a field is blank.
    if (name.trim().length < 3) return setError('Please enter your full name.');
    if (!/^[6-9]\d{9}$/.test(phone.replace(/[\s-]/g, ''))) {
      return setError('Please enter a valid 10-digit mobile number — this is how you are contacted.');
    }
    if (!businessName.trim()) return setError('Please enter the name of the shop or business.');
    if (address.trim().length < 8) {
      return setError('Please give enough of the address for an officer to find the premises.');
    }
    if (!state) return setError('Please choose the state.');
    if (!district) return setError('Please choose the district.');
    if (!complaintType) return setError('Please choose what the complaint is about.');
    if (description.trim().length < 20) {
      return setError('Please describe what happened in a little more detail (at least 20 characters).');
    }

    setError(null);
    setSubmitting(true);

    try {
      const form = new FormData();
      form.set('name', name.trim());
      form.set('phone', phone.trim());
      if (email.trim()) form.set('email', email.trim());
      if (complainantAddress.trim()) form.set('complainantAddress', complainantAddress.trim());
      form.set('isAnonymousToTrader', anonymousToTrader ? 'true' : 'false');

      form.set('businessName', businessName.trim());
      if (ownerName.trim()) form.set('ownerName', ownerName.trim());
      if (traderPhone.trim()) form.set('traderPhone', traderPhone.trim());
      form.set('address', address.trim());
      form.set('state', state);
      form.set('district', district);
      if (pincode.trim()) form.set('pincode', pincode.trim());
      if (landmark.trim()) form.set('landmark', landmark.trim());

      form.set('complaintType', complaintType);
      form.set('description', description.trim());
      if (instrumentDescription.trim()) {
        form.set('instrumentDescription', instrumentDescription.trim());
      }
      if (certNo.trim()) form.set('certNo', certNo.trim());
      if (incidentDate) form.set('incidentDate', incidentDate);

      if (gps) {
        form.set('gpsLat', String(gps.lat));
        form.set('gpsLng', String(gps.lng));
        if (gps.accuracy != null) form.set('gpsAccuracy', String(gps.accuracy));
      }

      for (const a of attachments) form.append('evidence', a.file);

      const res = await fetch('/api/complaints/public', { method: 'POST', body: form });
      const data = (await res.json()) as {
        success?: boolean;
        complaintNo?: string;
        trackUrl?: string;
        filedOn?: string;
        error?: string;
        message?: string;
      };

      if (!res.ok || !data.complaintNo) {
        throw new Error(data.error ?? data.message ?? 'Could not file the complaint. Please try again.');
      }

      for (const a of attachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }

      setFiled({
        complaintNo: data.complaintNo,
        trackUrl: data.trackUrl ?? `/complaint/track?ref=${data.complaintNo}`,
        filedOn: data.filedOn ?? new Date().toISOString(),
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  /* ------------------------------------------------------------------ *
   * Filed
   * ------------------------------------------------------------------ */

  if (filed) {
    return (
      <div className={`clay-card ${styles.success}`}>
        <div className={styles.successIcon}>
          <CheckCircle2 size={38} />
        </div>
        <h2 className={styles.successTitle}>Complaint filed</h2>
        <p className={styles.successText}>
          Officers of the {district} Legal Metrology office have been notified. Write this reference
          down — with your mobile number it is the only way to check what has happened, and it is not
          sent again.
        </p>

        <div className={styles.refBox}>
          <span className={styles.refLabel}>Your reference number</span>
          <span className={styles.refNumber}>{filed.complaintNo}</span>
          <button
            type="button"
            className={styles.copyButton}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(filed.complaintNo)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            <Copy size={13} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <div className={styles.successActions}>
          <Link href={filed.trackUrl} className="clay-btn clay-btn-primary">
            Check the status
          </Link>
          <Link href="/" className="clay-btn clay-btn-outline">
            Back to home
          </Link>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------------ *
   * Form
   * ------------------------------------------------------------------ */

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {/* ---------------- 1. About you ---------------- */}
      <section className={`clay-card ${styles.section}`}>
        <div className={styles.sectionHead}>
          <div className={styles.stepNumber}>
            <User size={17} />
          </div>
          <div>
            <h2 className={styles.sectionTitle}>About you</h2>
            <p className={styles.sectionHint}>
              An officer needs to be able to reach you. Your details are never shown to the business.
            </p>
          </div>
        </div>

        <div className={styles.grid}>
          <div className={styles.field}>
            <label className="clay-label" htmlFor="name">
              Your full name<span className={styles.required}>*</span>
            </label>
            <input
              id="name"
              className="clay-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ramesh Kumar"
              autoComplete="name"
              required
            />
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="phone">
              Mobile number<span className={styles.required}>*</span>
            </label>
            <input
              id="phone"
              className="clay-input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="10-digit mobile"
              inputMode="numeric"
              autoComplete="tel"
              required
            />
            <span className={styles.hint}>
              You will need this number, with the reference, to check the status later.
            </span>
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="email">
              Email <span className={styles.hint}>(optional)</span>
            </label>
            <input
              id="email"
              className="clay-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="complainantAddress">
              Your address <span className={styles.hint}>(optional)</span>
            </label>
            <input
              id="complainantAddress"
              className="clay-input"
              value={complainantAddress}
              onChange={(e) => setComplainantAddress(e.target.value)}
              placeholder="Town or locality is enough"
            />
          </div>

          <label className={`${styles.checkRow} ${styles.fieldWide}`}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={anonymousToTrader}
              onChange={(e) => setAnonymousToTrader(e.target.checked)}
            />
            <span>
              <span className={styles.checkLabel}>
                Do not reveal my name to the shop or business
              </span>
              <span className={styles.checkHint}>
                Officers can still see your details and contact you. The business is told there is a
                complaint, not who made it.
              </span>
            </span>
          </label>
        </div>
      </section>

      {/* ---------------- 2. Who you are complaining about ---------------- */}
      <section className={`clay-card ${styles.section}`}>
        <div className={styles.sectionHead}>
          <div className={styles.stepNumber}>
            <Store size={17} />
          </div>
          <div>
            <h2 className={styles.sectionTitle}>The shop or business</h2>
            <p className={styles.sectionHint}>
              You do not need a certificate number or a registration. A name and an address the
              officer can find is enough — including for a business using no verified instrument at
              all.
            </p>
          </div>
        </div>

        <div className={styles.grid}>
          <div className={styles.field}>
            <label className="clay-label" htmlFor="businessName">
              Shop / business name<span className={styles.required}>*</span>
            </label>
            <input
              id="businessName"
              className="clay-input"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="e.g. Sharma Kirana Store"
              required
            />
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="ownerName">
              Owner / person in charge <span className={styles.hint}>(if known)</span>
            </label>
            <input
              id="ownerName"
              className="clay-input"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              placeholder="Name on the board, if any"
            />
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="traderPhone">
              Their phone number <span className={styles.hint}>(if known)</span>
            </label>
            <input
              id="traderPhone"
              className="clay-input"
              value={traderPhone}
              onChange={(e) => setTraderPhone(e.target.value)}
              placeholder="Shop or owner's number"
              inputMode="numeric"
            />
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="landmark">
              Nearest landmark <span className={styles.hint}>(optional)</span>
            </label>
            <input
              id="landmark"
              className="clay-input"
              value={landmark}
              onChange={(e) => setLandmark(e.target.value)}
              placeholder="e.g. opposite the bus stand"
            />
          </div>

          <div className={`${styles.field} ${styles.fieldWide}`}>
            <label className="clay-label" htmlFor="address">
              Address of the premises<span className={styles.required}>*</span>
            </label>
            <input
              id="address"
              className="clay-input"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Shop number, street, market, town"
              required
            />
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="state">
              State / UT<span className={styles.required}>*</span>
            </label>
            <select
              id="state"
              className="clay-select"
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setDistrict('');
              }}
              required
            >
              <option value="">Select a state</option>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="district">
              District<span className={styles.required}>*</span>
            </label>
            <select
              id="district"
              className="clay-select"
              value={district}
              onChange={(e) => setDistrict(e.target.value)}
              disabled={districts.length === 0}
              required
            >
              <option value="">{state ? 'Select a district' : 'Choose a state first'}</option>
              {districts.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <span className={styles.hint}>
              This decides which office handles the complaint, so it has to come from the list.
            </span>
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="pincode">
              PIN code <span className={styles.hint}>(optional)</span>
            </label>
            <input
              id="pincode"
              className="clay-input"
              value={pincode}
              onChange={(e) => setPincode(e.target.value)}
              placeholder="6 digits"
              inputMode="numeric"
              maxLength={6}
            />
          </div>
        </div>
      </section>

      {/* ---------------- 3. What happened ---------------- */}
      <section className={`clay-card ${styles.section}`}>
        <div className={styles.sectionHead}>
          <div className={styles.stepNumber}>
            <AlertCircle size={17} />
          </div>
          <div>
            <h2 className={styles.sectionTitle}>What happened</h2>
            <p className={styles.sectionHint}>
              Pick the closest description, then tell us in your own words.
            </p>
          </div>
        </div>

        <div className={styles.typeGrid}>
          {COMPLAINT_TYPES.map((t) => {
            const active = complaintType === t;
            return (
              <button
                key={t}
                type="button"
                className={`${styles.typeOption} ${active ? styles.typeOptionActive : ''}`}
                onClick={() => setComplaintType(t)}
                aria-pressed={active}
              >
                <span className={styles.typeRadio}>
                  {active && <span className={styles.typeRadioDot} />}
                </span>
                <span className={styles.typeLabel}>{COMPLAINT_TYPE_LABELS[t]}</span>
              </button>
            );
          })}
        </div>

        <div className={styles.grid} style={{ marginTop: 18 }}>
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <label className="clay-label" htmlFor="description">
              Describe what happened<span className={styles.required}>*</span>
            </label>
            <textarea
              id="description"
              className={`clay-input ${styles.textarea}`}
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 5000))}
              placeholder="What did you buy or measure, what did the machine show, and what did you expect? Anything the shopkeeper said when you raised it is useful too."
              required
            />
            <span
              className={`${styles.charCount} ${
                description.trim().length > 0 && description.trim().length < 20
                  ? styles.charCountLow
                  : ''
              }`}
            >
              {description.length} / 5000
              {description.trim().length > 0 && description.trim().length < 20
                ? ` — at least 20 characters`
                : ''}
            </span>
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="instrumentDescription">
              The machine <span className={styles.hint}>(if you can describe it)</span>
            </label>
            <input
              id="instrumentDescription"
              className="clay-input"
              value={instrumentDescription}
              onChange={(e) => setInstrumentDescription(e.target.value)}
              placeholder="e.g. digital counter scale, no sticker"
            />
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="certNo">
              Certificate number <span className={styles.hint}>(if a sticker is visible)</span>
            </label>
            <input
              id="certNo"
              className="clay-input"
              value={certNo}
              onChange={(e) => setCertNo(e.target.value.toUpperCase())}
              placeholder="VT-CERT-YYYY-NNNNNN"
            />
          </div>

          <div className={styles.field}>
            <label className="clay-label" htmlFor="incidentDate">
              When did it happen? <span className={styles.hint}>(optional)</span>
            </label>
            <input
              id="incidentDate"
              className="clay-input"
              type="date"
              value={incidentDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setIncidentDate(e.target.value)}
            />
          </div>
        </div>
      </section>

      {/* ---------------- 4. Evidence ---------------- */}
      <section className={`clay-card ${styles.section}`}>
        <div className={styles.sectionHead}>
          <div className={styles.stepNumber}>
            <Camera size={17} />
          </div>
          <div>
            <h2 className={styles.sectionTitle}>Photos, video and documents</h2>
            <p className={styles.sectionHint}>
              Optional, but a photo of the display or a short clip of the pump is often what settles
              the case. Up to {MAX_COMPLAINT_EVIDENCE_FILES} files, {MAX_MB} MB each.
            </p>
          </div>
        </div>

        <div
          className={`${styles.dropZone} ${dragging ? styles.dropZoneActive : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
          }}
        >
          <div className={styles.dropIcon}>
            <Camera size={30} />
          </div>
          <p className={styles.dropTitle}>Tap to add photos or a video</p>
          <p className={styles.dropHint}>
            JPEG, PNG, WebP, MP4, MOV, WebM or PDF · or drag files here
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          className={styles.fileInput}
          accept={ACCEPT}
          multiple
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            // Cleared so re-picking the same file fires a change event again.
            e.target.value = '';
          }}
        />

        {attachments.length > 0 && (
          <div className={styles.fileList}>
            {attachments.map((a, i) => (
              <div key={`${a.file.name}-${a.file.size}-${i}`} className={styles.fileRow}>
                {a.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.previewUrl} alt="" className={styles.filePreview} />
                ) : (
                  <span className={styles.fileIcon}>
                    {a.file.type.startsWith('video/') ? <Film size={18} /> : <FileText size={18} />}
                  </span>
                )}
                <div className={styles.fileMeta}>
                  <div className={styles.fileName}>{a.file.name}</div>
                  <div className={styles.fileSize}>{formatBytes(a.file.size)}</div>
                </div>
                <button
                  type="button"
                  className={styles.fileRemove}
                  onClick={() => removeFile(i)}
                  aria-label={`Remove ${a.file.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={styles.gpsRow} style={{ marginTop: 14 }}>
          <MapPin size={18} className={styles.gpsCaptured} />
          <span className={styles.gpsText}>
            {gps ? (
              <span className={styles.gpsCaptured}>
                Location attached ({gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}
                {gps.accuracy ? `, ±${Math.round(gps.accuracy)} m` : ''})
              </span>
            ) : (
              'Attaching your location helps the officer find the exact premises. Only do this if you are at the shop now.'
            )}
          </span>
          <button
            type="button"
            className="clay-btn clay-btn-outline clay-btn-sm"
            onClick={captureLocation}
            disabled={gpsBusy}
          >
            {gpsBusy ? 'Reading…' : gps ? 'Update' : 'Attach location'}
          </button>
          {gps && (
            <button
              type="button"
              className="clay-btn clay-btn-ghost clay-btn-sm"
              onClick={() => setGps(null)}
            >
              <X size={14} />
              Remove
            </button>
          )}
        </div>
      </section>

      {error && (
        <div className={styles.error}>
          <AlertCircle size={17} className={styles.errorIcon} />
          <span>{error}</span>
        </div>
      )}

      <div className={styles.submitRow}>
        <button
          type="submit"
          className={`clay-btn clay-btn-primary ${styles.submitButton}`}
          disabled={submitting}
        >
          {submitting ? (
            <>
              <span className={styles.spinner} />
              Filing your complaint…
            </>
          ) : (
            <>
              <Send size={17} />
              File the complaint
            </>
          )}
        </button>
        <span className={styles.submitNote}>
          Filing a knowingly false complaint is itself an offence. You will get a reference number on
          the next screen.
        </span>
      </div>
    </form>
  );
}
