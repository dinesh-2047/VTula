'use client';

import { useState, type FormEvent } from 'react';
import {
  Pencil,
  Truck,
  CircleSlash,
  X,
  Loader2,
  AlertTriangle,
  Crosshair,
} from 'lucide-react';
import { INDIAN_STATES } from '@/lib/constants';
import type { PassportInstrument } from './page';
import styles from './passport.module.css';

/**
 * The three things an owner may do to a registered instrument.
 *
 * They are kept in their own component because each is a *record*, not an edit:
 * `PATCH /api/instruments/[id]` writes an InstrumentEvent for every one of them
 * and a move is appended to `locationHistory` rather than overwriting the
 * address. The forms here therefore mirror the endpoint's contract exactly —
 * notably that a move needs address, state and district **together**, because a
 * half-recorded move would leave the register pointing at a jurisdiction that
 * never inspected the machine.
 *
 * Identity fields are absent by design: `type`, `brand`, `model` and `serialNo`
 * are what a certificate was issued against, so they are not editable here or
 * on the server.
 */

type Dialog = 'spec' | 'move' | 'decommission';

interface SpecForm {
  accuracyClass: string;
  modelApprovalNo: string;
  capacity: string;
  installationDate: string;
}

interface MoveForm {
  address: string;
  installationState: string;
  installationDistrict: string;
  lat: string;
  lng: string;
  moveNote: string;
}

export default function InstrumentActions({
  instrument,
  onChanged,
}: {
  instrument: PassportInstrument;
  onChanged: () => Promise<void> | void;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [spec, setSpec] = useState<SpecForm>(emptySpec);
  const [move, setMove] = useState<MoveForm>(emptyMove);
  const [reason, setReason] = useState('');
  const [locating, setLocating] = useState(false);

  // Forms are seeded when the dialog opens rather than in an effect, so there is
  // no render pass where the inputs are blank and no state set during render.
  function open(which: Dialog) {
    setError(null);
    if (which === 'spec') {
      setSpec({
        accuracyClass: instrument.accuracyClass ?? '',
        modelApprovalNo: instrument.modelApprovalNo ?? '',
        capacity: instrument.capacity ?? '',
        installationDate: toDateInput(instrument.installationDate),
      });
    }
    if (which === 'move') {
      setMove({
        address: instrument.address ?? '',
        installationState: instrument.installationState ?? '',
        installationDistrict: instrument.installationDistrict ?? '',
        lat: '',
        lng: '',
        moveNote: '',
      });
    }
    if (which === 'decommission') setReason('');
    setDialog(which);
  }

  function close() {
    if (saving) return;
    setDialog(null);
    setError(null);
  }

  async function submit(body: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/instruments/${instrument._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (!data.success) {
        setError(data.error || 'The change could not be saved.');
        return;
      }
      await onChanged();
      setDialog(null);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  function saveSpec(e: FormEvent) {
    e.preventDefault();
    void submit({
      accuracyClass: spec.accuracyClass,
      modelApprovalNo: spec.modelApprovalNo,
      capacity: spec.capacity,
      installationDate: spec.installationDate || '',
    });
  }

  function saveMove(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      address: move.address,
      installationState: move.installationState,
      installationDistrict: move.installationDistrict,
      moveNote: move.moveNote,
    };
    if (move.lat && move.lng) {
      body.gpsCoordinates = { lat: Number(move.lat), lng: Number(move.lng) };
    }
    void submit(body);
  }

  function saveDecommission(e: FormEvent) {
    e.preventDefault();
    void submit({ decommission: true, reason });
  }

  function captureGps() {
    if (!navigator.geolocation) {
      setError('This browser cannot report a location.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMove((prev) => ({
          ...prev,
          lat: pos.coords.latitude.toFixed(6),
          lng: pos.coords.longitude.toFixed(6),
        }));
        setLocating(false);
      },
      () => {
        setError('Location permission was refused, so no coordinates were captured.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 12_000 }
    );
  }

  const moveIncomplete =
    !move.address.trim() || !move.installationState || !move.installationDistrict.trim();

  return (
    <>
      <div className={styles.actions}>
        <button type="button" className="clay-btn clay-btn-sm clay-btn-outline" onClick={() => open('spec')}>
          <Pencil size={14} />
          Edit details
        </button>
        <button type="button" className="clay-btn clay-btn-sm clay-btn-outline" onClick={() => open('move')}>
          <Truck size={14} />
          Record a move
        </button>
        <button
          type="button"
          className="clay-btn clay-btn-sm clay-btn-ghost"
          onClick={() => open('decommission')}
        >
          <CircleSlash size={14} />
          Decommission
        </button>
      </div>

      {dialog && (
        <div className="clay-modal-overlay" onClick={close} role="presentation">
          <div
            className="clay-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={DIALOG_TITLES[dialog]}
          >
            <div className="clay-modal-header">
              <h2 className="clay-modal-title">{DIALOG_TITLES[dialog]}</h2>
              <button type="button" className="clay-btn-icon" onClick={close} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            {error && (
              <p className={styles.formError}>
                <AlertTriangle size={15} />
                {error}
              </p>
            )}

            {dialog === 'spec' && (
              <form onSubmit={saveSpec} className={styles.form}>
                <p className={styles.formNote}>
                  Category, make, model and serial number cannot be changed — a certificate was
                  issued against them. Everything below is a specification detail.
                </p>
                <label className={styles.field}>
                  <span className="clay-label">Accuracy class</span>
                  <input
                    className="clay-input"
                    value={spec.accuracyClass}
                    onChange={(e) => setSpec((p) => ({ ...p, accuracyClass: e.target.value }))}
                    placeholder="e.g. Class III"
                  />
                </label>
                <label className={styles.field}>
                  <span className="clay-label">Model approval number</span>
                  <input
                    className="clay-input"
                    value={spec.modelApprovalNo}
                    onChange={(e) => setSpec((p) => ({ ...p, modelApprovalNo: e.target.value }))}
                    placeholder="As printed on the approval certificate"
                  />
                </label>
                <label className={styles.field}>
                  <span className="clay-label">Capacity</span>
                  <input
                    className="clay-input"
                    value={spec.capacity}
                    onChange={(e) => setSpec((p) => ({ ...p, capacity: e.target.value }))}
                    placeholder="e.g. 100 kg"
                  />
                  <em className={styles.hint}>
                    Capacity decides which tolerance band applies, so a change is recorded in the
                    instrument&apos;s history.
                  </em>
                </label>
                <label className={styles.field}>
                  <span className="clay-label">Installation date</span>
                  <input
                    type="date"
                    className="clay-input"
                    value={spec.installationDate}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setSpec((p) => ({ ...p, installationDate: e.target.value }))}
                  />
                </label>
                <Footer saving={saving} onCancel={close} label="Save details" />
              </form>
            )}

            {dialog === 'move' && (
              <form onSubmit={saveMove} className={styles.form}>
                <p className={styles.formNote}>
                  The previous address is kept and closed off, not replaced. If the district or
                  state changes, responsibility for inspecting this instrument moves with it.
                </p>
                <label className={styles.field}>
                  <span className="clay-label">New address</span>
                  <textarea
                    className="clay-input"
                    rows={3}
                    value={move.address}
                    onChange={(e) => setMove((p) => ({ ...p, address: e.target.value }))}
                    placeholder="Shop or premises address where the instrument is now installed"
                    required
                  />
                </label>
                <div className={styles.fieldRow}>
                  <label className={styles.field}>
                    <span className="clay-label">State</span>
                    <select
                      className="clay-select"
                      value={move.installationState}
                      onChange={(e) =>
                        setMove((p) => ({ ...p, installationState: e.target.value }))
                      }
                      required
                    >
                      <option value="">Select a state</option>
                      {INDIAN_STATES.map((state) => (
                        <option key={state} value={state}>
                          {state}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.field}>
                    <span className="clay-label">District</span>
                    <input
                      className="clay-input"
                      value={move.installationDistrict}
                      onChange={(e) =>
                        setMove((p) => ({ ...p, installationDistrict: e.target.value }))
                      }
                      required
                    />
                  </label>
                </div>
                <div className={styles.gpsRow}>
                  <button
                    type="button"
                    className="clay-btn clay-btn-sm clay-btn-secondary"
                    onClick={captureGps}
                    disabled={locating}
                  >
                    {locating ? <Loader2 size={14} className={styles.spin} /> : <Crosshair size={14} />}
                    {locating ? 'Locating…' : 'Use my current location'}
                  </button>
                  <span className={styles.hint}>
                    {move.lat && move.lng
                      ? `${move.lat}, ${move.lng}`
                      : 'Optional. Helps the inspector find the premises.'}
                  </span>
                </div>
                <label className={styles.field}>
                  <span className="clay-label">Note (optional)</span>
                  <textarea
                    className="clay-input"
                    rows={2}
                    value={move.moveNote}
                    onChange={(e) => setMove((p) => ({ ...p, moveNote: e.target.value }))}
                    placeholder="Why the instrument was moved"
                  />
                </label>
                <Footer
                  saving={saving}
                  onCancel={close}
                  label="Record the move"
                  disabled={moveIncomplete}
                />
              </form>
            )}

            {dialog === 'decommission' && (
              <form onSubmit={saveDecommission} className={styles.form}>
                <p className={styles.formWarn}>
                  <AlertTriangle size={16} />
                  <span>
                    Decommissioning is permanent. The record stays for audit, any live certificate
                    is marked superseded, and the instrument can no longer be verified or
                    transferred. Register it again if it returns to service.
                  </span>
                </p>
                <label className={styles.field}>
                  <span className="clay-label">Reason</span>
                  <textarea
                    className="clay-input"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Scrapped after irreparable load-cell failure"
                    required
                    minLength={5}
                  />
                  <em className={styles.hint}>
                    This becomes part of the instrument&apos;s permanent record.
                  </em>
                </label>
                <Footer
                  saving={saving}
                  onCancel={close}
                  label="Decommission instrument"
                  danger
                  disabled={reason.trim().length < 5}
                />
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const DIALOG_TITLES: Record<Dialog, string> = {
  spec: 'Edit specification',
  move: 'Record a change of location',
  decommission: 'Decommission this instrument',
};

function emptySpec(): SpecForm {
  return { accuracyClass: '', modelApprovalNo: '', capacity: '', installationDate: '' };
}

function emptyMove(): MoveForm {
  return {
    address: '',
    installationState: '',
    installationDistrict: '',
    lat: '',
    lng: '',
    moveNote: '',
  };
}

function Footer({
  saving,
  onCancel,
  label,
  danger,
  disabled,
}: {
  saving: boolean;
  onCancel: () => void;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={styles.formActions}>
      <button type="button" className="clay-btn clay-btn-ghost" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
      <button
        type="submit"
        className={`clay-btn ${danger ? 'clay-btn-charcoal' : 'clay-btn-primary'}`}
        disabled={saving || disabled}
      >
        {saving && <Loader2 size={15} className={styles.spin} />}
        {saving ? 'Saving…' : label}
      </button>
    </div>
  );
}

function toDateInput(value: string | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
