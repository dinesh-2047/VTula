'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import {
  User,
  Mail,
  Phone,
  Building,
  Shield,
  Save,
  CheckCircle,
} from 'lucide-react';
import styles from './profile.module.css';

export default function ProfilePage() {
  const { data: session } = useSession();
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState({
    name: session?.user?.name || 'Registered Merchant',
    email: session?.user?.email || 'merchant@vtula.gov.in',
    phone: '+91 98765 43210',
    organizationName: 'Legal Metrology Commercial Enterprise',
    state: 'Gujarat',
    district: 'Ahmedabad',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>Profile Settings</h1>
          <p>Manage your account credentials, commercial establishment details, and state jurisdiction.</p>
        </div>
      </div>

      <div className={styles.container}>
        {saved && (
          <div className={styles.successBanner}>
            <CheckCircle size={18} /> Profile settings updated successfully.
          </div>
        )}

        <form onSubmit={handleSubmit} className={styles.card}>
          <div className={styles.userHead}>
            <div className={styles.avatar}>
              {(form.name || 'U').charAt(0).toUpperCase()}
            </div>
            <div>
              <h3>{form.name}</h3>
              <span className="clay-badge clay-badge-primary">
                {(session?.user as any)?.role || 'Owner'} Account
              </span>
            </div>
          </div>

          <div className={styles.formGrid}>
            <div className="clay-input-group">
              <label className="clay-label">Full Name</label>
              <input
                type="text"
                className="clay-input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>

            <div className="clay-input-group">
              <label className="clay-label">Email Address</label>
              <input
                type="email"
                className="clay-input"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
            </div>

            <div className="clay-input-group">
              <label className="clay-label">Phone Number</label>
              <input
                type="text"
                className="clay-input"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>

            <div className="clay-input-group">
              <label className="clay-label">Establishment / Firm Name</label>
              <input
                type="text"
                className="clay-input"
                value={form.organizationName}
                onChange={(e) => setForm({ ...form, organizationName: e.target.value })}
              />
            </div>

            <div className="clay-input-group">
              <label className="clay-label">State Jurisdiction</label>
              <input
                type="text"
                className="clay-input"
                value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
              />
            </div>

            <div className="clay-input-group">
              <label className="clay-label">District Jurisdiction</label>
              <input
                type="text"
                className="clay-input"
                value={form.district}
                onChange={(e) => setForm({ ...form, district: e.target.value })}
              />
            </div>
          </div>

          <div className={styles.actions}>
            <button type="submit" className="clay-btn clay-btn-primary">
              <Save size={18} /> Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
