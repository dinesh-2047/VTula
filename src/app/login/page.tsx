'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Shield, Mail, Lock, Phone, ArrowRight, Loader2, Eye, EyeOff } from 'lucide-react';
import styles from './login.module.css';

type LoginTab = 'email' | 'phone';

export default function LoginPage() {
  const router = useRouter();
  const [tab, setTab] = useState<LoginTab>('email');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Email form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Phone form
  const [phone, setPhone] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await signIn('credentials', {
        email,
        password,
        redirect: false,
      });

      if (res?.error) {
        setError('Invalid email or password');
      } else {
        router.push('/dashboard');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSendOTP = async () => {
    if (!phone) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.startsWith('+') ? phone : `+91${phone}` }),
      });

      const data = await res.json();
      if (data.success) {
        setOtpSent(true);
      } else {
        setError(data.error || 'Failed to send OTP');
      }
    } catch {
      setError('Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const fullPhone = phone.startsWith('+') ? phone : `+91${phone}`;

    try {
      const verifyRes = await fetch('/api/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: fullPhone, code: otp }),
      });

      const verifyData = await verifyRes.json();

      if (verifyData.valid) {
        // Look up user by phone and sign in
        const res = await signIn('phone-otp', {
          phone: fullPhone,
          userId: verifyData.userId,
          redirect: false,
        });

        if (res?.error) {
          setError('No account found with this phone number');
        } else {
          router.push('/dashboard');
        }
      } else {
        setError('Invalid OTP. Please try again.');
      }
    } catch {
      setError('Verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.background}>
        <div className={styles.orb1} />
        <div className={styles.orb2} />
      </div>

      <div className={styles.container}>
        <Link href="/" className={styles.logo}>
          <div className={styles.logoIcon}>
            <Shield size={24} />
          </div>
          <span className={styles.logoText}>VTULA</span>
        </Link>

        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <h2>Welcome Back</h2>
            <p>Sign in to your account to continue</p>
          </div>

          {/* Tabs */}
          <div className="clay-tabs">
            <button
              className={`clay-tab ${tab === 'email' ? 'active' : ''}`}
              onClick={() => { setTab('email'); setError(''); }}
            >
              <Mail size={16} style={{ marginRight: 6 }} />
              Email
            </button>
            <button
              className={`clay-tab ${tab === 'phone' ? 'active' : ''}`}
              onClick={() => { setTab('phone'); setError(''); }}
            >
              <Phone size={16} style={{ marginRight: 6 }} />
              Phone OTP
            </button>
          </div>

          {error && <div className={styles.error}>{error}</div>}

          {/* Email Login */}
          {tab === 'email' && (
            <form onSubmit={handleEmailLogin} className={styles.form}>
              <div className="clay-input-group">
                <label className="clay-label">Email Address</label>
                <div className={styles.inputIcon}>
                  <Mail size={18} className={styles.inputIconSvg} />
                  <input
                    type="email"
                    className="clay-input"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    style={{ paddingLeft: 44 }}
                  />
                </div>
              </div>

              <div className="clay-input-group">
                <label className="clay-label">Password</label>
                <div className={styles.inputIcon}>
                  <Lock size={18} className={styles.inputIconSvg} />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="clay-input"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    style={{ paddingLeft: 44, paddingRight: 44 }}
                  />
                  <button
                    type="button"
                    className={styles.eyeBtn}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                className="clay-btn clay-btn-primary w-full"
                disabled={loading}
                style={{ marginTop: 8 }}
              >
                {loading ? <Loader2 size={18} className={styles.spin} /> : null}
                {loading ? 'Signing in...' : 'Sign In'}
                {!loading && <ArrowRight size={16} />}
              </button>
            </form>
          )}

          {/* Phone OTP Login */}
          {tab === 'phone' && (
            <form onSubmit={handleVerifyOTP} className={styles.form}>
              <div className="clay-input-group">
                <label className="clay-label">Phone Number</label>
                <div className={styles.inputIcon}>
                  <Phone size={18} className={styles.inputIconSvg} />
                  <input
                    type="tel"
                    className="clay-input"
                    placeholder="+91 98765 43210"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                    disabled={otpSent}
                    style={{ paddingLeft: 44 }}
                  />
                </div>
              </div>

              {!otpSent ? (
                <button
                  type="button"
                  className="clay-btn clay-btn-primary w-full"
                  onClick={handleSendOTP}
                  disabled={loading || !phone}
                >
                  {loading ? <Loader2 size={18} className={styles.spin} /> : null}
                  {loading ? 'Sending...' : 'Send OTP'}
                </button>
              ) : (
                <>
                  <div className="clay-input-group">
                    <label className="clay-label">Enter OTP</label>
                    <input
                      type="text"
                      className="clay-input"
                      placeholder="Enter 6-digit code"
                      value={otp}
                      onChange={(e) => setOtp(e.target.value)}
                      maxLength={6}
                      required
                      style={{ textAlign: 'center', letterSpacing: '8px', fontSize: '1.25rem' }}
                    />
                  </div>

                  <button
                    type="submit"
                    className="clay-btn clay-btn-primary w-full"
                    disabled={loading || otp.length < 6}
                  >
                    {loading ? <Loader2 size={18} className={styles.spin} /> : null}
                    {loading ? 'Verifying...' : 'Verify & Sign In'}
                    {!loading && <ArrowRight size={16} />}
                  </button>

                  <button
                    type="button"
                    className="clay-btn clay-btn-ghost w-full"
                    onClick={() => { setOtpSent(false); setOtp(''); }}
                  >
                    Change Number
                  </button>
                </>
              )}
            </form>
          )}

          <div className={styles.divider}>
            <span>Don&apos;t have an account?</span>
          </div>

          <Link href="/register" className="clay-btn clay-btn-outline w-full">
            Create New Account
            <ArrowRight size={16} />
          </Link>
        </div>

        <p className={styles.footerText}>
          Under Legal Metrology Act 2009 · Government of India
        </p>
      </div>
    </div>
  );
}
