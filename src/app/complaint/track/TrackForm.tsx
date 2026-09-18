'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  FileSearch,
  Search,
} from 'lucide-react';
import { COMPLAINT_TYPE_LABELS, type ComplaintType } from '@/lib/constants';
import styles from '../complaint.module.css';

/**
 * The complainant's own status check.
 *
 * Reference plus the filing mobile number — the pair is the credential, because
 * `VT-CMP-YYYY-NNNNNN` is sequential and would otherwise let one complainant read
 * the whole series. The server returns a single 404 for both a wrong number and a
 * reference that never existed, so this component must not try to be more helpful
 * than that: telling the user which half was wrong is the oracle the API refuses
 * to be.
 */

interface TimelineEntry {
  status: string;
  label: string;
  note?: string;
  at: string;
}

interface PublicComplaint {
  complaintNo: string;
  status: string;
  statusLabel: string;
  statusNote: string;
  complaintType: string;
  filedOn: string;
  businessName: string;
  district: string;
  state: string;
  description: string;
  evidenceCount: number;
  resolutionNote?: string;
  resolvedAt?: string;
  assignedToOffice?: string;
  timeline: TimelineEntry[];
}

const CLOSED = new Set(['RESOLVED', 'REJECTED', 'WITHDRAWN']);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function TrackForm({ initialRef }: { initialRef?: string }) {
  const [reference, setReference] = useState(initialRef ?? '');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complaint, setComplaint] = useState<PublicComplaint | null>(null);

  const lookup = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (loading) return;

      if (!reference.trim()) return setError('Enter the reference number from your complaint.');
      if (!phone.trim()) return setError('Enter the mobile number you filed with.');

      setLoading(true);
      setError(null);
      setComplaint(null);

      try {
        const params = new URLSearchParams({ ref: reference.trim(), phone: phone.trim() });
        const res = await fetch(`/api/complaints/track?${params.toString()}`);
        const data = (await res.json()) as {
          complaint?: PublicComplaint;
          error?: string;
          message?: string;
        };

        if (!res.ok || !data.complaint) {
          throw new Error(
            data.error ??
              data.message ??
              'No complaint matches that reference and mobile number. Check both.'
          );
        }
        setComplaint(data.complaint);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not check the status right now.');
      } finally {
        setLoading(false);
      }
    },
    [loading, phone, reference]
  );

  return (
    <>
      <form className={`clay-card ${styles.trackForm}`} onSubmit={lookup} noValidate>
        <div className={styles.trackRow}>
          <div className={styles.field}>
            <label className="clay-label" htmlFor="ref">
              Reference number
            </label>
            <input
              id="ref"
              className="clay-input"
              value={reference}
              onChange={(e) => setReference(e.target.value.toUpperCase())}
              placeholder="VT-CMP-2026-000123"
              autoComplete="off"
              required
            />
          </div>
          <div className={styles.field}>
            <label className="clay-label" htmlFor="trackPhone">
              Mobile number
            </label>
            <input
              id="trackPhone"
              className="clay-input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="As used when filing"
              inputMode="numeric"
              autoComplete="tel"
              required
            />
          </div>
          <button type="submit" className="clay-btn clay-btn-primary" disabled={loading}>
            {loading ? <span className={styles.spinner} /> : <Search size={16} />}
            {loading ? 'Checking…' : 'Check status'}
          </button>
        </div>
        <span className={styles.hint}>
          Both are needed. The reference alone would let anyone read someone else&apos;s complaint.
        </span>
      </form>

      {error && (
        <div className={styles.error}>
          <AlertCircle size={17} className={styles.errorIcon} />
          <span>{error}</span>
        </div>
      )}

      {complaint && (
        <div className={`clay-card ${styles.section}`}>
          <div className={styles.statusHero}>
            <span className={styles.statusHeroIcon}>
              {CLOSED.has(complaint.status) ? <CheckCircle2 size={26} /> : <Clock size={26} />}
            </span>
            <span className={styles.statusHeroText}>
              <span className={styles.statusHeroLabel}>{complaint.statusLabel}</span>
              <p className={styles.statusHeroNote}>{complaint.statusNote}</p>
            </span>
          </div>

          <div className={styles.summaryGrid}>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Reference</span>
              <span className={styles.summaryValue}>{complaint.complaintNo}</span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Filed on</span>
              <span className={styles.summaryValue}>{formatDate(complaint.filedOn)}</span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Against</span>
              <span className={styles.summaryValue}>{complaint.businessName}</span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Complaint about</span>
              <span className={styles.summaryValue}>
                {COMPLAINT_TYPE_LABELS[complaint.complaintType as ComplaintType] ??
                  complaint.complaintType}
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Jurisdiction</span>
              <span className={styles.summaryValue}>
                {complaint.district}, {complaint.state}
              </span>
            </div>
            {complaint.assignedToOffice && (
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>With</span>
                <span className={styles.summaryValue}>{complaint.assignedToOffice}</span>
              </div>
            )}
            {complaint.evidenceCount > 0 && (
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Evidence</span>
                <span className={styles.summaryValue}>
                  {complaint.evidenceCount} file{complaint.evidenceCount === 1 ? '' : 's'} on record
                </span>
              </div>
            )}
          </div>

          <div className={styles.sectionHead}>
            <div className={styles.stepNumber}>
              <FileSearch size={17} />
            </div>
            <div>
              <h2 className={styles.sectionTitle}>What has happened so far</h2>
              <p className={styles.sectionHint}>
                Every step the department records on your complaint, most recent last.
              </p>
            </div>
          </div>

          <div className={styles.timeline}>
            {complaint.timeline.map((entry, i) => {
              const isCurrent = i === complaint.timeline.length - 1;
              return (
                <div key={`${entry.status}-${entry.at}-${i}`} className={styles.timelineItem}>
                  <span
                    className={`${styles.timelineDot} ${
                      isCurrent ? styles.timelineDotCurrent : ''
                    }`}
                  >
                    <Check size={14} />
                  </span>
                  <div className={styles.timelineBody}>
                    <div className={styles.timelineLabel}>{entry.label}</div>
                    {entry.note && <p className={styles.timelineNote}>{entry.note}</p>}
                    <span className={styles.timelineDate}>{formatDate(entry.at)}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {complaint.resolutionNote && (
            <div className={styles.resolution}>
              <div className={styles.resolutionLabel}>
                Outcome
                {complaint.resolvedAt ? ` · ${formatDate(complaint.resolvedAt)}` : ''}
              </div>
              <p className={styles.resolutionText}>{complaint.resolutionNote}</p>
            </div>
          )}

          {!CLOSED.has(complaint.status) && (
            <p className={styles.footNote} style={{ marginTop: 18 }}>
              Nothing to do for now — an officer will act on it. If the situation changes or you have
              more evidence, <Link href="/complaint">file a follow-up complaint</Link> and quote this
              reference in the description.
            </p>
          )}
        </div>
      )}
    </>
  );
}
