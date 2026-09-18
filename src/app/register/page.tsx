'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Shield,
  User,
  Mail,
  Lock,
  Phone,
  MapPin,
  Building2,
  ArrowRight,
  ArrowLeft,
  Loader2,
  CheckCircle,
  Scale,
  UserCheck,
  Eye,
  EyeOff,
} from 'lucide-react';
// `constants`, not `utils` — the latter imports `node:crypto` and reads the
// certificate signing secret, neither of which belongs in a browser bundle.
import { INDIAN_STATES } from '@/lib/constants';
import { districtsFor } from '@/lib/districts';
import styles from './register.module.css';

const ROLES = [
  { value: 'Owner', label: 'Instrument Owner / Trader', icon: Scale, desc: 'Register and manage your commercial instruments' },
  { value: 'LMO', label: 'Legal Metrology Officer', icon: UserCheck, desc: 'Inspect and certify instruments in your jurisdiction' },
  { value: 'GATC', label: 'Test Centre (GATC)', icon: Building2, desc: 'Calibrate and test specialized instruments' },
];

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    phone: '',
    role: 'Owner',
    state: '',
    district: '',
    organizationName: '',
  });

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setError('');
  };

  // Derived, never stored twice: the district list is whatever the chosen state has.
  const districts = useMemo(() => districtsFor(formData.state), [formData.state]);

  const handleNext = () => {
    if (step === 1) {
      if (!formData.name || !formData.email || !formData.password) {
        setError('Please fill all required fields');
        return;
      }
      if (formData.password.length < 8) {
        setError('Password must be at least 8 characters');
        return;
      }
      if (formData.password !== formData.confirmPassword) {
        setError('Passwords do not match');
        return;
      }
    }
    setStep((s) => s + 1);
    setError('');
  };

  const handleSubmit = async () => {
    /*
     * State and district are checked here rather than only on the server because
     * they decide which office ever sees this account. A registration that lands
     * without a jurisdiction is not a broken record — it is a business whose
     * applications quietly reach nobody.
     */
    if (!formData.state || !formData.district) {
      setError('Choose your state and district — they decide which office handles your work.');
      return;
    }
    if (formData.role === 'GATC' && !formData.organizationName.trim()) {
      setError('A test centre account needs the centre name.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (data.success) {
        setStep(4); // Success step
      } else {
        setError(data.error || 'Registration failed');
      }
    } catch {
      setError('Something went wrong. Please try again.');
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
          {/* Progress Steps */}
          {step < 4 && (
            <div className={styles.progress}>
              {[1, 2, 3].map((s) => (
                <div
                  key={s}
                  className={`${styles.progressStep} ${step >= s ? styles.progressActive : ''} ${step > s ? styles.progressDone : ''}`}
                >
                  {step > s ? <CheckCircle size={18} /> : <span>{s}</span>}
                </div>
              ))}
              <div className={styles.progressLine}>
                <div className={styles.progressFill} style={{ width: `${((step - 1) / 2) * 100}%` }} />
              </div>
            </div>
          )}

          {/* Step 1: Basic Info */}
          {step === 1 && (
            <>
              <div className={styles.stepHeader}>
                <h2>Create Your Account</h2>
                <p>Enter your basic information</p>
              </div>

              <div className={styles.form}>
                <div className="clay-input-group">
                  <label className="clay-label">Full Name *</label>
                  <div className={styles.inputIcon}>
                    <User size={18} className={styles.inputIconSvg} />
                    <input
                      type="text"
                      className="clay-input"
                      placeholder="Enter your full name"
                      value={formData.name}
                      onChange={(e) => updateField('name', e.target.value)}
                      required
                      style={{ paddingLeft: 44 }}
                    />
                  </div>
                </div>

                <div className="clay-input-group">
                  <label className="clay-label">Email Address *</label>
                  <div className={styles.inputIcon}>
                    <Mail size={18} className={styles.inputIconSvg} />
                    <input
                      type="email"
                      className="clay-input"
                      placeholder="you@example.com"
                      value={formData.email}
                      onChange={(e) => updateField('email', e.target.value)}
                      required
                      style={{ paddingLeft: 44 }}
                    />
                  </div>
                </div>

                <div className="clay-input-group">
                  <label className="clay-label">Password *</label>
                  <div className={styles.inputIcon}>
                    <Lock size={18} className={styles.inputIconSvg} />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className="clay-input"
                      placeholder="Min 8 characters"
                      value={formData.password}
                      onChange={(e) => updateField('password', e.target.value)}
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

                <div className="clay-input-group">
                  <label className="clay-label">Confirm Password *</label>
                  <div className={styles.inputIcon}>
                    <Lock size={18} className={styles.inputIconSvg} />
                    <input
                      type="password"
                      className="clay-input"
                      placeholder="Repeat your password"
                      value={formData.confirmPassword}
                      onChange={(e) => updateField('confirmPassword', e.target.value)}
                      required
                      style={{ paddingLeft: 44 }}
                    />
                  </div>
                </div>

                <div className="clay-input-group">
                  <label className="clay-label">Phone Number</label>
                  <div className={styles.inputIcon}>
                    <Phone size={18} className={styles.inputIconSvg} />
                    <input
                      type="tel"
                      className="clay-input"
                      placeholder="+91 98765 43210"
                      value={formData.phone}
                      onChange={(e) => updateField('phone', e.target.value)}
                      style={{ paddingLeft: 44 }}
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Step 2: Role Selection */}
          {step === 2 && (
            <>
              <div className={styles.stepHeader}>
                <h2>Select Your Role</h2>
                <p>Choose how you&apos;ll use VTULA</p>
              </div>

              <div className={styles.roleGrid}>
                {ROLES.map((role) => (
                  <button
                    key={role.value}
                    className={`${styles.roleCard} ${formData.role === role.value ? styles.roleActive : ''}`}
                    onClick={() => updateField('role', role.value)}
                  >
                    <div className={styles.roleIcon}>
                      <role.icon size={28} />
                    </div>
                    <h4>{role.label}</h4>
                    <p>{role.desc}</p>
                    {formData.role === role.value && (
                      <div className={styles.roleCheck}>
                        <CheckCircle size={20} />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Step 3: Location & Details */}
          {step === 3 && (
            <>
              <div className={styles.stepHeader}>
                <h2>Location Details</h2>
                <p>Help us connect you with your local jurisdiction</p>
              </div>

              <div className={styles.form}>
                <div className="clay-input-group">
                  <label className="clay-label">State *</label>
                  <div className={styles.inputIcon}>
                    <MapPin size={18} className={styles.inputIconSvg} />
                    <select
                      className="clay-input clay-select"
                      value={formData.state}
                      onChange={(e) => {
                        /*
                         * Changing the state has to clear the district. Leaving
                         * "Shimla" selected under Kerala would file the account
                         * into a jurisdiction that does not exist, and
                         * `scopeFilter` matches the string exactly — nobody's
                         * queue would ever show it.
                         */
                        setFormData((prev) => ({
                          ...prev,
                          state: e.target.value,
                          district: '',
                        }));
                        setError('');
                      }}
                      style={{ paddingLeft: 44 }}
                    >
                      <option value="">Select State</option>
                      {INDIAN_STATES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="clay-input-group">
                  <label className="clay-label">District *</label>
                  <div className={styles.inputIcon}>
                    <MapPin size={18} className={styles.inputIconSvg} />
                    <select
                      className="clay-input clay-select"
                      value={formData.district}
                      disabled={districts.length === 0}
                      onChange={(e) => updateField('district', e.target.value)}
                      style={{ paddingLeft: 44 }}
                    >
                      <option value="">
                        {formData.state ? 'Select District' : 'Choose a state first'}
                      </option>
                      {districts.map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                  <span className={styles.fieldHint}>
                    Your district decides which Legal Metrology office handles your applications.
                  </span>
                </div>

                {formData.role === 'GATC' && (
                  <div className="clay-input-group">
                    <label className="clay-label">Organization Name *</label>
                    <div className={styles.inputIcon}>
                      <Building2 size={18} className={styles.inputIconSvg} />
                      <input
                        type="text"
                        className="clay-input"
                        placeholder="Your test centre name"
                        value={formData.organizationName}
                        onChange={(e) => updateField('organizationName', e.target.value)}
                        style={{ paddingLeft: 44 }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Step 4: Success */}
          {step === 4 && (
            <div className={styles.success}>
              <div className={styles.successIcon}>
                <CheckCircle size={48} />
              </div>
              <h2>Registration Successful!</h2>
              <p>Your account has been created. Sign in to get started.</p>
              <button
                className="clay-btn clay-btn-primary clay-btn-lg w-full"
                onClick={() => router.push('/login')}
              >
                Go to Sign In
                <ArrowRight size={18} />
              </button>
            </div>
          )}

          {/* Error */}
          {error && <div className={styles.error}>{error}</div>}

          {/* Navigation */}
          {step < 4 && (
            <div className={styles.actions}>
              {step > 1 && (
                <button className="clay-btn clay-btn-ghost" onClick={() => setStep((s) => s - 1)}>
                  <ArrowLeft size={16} />
                  Back
                </button>
              )}
              <div style={{ flex: 1 }} />
              {step < 3 ? (
                <button className="clay-btn clay-btn-primary" onClick={handleNext}>
                  Continue
                  <ArrowRight size={16} />
                </button>
              ) : (
                <button
                  className="clay-btn clay-btn-primary"
                  onClick={handleSubmit}
                  disabled={loading}
                >
                  {loading ? <Loader2 size={18} className={styles.spin} /> : null}
                  {loading ? 'Creating...' : 'Create Account'}
                  {!loading && <ArrowRight size={16} />}
                </button>
              )}
            </div>
          )}

          {step === 1 && (
            <>
              <div className={styles.divider}>
                <span>Already have an account?</span>
              </div>
              <Link href="/login" className="clay-btn clay-btn-outline w-full">
                Sign In Instead
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
