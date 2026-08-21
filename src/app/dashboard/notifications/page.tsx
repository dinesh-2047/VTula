'use client';

import { useState, useEffect } from 'react';
import {
  Bell,
  CheckCircle2,
  AlertCircle,
  FileText,
  Award,
  Trash2,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import styles from './notifications.module.css';

interface NotificationItem {
  _id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  isRead: boolean;
  createdAt: string;
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchNotifications();
  }, []);

  const fetchNotifications = async () => {
    try {
      const res = await fetch('/api/notifications');
      const data = await res.json();
      if (data.success) {
        setNotifications(data.notifications || []);
      }
    } catch (err) {
      console.error('Fetch notifications error:', err);
    } finally {
      setLoading(false);
    }
  };

  const markAllRead = async () => {
    try {
      await fetch('/api/notifications', { method: 'PATCH' });
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    } catch (err) {
      console.error('Mark read error:', err);
    }
  };

  const clearAll = async () => {
    try {
      await fetch('/api/notifications', { method: 'DELETE' });
      setNotifications([]);
    } catch (err) {
      console.error('Clear notifications error:', err);
    }
  };

  const formatTimeAgo = (dateStr: string) => {
    if (!dateStr) return 'Just now';
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} mins ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} days ago`;
  };

  if (loading) {
    return (
      <div className={styles.loadingWrap} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300, gap: 12 }}>
        <Loader2 size={36} className={styles.spin} style={{ color: 'var(--color-primary)' }} />
        <p>Loading real-time notifications...</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Notifications</h1>
          <p>Real-time system alerts, application updates, and re-verification reminders.</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="clay-btn clay-btn-ghost clay-btn-sm" onClick={markAllRead}>
            <CheckCircle2 size={16} /> Mark all read
          </button>
          <button className="clay-btn clay-btn-ghost clay-btn-sm" onClick={clearAll}>
            <Trash2 size={16} /> Clear all
          </button>
        </div>
      </div>

      {notifications.length === 0 ? (
        <div className={styles.emptyState}>
          <Bell size={48} style={{ color: 'var(--text-muted)' }} />
          <h3>No notifications</h3>
          <p>You are all caught up! System updates and reminders will appear here.</p>
        </div>
      ) : (
        <div className={styles.list}>
          {notifications.map((n) => (
            <div
              key={n._id}
              className={`${styles.card} ${n.isRead ? styles.read : styles.unread}`}
            >
              <div className={styles.icon}>
                {n.type === 'success' ? (
                  <Award size={20} style={{ color: '#2E7D32' }} />
                ) : n.type === 'warning' ? (
                  <AlertTriangle size={20} style={{ color: '#E65100' }} />
                ) : n.type === 'error' ? (
                  <AlertCircle size={20} style={{ color: '#C62828' }} />
                ) : (
                  <FileText size={20} style={{ color: 'var(--color-primary)' }} />
                )}
              </div>
              <div className={styles.info}>
                <h4>{n.title}</h4>
                <p>{n.message}</p>
                <span className={styles.time}>{formatTimeAgo(n.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
