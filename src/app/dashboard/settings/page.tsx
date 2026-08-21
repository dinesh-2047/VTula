'use client';

import { useState } from 'react';
import { Settings, Shield, Bell, Save, CheckCircle } from 'lucide-react';
import styles from './settings.module.css';

export default function SettingsPage() {
  const [saved, setSaved] = useState(false);
  const [settings, setSettings] = useState({
    emailNotifs: true,
    smsNotifs: true,
    whatappNotifs: true,
    twoFactor: true,
  });

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>System & Notification Settings</h1>
          <p>Configure automated WhatsApp/SMS alerts, security parameters, and portal preferences.</p>
        </div>
      </div>

      <div className={styles.container}>
        {saved && (
          <div className={styles.successBanner}>
            <CheckCircle size={18} /> System settings saved successfully.
          </div>
        )}

        <form onSubmit={handleSave} className={styles.card}>
          <h3 className={styles.sectionTitle}>
            <Bell size={18} /> Notification Preferences
          </h3>

          <div className={styles.toggleRow}>
            <div>
              <strong>WhatsApp Instant Alerts (Meta WhatsApp API)</strong>
              <p>Receive digital certificate links and verification reminders via WhatsApp.</p>
            </div>
            <input
              type="checkbox"
              checked={settings.whatappNotifs}
              onChange={(e) => setSettings({ ...settings, whatappNotifs: e.target.checked })}
            />
          </div>

          <div className={styles.toggleRow}>
            <div>
              <strong>SMS OTP & Alerts (Twilio API)</strong>
              <p>Receive SMS alerts for inspection schedules and login OTP verifications.</p>
            </div>
            <input
              type="checkbox"
              checked={settings.smsNotifs}
              onChange={(e) => setSettings({ ...settings, smsNotifs: e.target.checked })}
            />
          </div>

          <h3 className={styles.sectionTitle} style={{ marginTop: 28 }}>
            <Shield size={18} /> Security & Cryptography Settings
          </h3>

          <div className={styles.toggleRow}>
            <div>
              <strong>HMAC Digital Signature Verification</strong>
              <p>Sign every issued certificate with SHA-256 secret key integrity checks.</p>
            </div>
            <input
              type="checkbox"
              checked={settings.twoFactor}
              onChange={(e) => setSettings({ ...settings, twoFactor: e.target.checked })}
            />
          </div>

          <div className={styles.actions}>
            <button type="submit" className="clay-btn clay-btn-primary">
              <Save size={18} /> Save Preferences
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
