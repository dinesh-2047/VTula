'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  CalendarDays,
  Loader2,
  AlertTriangle,
  MapPin,
  User as UserIcon,
  Phone,
  Clock,
  History,
  Info,
  PlayCircle,
  CalendarClock,
  XCircle,
  UserX,
  CheckCircle2,
  Lightbulb,
} from 'lucide-react';
import {
  SCHEDULE_STATUS_LABELS,
  scheduleStatusBadgeClass,
  formatDate,
  formatDateTime,
  APPLICATION_STATUS_LABELS,
  type ScheduleStatus,
  type Role,
} from '@/lib/constants';
import styles from './schedule.module.css';

/**
 * Inspection appointments.
 *
 * `/api/schedules` has served this list since scheduling was implemented and
 * nothing ever asked it for anything. The consequences were spread across three
 * roles:
 *
 *  - **A business** was told by notification that an inspection had been booked
 *    and then had nowhere to look it up, and no way to say "that date does not
 *    work" — even though `PATCH` has accepted an owner reschedule and an owner
 *    cancellation from the beginning.
 *  - **An inspector** had a task queue but not a calendar, so "what am I doing on
 *    Thursday, and in what order" was unanswerable. Neither of the two things that
 *    actually happen in the field — arriving on site, or finding the shop shut —
 *    could be recorded, so `IN_PROGRESS` and `NO_SHOW` were unreachable states.
 *  - **An LMO** could book a slot from the application queue and then never see
 *    the district's week, which is the view that tells you a Tuesday has four
 *    visits and a Wednesday none.
 *
 * The page derives no permissions of its own. Each slot arrives with the
 * `actions` the server will accept from this user, and the buttons are that list —
 * the same arrangement as `availableTransitions` on an application. A button is
 * therefore never offered that the route would refuse.
 */

/* ------------------------------------------------------------------ *
 * Shapes, mirroring what the route returns
 * ------------------------------------------------------------------ */

type ActionName = 'reschedule' | 'cancel' | 'start' | 'no_show';

interface AllowedAction {
  action: ActionName;
  reasonRequired: boolean;
}

interface OwnerRef {
  _id: string;
  name?: string;
  organizationName?: string;
  phone?: string;
}

interface AppRef {
  _id: string;
  applicationNo: string;
  type?: string;
  status?: string;
  dueDate?: string;
  ownerId?: OwnerRef | string;
}

interface InstrumentRef {
  _id: string;
  type?: string;
  brand?: string;
  model?: string;
  serialNo?: string;
  address?: string;
}

interface AssigneeRef {
  _id: string;
  name?: string;
  role?: string;
  designation?: string;
  officerCode?: string;
  phone?: string;
}

interface HistoryEntry {
  scheduledDate: string;
  status: string;
  changedAt: string;
  reason?: string;
}

interface Slot {
  _id: string;
  applicationId?: AppRef | null;
  instrumentId?: InstrumentRef | null;
  assignedTo?: AssigneeRef | null;
  assignedToRole?: string;
  scheduledDate: string;
  slotStart?: string;
  slotEnd?: string;
  location?: {
    address?: string;
    district?: string;
    state?: string;
    gps?: { lat: number; lng: number };
  };
  status: ScheduleStatus;
  ownerPreferredDate?: string;
  statusReason?: string;
  history?: HistoryEntry[];
  assignmentRationale?: string[];
  actions: AllowedAction[];
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

type Window = 'upcoming' | 'week' | 'past' | 'all';

const WINDOW_LABELS: Record<Window, string> = {
  upcoming: 'Upcoming',
  week: 'Next 7 days',
  past: 'Past visits',
  all: 'Everything',
};

/**
 * What each action asks for, and how it should read on a button.
 *
 * Two wordings per action, because the same route call means different things
 * depending on who makes it. An owner cancelling is withdrawing their own
 * availability; an officer cancelling is withdrawing the department's. Presenting
 * both as "Cancel" would let an owner believe they had called off an inspection
 * they are still legally required to have.
 */
const ACTION_COPY: Record<
  ActionName,
  {
    officer: string;
    owner: string;
    icon: typeof PlayCircle;
    heading: string;
    ownerHeading: string;
    prompt: string;
    ownerPrompt: string;
    danger?: boolean;
    needsDate?: boolean;
  }
> = {
  reschedule: {
    officer: 'Move this visit',
    owner: 'Ask for a different date',
    icon: CalendarClock,
    heading: 'Move the inspection',
    ownerHeading: 'Ask for a different date',
    prompt:
      'Give the new date and say why it moved. The reason goes on the application timeline, where the business and any later audit will read it.',
    ownerPrompt:
      'Choose a date that works and say why the booked one does not. The office is notified and the inspector is told to travel on the new day.',
    needsDate: true,
  },
  cancel: {
    officer: 'Withdraw this slot',
    owner: 'Cancel this visit',
    icon: XCircle,
    heading: 'Withdraw the slot',
    ownerHeading: 'Cancel this visit',
    prompt:
      'The application goes back to the scheduling queue and the inspector is told not to travel. It is not a decision on the application.',
    ownerPrompt:
      'This calls off the visit only — your application stays open and goes back into the queue for a new date. The instrument still has to be verified.',
    danger: true,
  },
  start: {
    officer: 'I am on site',
    owner: 'I am on site',
    icon: PlayCircle,
    heading: 'Start the inspection',
    ownerHeading: 'Start the inspection',
    prompt:
      'Marks the visit as under way and moves the application to Inspection in progress, so the office can see the work has started.',
    ownerPrompt: '',
  },
  no_show: {
    officer: 'Could not inspect',
    owner: 'Could not inspect',
    icon: UserX,
    heading: 'Record that the visit could not go ahead',
    ownerHeading: 'Record that the visit could not go ahead',
    prompt:
      'Say what you found — premises closed, instrument not presented, nobody authorised on site. This is noted on the business’s compliance record and they are told what you wrote, so write it as you would want it read back.',
    ownerPrompt: '',
    danger: true,
  },
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** `YYYY-MM-DD` in local time, which is the unit a day-grouped list needs. */
function dayKey(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ownerOf(app?: AppRef | null): OwnerRef | null {
  if (!app?.ownerId) return null;
  return typeof app.ownerId === 'string' ? { _id: app.ownerId } : app.ownerId;
}

function instrumentLabel(inst?: InstrumentRef | null): string {
  if (!inst) return 'Instrument no longer on the register';
  const head = [inst.brand, inst.model].filter(Boolean).join(' ');
  return [head, inst.serialNo].filter(Boolean).join(' · ') || (inst.type ?? 'Instrument');
}

function slotWindow(slot: Slot): string | null {
  if (slot.slotStart && slot.slotEnd) return `${slot.slotStart} – ${slot.slotEnd}`;
  return slot.slotStart ?? slot.slotEnd ?? null;
}

/* ------------------------------------------------------------------ *
 * The action form
 * ------------------------------------------------------------------ */

function ActionPanel({
  slot,
  action,
  isOwner,
  minDate,
  onClose,
  onDone,
}: {
  slot: Slot;
  action: AllowedAction;
  isOwner: boolean;
  minDate: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const copy = ACTION_COPY[action.action];
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduleId: slot._id,
          action: action.action,
          scheduledDate: copy.needsDate ? date : undefined,
          reason: reason.trim() || undefined,
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        setError(json.error ?? 'The change could not be saved.');
        return;
      }
      onDone();
    } catch {
      setError('The change could not be sent. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  // The route requires at least five characters, so the button says so rather
  // than letting the request come back as a 400.
  const reasonTooShort = action.reasonRequired && reason.trim().length < 5;
  const dateMissing = Boolean(copy.needsDate) && !date;

  return (
    <form onSubmit={submit} className={styles.actionPanel}>
      <h4>{isOwner ? copy.ownerHeading : copy.heading}</h4>
      <p className={styles.actionPrompt}>{isOwner && copy.ownerPrompt ? copy.ownerPrompt : copy.prompt}</p>

      {copy.needsDate && (
        <div className="clay-input-group">
          <label className="clay-label" htmlFor={`date-${slot._id}`}>
            New date
          </label>
          <input
            id={`date-${slot._id}`}
            type="date"
            className="clay-input"
            value={date}
            min={minDate}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
      )}

      {action.reasonRequired ? (
        <div className="clay-input-group">
          <label className="clay-label" htmlFor={`reason-${slot._id}`}>
            Reason
          </label>
          <textarea
            id={`reason-${slot._id}`}
            className="clay-input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              action.action === 'no_show'
                ? 'e.g. Premises closed at 11:20; neighbouring shopkeeper said the owner was away for the week.'
                : 'e.g. The weighbridge is under repair until the 14th.'
            }
            required
          />
        </div>
      ) : (
        <div className="clay-input-group">
          <label className="clay-label" htmlFor={`note-${slot._id}`}>
            Note <span className={styles.optional}>optional</span>
          </label>
          <textarea
            id={`note-${slot._id}`}
            className="clay-input"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}

      {error && (
        <p className={styles.actionError}>
          <AlertTriangle size={15} />
          {error}
        </p>
      )}

      <div className={styles.actionFoot}>
        <button
          type="submit"
          className={`clay-btn clay-btn-sm ${copy.danger ? 'clay-btn-outline' : 'clay-btn-primary'}`}
          disabled={busy || reasonTooShort || dateMissing}
        >
          {busy ? <Loader2 size={14} className={styles.spin} /> : <copy.icon size={14} />}
          {busy ? 'Saving…' : 'Confirm'}
        </button>
        <button type="button" className="clay-btn clay-btn-ghost clay-btn-sm" onClick={onClose} disabled={busy}>
          Never mind
        </button>
        {reasonTooShort && <span className={styles.hint}>A reason of at least a few words is required.</span>}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * One appointment
 * ------------------------------------------------------------------ */

function SlotCard({
  slot,
  role,
  userId,
  minDate,
  onChanged,
}: {
  slot: Slot;
  role: Role | undefined;
  userId: string | undefined;
  minDate: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<ActionName | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const app = slot.applicationId ?? null;
  const owner = ownerOf(app);
  const isOwnerView = role === 'Owner';
  const isMine = slot.assignedTo?._id === userId;
  const window = slotWindow(slot);
  const moves = slot.history?.length ?? 0;

  const chosen = open ? slot.actions.find((a) => a.action === open) : undefined;

  return (
    <article className={`${styles.slot} ${isMine ? styles.slotMine : ''}`}>
      <div className={styles.slotTop}>
        <div className={styles.slotHead}>
          <span className={`clay-badge ${scheduleStatusBadgeClass(slot.status)}`}>
            {SCHEDULE_STATUS_LABELS[slot.status] ?? slot.status}
          </span>
          {app ? (
            <Link href={`/dashboard/applications/${app._id}`} className={styles.appLink}>
              {app.applicationNo}
            </Link>
          ) : (
            <span className={styles.appLink}>Application removed</span>
          )}
          {isMine && !isOwnerView && <span className={styles.mineTag}>Yours</span>}
        </div>
        {window && (
          <span className={styles.window}>
            <Clock size={13} />
            {window}
          </span>
        )}
      </div>

      <p className={styles.instrument}>{instrumentLabel(slot.instrumentId)}</p>

      <dl className={styles.facts}>
        {slot.location?.address && (
          <div>
            <dt>
              <MapPin size={13} />
              Where
            </dt>
            <dd>
              {slot.location.address}
              {slot.location.district ? `, ${slot.location.district}` : ''}
              {slot.location.state ? `, ${slot.location.state}` : ''}
            </dd>
          </div>
        )}

        {/* An owner already knows who they are; they need to know who is coming. */}
        {isOwnerView
          ? slot.assignedTo && (
              <div>
                <dt>
                  <UserIcon size={13} />
                  Inspector
                </dt>
                <dd>
                  {slot.assignedTo.name}
                  {slot.assignedTo.designation ? `, ${slot.assignedTo.designation}` : ''}
                  {slot.assignedTo.officerCode ? ` (${slot.assignedTo.officerCode})` : ''}
                </dd>
              </div>
            )
          : owner && (
              <div>
                <dt>
                  <UserIcon size={13} />
                  Business
                </dt>
                <dd>
                  {owner.organizationName ?? owner.name ?? 'Unnamed'}
                  {owner.organizationName && owner.name ? ` — ${owner.name}` : ''}
                  {owner.phone && (
                    <a href={`tel:${owner.phone}`} className={styles.phone}>
                      <Phone size={12} />
                      {owner.phone}
                    </a>
                  )}
                </dd>
              </div>
            )}

        {/* An officer looking at the district's week needs to see whose visit it
            is; an inspector looking at their own does not. */}
        {!isOwnerView && !isMine && slot.assignedTo && (
          <div>
            <dt>
              <UserIcon size={13} />
              Assigned to
            </dt>
            <dd>
              {slot.assignedTo.name}
              {slot.assignedTo.designation ? `, ${slot.assignedTo.designation}` : ''}
            </dd>
          </div>
        )}

        {app?.status && (
          <div>
            <dt>
              <Info size={13} />
              Application
            </dt>
            <dd>{APPLICATION_STATUS_LABELS[app.status as keyof typeof APPLICATION_STATUS_LABELS] ?? app.status}</dd>
          </div>
        )}

        {slot.ownerPreferredDate && dayKey(slot.ownerPreferredDate) !== dayKey(slot.scheduledDate) && (
          <div>
            <dt>
              <CalendarDays size={13} />
              Business asked for
            </dt>
            <dd>{formatDate(slot.ownerPreferredDate)}</dd>
          </div>
        )}
      </dl>

      {slot.statusReason && (
        <p className={styles.statusReason}>
          <Info size={14} />
          <span>{slot.statusReason}</span>
        </p>
      )}

      {/* Officials only — the route withholds it from the business, because it is a
          workload note about a named officer rather than anything about the
          instrument. */}
      {(slot.assignmentRationale?.length ?? 0) > 0 && (
        <details className={styles.rationale}>
          <summary>
            <Lightbulb size={13} />
            Why this inspector was suggested
          </summary>
          <ul>
            {slot.assignmentRationale!.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}

      {moves > 0 && (
        <div className={styles.historyWrap}>
          <button type="button" className={styles.historyToggle} onClick={() => setShowHistory((v) => !v)}>
            <History size={13} />
            {showHistory ? 'Hide' : 'Show'} the {moves === 1 ? 'earlier date' : `${moves} earlier dates`}
          </button>
          {showHistory && (
            <ol className={styles.history}>
              {slot.history!.map((h, i) => (
                <li key={i}>
                  <strong>{formatDate(h.scheduledDate)}</strong>
                  <span className={styles.historyMeta}>
                    {SCHEDULE_STATUS_LABELS[h.status as ScheduleStatus] ?? h.status} · changed{' '}
                    {formatDateTime(h.changedAt)}
                  </span>
                  {h.reason && <span className={styles.historyReason}>{h.reason}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {slot.actions.length > 0 && (
        <div className={styles.actionRow}>
          {slot.actions.map((a) => {
            const copy = ACTION_COPY[a.action];
            const Icon = copy.icon;
            const active = open === a.action;
            return (
              <button
                key={a.action}
                type="button"
                className={`clay-btn clay-btn-sm ${
                  active ? 'clay-btn-primary' : copy.danger ? 'clay-btn-outline' : 'clay-btn-secondary'
                }`}
                onClick={() => setOpen(active ? null : a.action)}
              >
                <Icon size={14} />
                {isOwnerView ? copy.owner : copy.officer}
              </button>
            );
          })}
        </div>
      )}

      {chosen && (
        <ActionPanel
          slot={slot}
          action={chosen}
          isOwner={isOwnerView}
          minDate={minDate}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            onChanged();
          }}
        />
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function SchedulePage() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  const userId = session?.user?.id;
  const isOwnerView = role === 'Owner';

  const [slots, setSlots] = useState<Slot[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [win, setWin] = useState<Window>('upcoming');
  const [mineOnly, setMineOnly] = useState(false);

  /*
   * "Today" is captured when the request is made, not during render.
   *
   * Two reasons. `new Date()` in a component body is a purity violation the React
   * compiler rejects outright. And the day boundaries used to label the groups
   * have to be the same ones used to build the query window, or a list fetched
   * just before midnight would render its first group as "Tomorrow".
   */
  const [today, setToday] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const params = new URLSearchParams({ limit: '100' });

      if (win === 'upcoming') {
        params.set('from', startOfToday.toISOString());
      } else if (win === 'week') {
        params.set('from', startOfToday.toISOString());
        params.set('to', new Date(startOfToday.getTime() + 7 * 86_400_000).toISOString());
      } else if (win === 'past') {
        params.set('to', startOfToday.toISOString());
        // Past visits are the only view where a cancelled slot is worth seeing:
        // the question there is what happened, not what is going to.
        params.set('status', 'COMPLETED,CANCELLED,NO_SHOW,RESCHEDULED');
      }
      if (mineOnly) params.set('mine', 'true');

      const res = await fetch(`/api/schedules?${params.toString()}`);
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        schedules?: Slot[];
        total?: number;
      };
      if (!res.ok || !json.success) {
        setError(json.error ?? 'The schedule could not be loaded.');
        setSlots([]);
        return;
      }
      setSlots(json.schedules ?? []);
      setTotal(json.total ?? 0);
      setToday(dayKey(startOfToday));
    } catch {
      setError('The schedule could not be loaded. Check your connection and try again.');
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }, [win, mineOnly]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  /** Grouped by day, because that is the unit a visit is planned in. */
  const groups = useMemo(() => {
    const byDay = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = dayKey(s.scheduledDate);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(s);
      else byDay.set(key, [s]);
    }
    const ordered = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // Past visits read backwards from the most recent; everything else forwards
    // from the next one due.
    return win === 'past' ? ordered.reverse() : ordered;
  }, [slots, win]);

  const tomorrow = useMemo(() => {
    if (!today) return '';
    const [y, m, d] = today.split('-').map(Number);
    return dayKey(new Date(y, m - 1, d + 1));
  }, [today]);

  function dayHeading(key: string): string {
    if (key === today) return 'Today';
    if (key === tomorrow) return 'Tomorrow';
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  const liveCount = slots.filter((s) =>
    ['PROPOSED', 'CONFIRMED', 'RESCHEDULED', 'IN_PROGRESS'].includes(s.status)
  ).length;

  if (loading && slots.length === 0) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={26} className={styles.spin} />
        <span>Loading the schedule…</span>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>
            <CalendarDays size={24} />
            {isOwnerView ? 'Your inspection visits' : 'Inspection schedule'}
          </h1>
          <p className={styles.lead}>
            {isOwnerView
              ? 'Every inspection booked against your applications. If a date does not work, say so here rather than letting the visit fail — a missed visit is noted on your compliance record, a rescheduled one is not.'
              : 'Booked visits in your jurisdiction, by day. Slots are created from an application once it has been approved for scheduling; this is where they are moved, started and closed off.'}
          </p>
        </div>
      </header>

      <div className={styles.controls}>
        <div className={styles.tabs} role="tablist" aria-label="Which visits to show">
          {(Object.keys(WINDOW_LABELS) as Window[]).map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={win === w}
              className={`${styles.tab} ${win === w ? styles.tabOn : ''}`}
              onClick={() => setWin(w)}
            >
              {WINDOW_LABELS[w]}
            </button>
          ))}
        </div>

        {/* Only an inspector can be an assignee, so the filter is meaningless for
            anyone else and is not shown to them. */}
        {!isOwnerView && (
          <label className={styles.mineToggle}>
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            Only visits assigned to me
          </label>
        )}

        {loading && <Loader2 size={15} className={styles.spin} />}
      </div>

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={18} />
          <div>
            <strong>{error}</strong>
            <button type="button" className="clay-btn clay-btn-sm clay-btn-outline" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      )}

      {!error && slots.length === 0 && (
        <div className={styles.emptyNote}>
          <CheckCircle2 size={18} />
          <span>
            {win === 'past'
              ? 'No visits have been completed, cancelled or missed in this jurisdiction yet.'
              : isOwnerView
                ? 'No inspection has been booked for you. Once an officer has checked your paperwork, a slot is arranged and it appears here — you are notified as well.'
                : 'No visits are booked. Slots are created from the application queue: open an application that is approved for scheduling and book a date on it.'}
          </span>
        </div>
      )}

      {slots.length > 0 && (
        <p className={styles.countLine}>
          {slots.length === total ? (
            <>
              {slots.length} {slots.length === 1 ? 'visit' : 'visits'}
              {win !== 'past' && liveCount !== slots.length ? ` · ${liveCount} still to happen` : ''}
            </>
          ) : (
            /* Said plainly rather than silently truncating: the route caps a page at
               100 slots and a busy district will reach it. */
            <>
              Showing the first {slots.length} of {total} visits, soonest first — narrow the
              window to see the rest.
            </>
          )}
        </p>
      )}

      {groups.map(([key, daySlots]) => (
        <section key={key} className={styles.day}>
          <h2 className={styles.dayHead}>
            <span className={key === today ? styles.dayTodayMark : styles.dayMark} />
            {dayHeading(key)}
            <span className={styles.dayCount}>
              {daySlots.length} {daySlots.length === 1 ? 'visit' : 'visits'}
            </span>
          </h2>
          <div className={styles.daySlots}>
            {daySlots.map((s) => (
              <SlotCard
                key={s._id}
                slot={s}
                role={role}
                userId={userId}
                minDate={today}
                onChanged={() => void load()}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
