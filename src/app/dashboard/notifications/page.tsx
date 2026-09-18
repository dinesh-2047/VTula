'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Award,
  Bell,
  Check,
  CheckCheck,
  FileText,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import { formatDateTime } from '@/lib/constants';
import styles from './notifications.module.css';

/**
 * The signed-in user's inbox.
 *
 * Four things were wrong with the previous version, and two of them were silent.
 *
 * "Mark all read" sent `PATCH` with no body. The route requires either `ids` or
 * `all: true` and rejects anything else with `NOTHING_TO_MARK`, so the request
 * always failed — but the page marked every row read in local state regardless,
 * so it looked like it had worked until the next reload.
 *
 * "Clear all" emptied the list on screen. The route deliberately keeps *unread*
 * notifications unless `includeUnread=true` is passed, precisely so a certificate
 * expiry alert cannot be dismissed before it has been seen. So the unread ones
 * came back on reload, and the button that appeared to have deleted them had not.
 *
 * `actionUrl` and `actionLabel` — the deep link written on every notification by
 * `src/lib/notify.ts` — were never rendered, which made "Your application has
 * been approved" a dead end.
 *
 * And the page described itself as real-time twice. Nothing here polls or holds a
 * stream open; it reads once when opened. It now says so, and offers a refresh.
 */

interface NotificationItem {
  _id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  isRead: boolean;
  createdAt: string;
  actionUrl?: string;
  actionLabel?: string;
  relatedModel?: string;
}

type Filter = 'all' | 'unread';

const TYPE_STYLE: Record<
  NotificationItem['type'],
  { icon: typeof Bell; color: string; background: string }
> = {
  success: { icon: Award, color: 'var(--status-success)', background: 'var(--status-success-bg)' },
  warning: {
    icon: AlertTriangle,
    color: 'var(--status-warning)',
    background: 'var(--status-warning-bg)',
  },
  error: { icon: AlertCircle, color: 'var(--status-error)', background: 'var(--status-error-bg)' },
  info: { icon: FileText, color: 'var(--status-info)', background: 'var(--status-info-bg)' },
};

/**
 * Relative time against an explicit `now` rather than the clock.
 *
 * Reading `Date.now()` while rendering makes the render non-idempotent — the same
 * state produces different output depending on when React happens to re-run it —
 * and React's compiler rejects it. `now` is captured once when the list is
 * fetched, which also matches what the timestamps actually mean here: as of the
 * moment this list was loaded.
 */
function relativeTime(dateStr: string, now: number): string {
  if (!dateStr) return 'Just now';
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return 'Unknown';

  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return 'Just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;

  const hours = Math.floor(mins / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;

  return formatDateTime(dateStr);
}

export default function NotificationsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filter === 'unread' ? '?unread=true&limit=100' : '?limit=100';
      const res = await fetch(`/api/notifications${qs}`);
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        notifications?: NotificationItem[];
        unreadCount?: number;
        total?: number;
      };
      if (!data.success) {
        setError(data.error ?? 'Your notifications could not be loaded.');
        return;
      }
      setError(null);
      setNotifications(data.notifications ?? []);
      setUnreadCount(data.unreadCount ?? 0);
      setTotal(data.total ?? 0);
      setFetchedAt(Date.now());
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchNotifications();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchNotifications]);

  /** `ids` for a single row, `all` for the whole inbox — the shape the route wants. */
  async function markRead(body: { ids: string[] } | { all: true }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        unreadCount?: number;
      };
      if (!data.success) {
        setError(data.error ?? 'Could not mark these as read.');
        return false;
      }
      const ids = 'ids' in body ? new Set(body.ids) : null;
      setNotifications((prev) =>
        prev.map((n) => (!ids || ids.has(n._id) ? { ...n, isRead: true } : n))
      );
      // The count comes back from the server rather than being decremented here,
      // so the sidebar figure cannot drift away from the database.
      setUnreadCount(data.unreadCount ?? 0);
      return true;
    } catch {
      setError('Could not reach the server.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/notifications?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (!data.success) {
        setError(data.error ?? 'Could not remove that notification.');
        return;
      }
      const removed = notifications.find((n) => n._id === id);
      setNotifications((prev) => prev.filter((n) => n._id !== id));
      setTotal((t) => Math.max(0, t - 1));
      if (removed && !removed.isRead) setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  /*
   * Clears read notifications only. The unread ones are the compliance alerts —
   * an expiring certificate, a query raised on an application — and the server
   * keeps them on purpose. Clearing those needs the explicit second button.
   */
  async function clearRead() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/notifications', { method: 'DELETE' });
      const data = (await res.json()) as { success: boolean; error?: string; deleted?: number };
      if (!data.success) {
        setError(data.error ?? 'Could not clear your notifications.');
        return;
      }
      await fetchNotifications();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function clearEverything() {
    const confirmed = window.confirm(
      `This removes all ${total} notifications, including ${unreadCount} you have not read yet. ` +
        'Compliance reminders about expiring certificates will be removed too. Continue?'
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/notifications?includeUnread=true', { method: 'DELETE' });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (!data.success) {
        setError(data.error ?? 'Could not clear your notifications.');
        return;
      }
      await fetchNotifications();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  /** Marks the row read before following its link, so the badge is right on return. */
  async function open(n: NotificationItem) {
    if (!n.actionUrl) return;
    if (!n.isRead) await markRead({ ids: [n._id] });
    router.push(n.actionUrl);
  }

  if (loading) {
    return (
      <div className={styles.loadingWrap}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading your notifications…</p>
      </div>
    );
  }

  const readCount = Math.max(0, total - unreadCount);

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Notifications</h1>
          <p>
            Application updates, inspection outcomes and re-verification reminders. This list is
            read when you open the page — refresh to check for new ones.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            className="clay-btn clay-btn-ghost clay-btn-sm"
            onClick={() => markRead({ all: true })}
            disabled={busy || unreadCount === 0}
          >
            <CheckCheck size={16} /> Mark all read
          </button>
          <button
            className="clay-btn clay-btn-ghost clay-btn-sm"
            onClick={clearRead}
            disabled={busy || readCount === 0}
          >
            <Trash2 size={16} /> Clear read ({readCount})
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.errorBox}>
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      )}

      <div className={styles.toolbar}>
        <div className={styles.tabs} role="group" aria-label="Filter notifications">
          <button
            type="button"
            className={`${styles.tab} ${filter === 'all' ? styles.tabActive : ''}`}
            onClick={() => setFilter('all')}
            aria-pressed={filter === 'all'}
          >
            All <span className={styles.tabCount}>{total}</span>
          </button>
          <button
            type="button"
            className={`${styles.tab} ${filter === 'unread' ? styles.tabActive : ''}`}
            onClick={() => setFilter('unread')}
            aria-pressed={filter === 'unread'}
          >
            Unread <span className={styles.tabCount}>{unreadCount}</span>
          </button>
        </div>
        {total > notifications.length && filter === 'all' && (
          <span className={styles.toolbarNote}>
            Showing the {notifications.length} most recent of {total}.
          </span>
        )}
      </div>

      {notifications.length === 0 ? (
        <div className={styles.emptyState}>
          <Bell size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>{filter === 'unread' ? 'Nothing unread' : 'No notifications'}</h3>
          <p>
            {filter === 'unread'
              ? 'You have read everything in your inbox.'
              : 'Updates on your applications, inspections and certificates will appear here.'}
          </p>
        </div>
      ) : (
        <div className={styles.list}>
          {notifications.map((n) => {
            const style = TYPE_STYLE[n.type] ?? TYPE_STYLE.info;
            const Icon = style.icon;
            return (
              <div
                key={n._id}
                className={`${styles.card} ${n.isRead ? styles.read : styles.unread}`}
              >
                <div className={styles.icon} style={{ background: style.background }}>
                  <Icon size={20} style={{ color: style.color }} />
                </div>

                <div className={styles.info}>
                  <h4>{n.title}</h4>
                  <p>{n.message}</p>
                  <div className={styles.cardFooter}>
                    <span className={styles.time} title={formatDateTime(n.createdAt)}>
                      {relativeTime(n.createdAt, fetchedAt)}
                    </span>
                    {n.actionUrl && (
                      <button
                        type="button"
                        className={styles.actionLink}
                        onClick={() => open(n)}
                        disabled={busy}
                      >
                        {n.actionLabel || 'Open'} <ArrowRight size={13} />
                      </button>
                    )}
                    {!n.isRead && (
                      <button
                        type="button"
                        className={styles.footerBtn}
                        onClick={() => markRead({ ids: [n._id] })}
                        disabled={busy}
                      >
                        <Check size={13} /> Mark read
                      </button>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  className={styles.dismissBtn}
                  onClick={() => dismiss(n._id)}
                  disabled={busy}
                  aria-label={`Remove notification: ${n.title}`}
                  title="Remove"
                >
                  <X size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/*
        * Deliberately last, small, and separate from "Clear read". It removes
        * unread compliance alerts, which is the one destructive thing on the page.
        */}
      {total > 0 && (
        <div className={styles.dangerZone}>
          <button
            type="button"
            className={styles.dangerLink}
            onClick={clearEverything}
            disabled={busy}
          >
            Clear everything, including {unreadCount} unread
          </button>
        </div>
      )}
    </div>
  );
}
