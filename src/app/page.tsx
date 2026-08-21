'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import {
  Shield,
  QrCode,
  Bell,
  BarChart3,
  Users,
  FileCheck,
  ArrowRight,
  CheckCircle,
  Scale,
  Building2,
  UserCheck,
  Eye,
  ChevronRight,
  Smartphone,
  Globe,
  Lock,
  Zap,
  Award,
  MapPin,
  LayoutDashboard,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import styles from './page.module.css';

interface StatItem {
  label: string;
  value: number;
  suffix: string;
}

const FEATURES = [
  {
    icon: FileCheck,
    title: 'Smart Application Workflow',
    desc: 'Submit verification applications online with auto-calculated fees, document uploads, and real-time tracking.',
    color: 'var(--color-primary)',
  },
  {
    icon: QrCode,
    title: 'QR-Enabled Digital Certificates',
    desc: 'Cryptographically signed digital certificates with QR codes for instant public verification.',
    color: 'var(--color-secondary)',
  },
  {
    icon: Bell,
    title: 'Smart Notifications',
    desc: 'Automated SMS, WhatsApp, and email alerts for application status, inspections, and expiry reminders.',
    color: 'var(--color-accent-dark)',
  },
  {
    icon: BarChart3,
    title: 'Real-Time Dashboards',
    desc: 'Role-based dashboards with compliance metrics, workload analytics, and regional reporting.',
    color: 'var(--color-charcoal)',
  },
  {
    icon: MapPin,
    title: 'Geo-Tagged Inspections',
    desc: 'Mobile-first inspection forms with GPS-tagged photos, tamper-proof evidence, and offline support.',
    color: '#7BAFD4',
  },
  {
    icon: Lock,
    title: 'Bank-Grade Security',
    desc: 'OWASP-compliant controls, TLS encryption, JWT auth, audit logging, and digital signatures.',
    color: '#CE93D8',
  },
];

const HOW_IT_WORKS = [
  {
    step: 1,
    icon: Users,
    title: 'Register & Add Instruments',
    desc: 'Create your account, register your business instruments with details, photos, and location.',
  },
  {
    step: 2,
    icon: FileCheck,
    title: 'Submit Application',
    desc: 'Apply for initial or re-verification. Upload documents, pay fees, and get your application ID.',
  },
  {
    step: 3,
    icon: UserCheck,
    title: 'Inspection & Verification',
    desc: 'An LMO or GATC is assigned. They inspect your instrument with geo-tagged evidence.',
  },
  {
    step: 4,
    icon: Award,
    title: 'Digital Certificate Issued',
    desc: 'Upon approval, receive a cryptographically signed digital certificate with QR code.',
  },
];

const STAKEHOLDERS = [
  {
    icon: Scale,
    role: 'Instrument Owners',
    desc: 'Register instruments, submit applications, track status, and download digital certificates.',
    color: 'var(--color-primary)',
  },
  {
    icon: UserCheck,
    role: 'Legal Metrology Officers',
    desc: 'View assigned tasks, conduct inspections, capture geo-tagged evidence, and issue certificates.',
    color: 'var(--color-secondary)',
  },
  {
    icon: Building2,
    role: 'Test Centres (GATC)',
    desc: 'Receive lab assignments, run calibration tests, submit digital reports, and sign off results.',
    color: 'var(--color-accent-dark)',
  },
  {
    icon: Eye,
    role: 'Consumers & Public',
    desc: 'Scan any instrument\'s QR code to instantly verify its certification status and authenticity.',
    color: 'var(--color-charcoal)',
  },
];

function AnimatedCounter({ value, suffix }: { value: number; suffix: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let start = 0;
    const duration = 1500;
    const increment = Math.max(1, Math.floor(value / (duration / 16)));
    const timer = setInterval(() => {
      start += increment;
      if (start >= value) {
        setCount(value);
        clearInterval(timer);
      } else {
        setCount(start);
      }
    }, 16);
    return () => clearInterval(timer);
  }, [value]);

  return (
    <span>
      {count.toLocaleString('en-IN')}
      {suffix}
    </span>
  );
}

export default function LandingPage() {
  const { data: session, status } = useSession();
  const [isVisible, setIsVisible] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [stats, setStats] = useState<StatItem[]>([
    { label: 'Instruments Registered', value: 124, suffix: '+' },
    { label: 'States & UTs Covered', value: 28, suffix: '' },
    { label: 'Certificates Issued', value: 98, suffix: '+' },
    { label: 'LMO Officers Active', value: 34, suffix: '+' },
  ]);

  useEffect(() => {
    setIsVisible(true);
    fetchLiveStats();
  }, []);

  const fetchLiveStats = async () => {
    try {
      const [instRes, certRes] = await Promise.all([
        fetch('/api/instruments'),
        fetch('/api/certificates'),
      ]);
      const instData = await instRes.json();
      const certData = await certRes.json();

      const instCount = instData.instruments?.length || 0;
      const certCount = certData.certificates?.length || 0;

      if (instCount > 0 || certCount > 0) {
        setStats([
          { label: 'Instruments Registered', value: Math.max(instCount, 1), suffix: '' },
          { label: 'States Jurisdiction', value: 28, suffix: '' },
          { label: 'Certificates Issued', value: Math.max(certCount, 1), suffix: '' },
          { label: 'Officers Active', value: 12, suffix: '+' },
        ]);
      }
    } catch {
      // Fallback
    }
  };

  const isLoggedIn = status === 'authenticated' && !!session?.user;
  const userName = session?.user?.name || 'User';
  const userRole = (session?.user as any)?.role || 'Owner';

  return (
    <div className={styles.landing}>
      {/* ── Navbar ── */}
      <nav className={styles.navbar}>
        <div className={styles.navContent}>
          <Link href="/" className={styles.logo}>
            <div className={styles.logoIcon}>
              <Shield size={24} />
            </div>
            <span className={styles.logoText}>VTULA</span>
          </Link>

          <div className={styles.navLinks}>
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#stakeholders">For You</a>
            <Link href="/verify" className={styles.navVerify}>
              <QrCode size={16} />
              Verify Certificate
            </Link>
          </div>

          <div className={styles.navActions}>
            {isLoggedIn ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Link href="/dashboard" className="clay-btn clay-btn-primary">
                  <LayoutDashboard size={18} />
                  Dashboard ({userRole})
                </Link>
                <button
                  onClick={() => signOut({ callbackUrl: '/login' })}
                  className="clay-btn clay-btn-ghost"
                  title="Sign Out"
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <LogOut size={16} />
                  Sign Out
                </button>
              </div>
            ) : (
              <>
                <Link href="/login" className="clay-btn clay-btn-ghost">
                  Sign In
                </Link>
                <Link href="/register" className="clay-btn clay-btn-primary">
                  Get Started
                  <ArrowRight size={16} />
                </Link>
              </>
            )}
          </div>

          {/* Mobile Menu Button */}
          <button
            className={styles.mobileMenuBtn}
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle Navigation Menu"
          >
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {/* Mobile Navigation Drawer */}
        {mobileMenuOpen && (
          <div className={styles.mobileDrawer}>
            <a href="#features" onClick={() => setMobileMenuOpen(false)}>Features</a>
            <a href="#how-it-works" onClick={() => setMobileMenuOpen(false)}>How It Works</a>
            <a href="#stakeholders" onClick={() => setMobileMenuOpen(false)}>For You</a>
            <Link href="/verify" className={styles.mobileVerifyBtn} onClick={() => setMobileMenuOpen(false)}>
              <QrCode size={18} /> Verify Certificate
            </Link>
            <div className={styles.mobileDrawerDivider} />
            {isLoggedIn ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
                <Link href="/dashboard" className="clay-btn clay-btn-primary" onClick={() => setMobileMenuOpen(false)} style={{ textAlign: 'center', justifyContent: 'center' }}>
                  <LayoutDashboard size={18} /> Dashboard ({userRole})
                </Link>
                <button
                  onClick={() => {
                    setMobileMenuOpen(false);
                    signOut({ callbackUrl: '/login' });
                  }}
                  className="clay-btn clay-btn-ghost"
                  style={{ justifyContent: 'center' }}
                >
                  <LogOut size={16} /> Sign Out
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
                <Link href="/login" className="clay-btn clay-btn-ghost" onClick={() => setMobileMenuOpen(false)} style={{ textAlign: 'center', justifyContent: 'center' }}>
                  Sign In
                </Link>
                <Link href="/register" className="clay-btn clay-btn-primary" onClick={() => setMobileMenuOpen(false)} style={{ textAlign: 'center', justifyContent: 'center' }}>
                  Get Started <ArrowRight size={16} />
                </Link>
              </div>
            )}
          </div>
        )}
      </nav>

      {/* ── Hero ── */}
      <section className={`${styles.hero} ${isVisible ? styles.heroVisible : ''}`}>
        <div className={styles.heroBackground}>
          <div className={styles.heroOrb1} />
          <div className={styles.heroOrb2} />
          <div className={styles.heroOrb3} />
        </div>

        <div className={styles.heroContent}>
          <div className={styles.heroBadge}>
            <Zap size={14} />
            <span>Under Legal Metrology Act 2009</span>
          </div>

          <h1 className={styles.heroTitle}>
            Digital Verification &<br />
            <span className={styles.heroGradient}>Stamping Platform</span>
          </h1>

          <p className={styles.heroSubtitle}>
            India&apos;s unified system for verifying and certifying commercial weights &amp;
            measures. Submit applications, schedule inspections, and receive QR-enabled
            digital certificates — all in one place.
          </p>

          <div className={styles.heroCta}>
            {isLoggedIn ? (
              <Link href="/dashboard" className="clay-btn clay-btn-primary clay-btn-lg">
                Go to My Dashboard
                <ArrowRight size={18} />
              </Link>
            ) : (
              <Link href="/register" className="clay-btn clay-btn-primary clay-btn-lg">
                Start Free Registration
                <ArrowRight size={18} />
              </Link>
            )}

            <Link href="/verify" className="clay-btn clay-btn-outline clay-btn-lg">
              <QrCode size={18} />
              Verify a Certificate
            </Link>
          </div>

          <div className={styles.heroTrust}>
            <div className={styles.heroTrustItem}>
              <CheckCircle size={16} />
              <span>Government Compliant</span>
            </div>
            <div className={styles.heroTrustItem}>
              <CheckCircle size={16} />
              <span>QR Verified Certificates</span>
            </div>
            <div className={styles.heroTrustItem}>
              <CheckCircle size={16} />
              <span>Pan-India Coverage</span>
            </div>
          </div>
        </div>

        <div className={styles.heroVisual}>
          <div className={styles.heroCard}>
            <div className={styles.heroCardHeader}>
              <div className={styles.heroCardDot} style={{ background: 'var(--status-error)' }} />
              <div className={styles.heroCardDot} style={{ background: 'var(--status-warning)' }} />
              <div className={styles.heroCardDot} style={{ background: 'var(--status-success)' }} />
            </div>
            <div className={styles.heroCardBody}>
              <div className={styles.heroCardTitle}>Certificate CERT-2026-A7X9K2</div>
              <div className={styles.heroCardRow}>
                <span>Status</span>
                <span className={styles.heroCardActive}>● Active</span>
              </div>
              <div className={styles.heroCardRow}>
                <span>Instrument</span>
                <span>Weighing Scale — 50kg</span>
              </div>
              <div className={styles.heroCardRow}>
                <span>Verified</span>
                <span>15 Jul 2026</span>
              </div>
              <div className={styles.heroCardRow}>
                <span>Expires</span>
                <span>14 Jul 2028</span>
              </div>
              <div className={styles.heroCardQr}>
                <QrCode size={80} strokeWidth={1} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className={styles.stats}>
        <div className={styles.statsGrid}>
          {stats.map((stat) => (
            <div key={stat.label} className={styles.statCard}>
              <div className={styles.statValue}>
                <AnimatedCounter value={stat.value} suffix={stat.suffix} />
              </div>
              <div className={styles.statLabel}>{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className={styles.features}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionBadge}>Powerful Features</span>
          <h2>Everything You Need for<br />Legal Metrology Compliance</h2>
          <p>
            From application submission to digital certification — a complete, paperless
            workflow designed for India&apos;s regulatory ecosystem.
          </p>
        </div>

        <div className={styles.featuresGrid}>
          {FEATURES.map((feature) => (
            <div key={feature.title} className={styles.featureCard}>
              <div
                className={styles.featureIcon}
                style={{ background: `${feature.color}15`, color: feature.color }}
              >
                <feature.icon size={24} />
              </div>
              <h4>{feature.title}</h4>
              <p>{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How It Works ── */}
      <section id="how-it-works" className={styles.howItWorks}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionBadge}>Simple Process</span>
          <h2>How VTULA Works</h2>
          <p>Four simple steps from registration to certification.</p>
        </div>

        <div className={styles.stepsGrid}>
          {HOW_IT_WORKS.map((item) => (
            <div key={item.step} className={styles.stepCard}>
              <div className={styles.stepNumber}>{item.step}</div>
              <div className={styles.stepIcon}>
                <item.icon size={28} />
              </div>
              <h4>{item.title}</h4>
              <p>{item.desc}</p>
              {item.step < 4 && (
                <div className={styles.stepArrow}>
                  <ChevronRight size={20} />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Stakeholders ── */}
      <section id="stakeholders" className={styles.stakeholders}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionBadge}>For Everyone</span>
          <h2>Built for All Stakeholders</h2>
          <p>Role-based interfaces tailored for every participant in the ecosystem.</p>
        </div>

        <div className={styles.stakeholdersGrid}>
          {STAKEHOLDERS.map((s) => (
            <div key={s.role} className={styles.stakeholderCard}>
              <div
                className={styles.stakeholderIcon}
                style={{ background: `${s.color}12`, color: s.color }}
              >
                <s.icon size={32} />
              </div>
              <h4>{s.role}</h4>
              <p>{s.desc}</p>
              <Link href={isLoggedIn ? "/dashboard" : "/register"} className={styles.stakeholderLink}>
                {isLoggedIn ? "Go to Dashboard" : "Get Started"} <ArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section className={styles.cta}>
        <div className={styles.ctaContent}>
          <div className={styles.ctaIcons}>
            <Smartphone size={20} />
            <Globe size={20} />
            <Shield size={20} />
          </div>
          <h2>Ready to Go Digital?</h2>
          <p>
            Join thousands of instrument owners, officers, and test centres already using
            VTULA for seamless legal metrology compliance.
          </p>
          <div className={styles.ctaActions}>
            {isLoggedIn ? (
              <Link href="/dashboard" className="clay-btn clay-btn-charcoal clay-btn-lg">
                Go to My Dashboard
                <ArrowRight size={18} />
              </Link>
            ) : (
              <Link href="/register" className="clay-btn clay-btn-charcoal clay-btn-lg">
                Create Free Account
                <ArrowRight size={18} />
              </Link>
            )}

            <Link href="/verify" className="clay-btn clay-btn-ghost clay-btn-lg" style={{ color: '#fff', borderColor: 'rgba(255,255,255,0.3)' }}>
              <QrCode size={18} />
              Verify Certificate
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className={styles.footer}>
        <div className={styles.footerContent}>
          <div className={styles.footerBrand}>
            <div className={styles.logo}>
              <div className={styles.logoIcon}>
                <Shield size={20} />
              </div>
              <span className={styles.logoText}>VTULA</span>
            </div>
            <p>
              India&apos;s unified digital platform for legal metrology verification and
              stamping under the Legal Metrology Act 2009.
            </p>
          </div>
          <div className={styles.footerLinks}>
            <h5>Platform</h5>
            <Link href={isLoggedIn ? "/dashboard" : "/login"}>
              {isLoggedIn ? "Dashboard" : "Sign In"}
            </Link>
            <Link href="/register">Register</Link>
            <Link href="/verify">Verify Certificate</Link>
          </div>
          <div className={styles.footerLinks}>
            <h5>Resources</h5>
            <a href="#">Documentation</a>
            <a href="#">API Reference</a>
            <a href="#">Help Center</a>
          </div>
          <div className={styles.footerLinks}>
            <h5>Legal</h5>
            <a href="#">Privacy Policy</a>
            <a href="#">Terms of Service</a>
            <a href="#">Data Protection</a>
          </div>
        </div>
        <div className={styles.footerBottom}>
          <p>© {new Date().getFullYear()} VTULA. Built for India&apos;s Legal Metrology ecosystem.</p>
        </div>
      </footer>
    </div>
  );
}
