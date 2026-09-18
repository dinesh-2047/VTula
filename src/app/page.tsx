'use client';

import { useCallback, useEffect, useState } from 'react';
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

/** Shape of `GET /api/public/stats`. */
interface PublicStats {
  instruments: number;
  verifiedInstruments: number;
  certificates: number;
  activeCertificates: number;
  statesCovered: number;
  publicVerifications: number;
  officers: number;
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
    desc: 'Mobile-first inspection forms with GPS-tagged photos and tamper-proof evidence hashed on upload.',
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  /*
   * Starts empty rather than seeded. The previous version initialised these to
   * 124 instruments / 28 states / 98 certificates / 34 officers and then tried to
   * replace two of them by calling `/api/instruments` and `/api/certificates` —
   * endpoints that require a session, so an unauthenticated visitor got 401 and
   * kept the invented figures. And where the call did succeed it read `.length`
   * of one paginated page and printed it as a national total.
   *
   * `/api/public/stats` counts the collections server-side and needs no session.
   * If it cannot be reached the section is not rendered at all: a blank space is
   * honest, a made-up number is not.
   */
  const [stats, setStats] = useState<StatItem[] | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/public/stats');
      const data = (await res.json()) as { success: boolean; stats?: PublicStats };
      if (!data.success || !data.stats) return;

      const s = data.stats;
      setStats([
        { label: 'Instruments on the register', value: s.instruments, suffix: '' },
        { label: 'Certificates issued', value: s.certificates, suffix: '' },
        { label: 'States & UTs covered', value: s.statesCovered, suffix: '' },
        { label: 'Public QR verifications', value: s.publicVerifications, suffix: '' },
      ]);
    } catch {
      // Left null — the stats band simply does not render.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await fetchStats();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchStats]);

  const isLoggedIn = status === 'authenticated' && !!session?.user;
  const userRole = session?.user?.role ?? 'Owner';

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
      <section className={styles.hero}>
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

          {/*
            * A sentence rather than a third button. The two buttons above are for
            * people who came here on purpose; this is for the person who arrived
            * angry after being short-weighed and needs to be told, in plain words,
            * that there is somewhere to say so and it costs them nothing.
            */}
          <p className={styles.heroComplain}>
            Given less than you paid for, or the machine has no sticker?{' '}
            <Link href="/complaint">File a complaint</Link> — no account needed, and the shop is
            never told who reported it.
          </p>

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
              {/* An illustration of what a verified certificate looks like, not a
                  record — labelled so nobody tries to verify this number. */}
              <div className={styles.heroCardTitle}>Example certificate</div>
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
      {stats && (
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
      )}

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
            <Link href="/complaint">File a Complaint</Link>
            <Link href="/complaint/track">Track a Complaint</Link>
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
