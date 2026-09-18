'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import {
  Shield,
  LayoutDashboard,
  Scale,
  FileText,
  Award,
  Bell,
  Settings,
  LogOut,
  Menu,
  X,
  Search,
  ChevronDown,
  Users,
  BarChart3,
  ClipboardCheck,
  Building2,
  QrCode,
  UserCog,
  Gavel,
  Gauge,
  ShieldAlert,
  Megaphone,
  Siren,
  CalendarDays,
} from 'lucide-react';
import Providers from '@/components/Providers';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { useLocale } from '@/components/LocaleProvider';
import { ROLE_LABELS, looksLikeCertNo, type Role } from '@/lib/constants';
import { isLocale, type TranslationKey } from '@/lib/i18n';
import styles from './dashboard.module.css';

/**
 * The shell every dashboard page renders inside.
 *
 * Four things in here were not what they appeared to be.
 *
 * The unread dot beside the bell was an unconditional `<span>`. It was painted on
 * every page load whether or not anything was unread, and it never went away after
 * the inbox was read — so it carried no information at all, while looking exactly
 * like the thing that does. It now shows a count fetched from the notifications
 * route, and shows nothing when the count is zero.
 *
 * The topbar search box had no `onChange`, no `onSubmit` and no surrounding form.
 * Typing into it did nothing and pressing Enter did nothing. Its placeholder also
 * promised more than the API offers: application search matches the application
 * *number* only — deliberately, since searching owner names there would let an
 * officer probe for businesses outside their jurisdiction by trial and error — so
 * the placeholder now says what can actually be found.
 *
 * `NAV_ITEMS` had entries for four roles out of six. `StateAdmin` and
 * `GATCTechnician` fell through `NAV_ITEMS[userRole] || NAV_ITEMS.Owner` to the
 * *Owner* menu, so a State Administrator was shown "My Instruments" and given no
 * link to Reports or User Management — the two things the role exists to do. The
 * map is now keyed by `Role`, which makes a missing role a compile error here
 * rather than a wrong menu in production.
 *
 * And every label was an English literal. The settings page offered a choice of
 * Hindi, saved it, and nothing in the interface changed — including this menu, which
 * is the part of the product a field officer looks at most. Labels are now dictionary
 * keys and the language switcher lives in the topbar, where it is reachable without
 * first knowing the English word "Settings".
 */

interface NavItem {
  href: string;
  /**
   * The dictionary key, not the words.
   *
   * Typed as `TranslationKey`, so a menu entry naming a string that has no Hindi
   * translation fails the build here instead of rendering the raw key into a
   * sidebar.
   */
  labelKey: TranslationKey;
  icon: React.ComponentType<{ size?: number }>;
}

/*
 * Keyed by `Role`, not `string`. Adding a seventh role to `constants.ts` now fails
 * the build until its menu is written, which is the behaviour the old `|| Owner`
 * fallback quietly replaced with a wrong answer.
 *
 * Settings appears for everyone: it holds personal notification and language
 * preferences, not system configuration, and it used to be reachable from the
 * sidebar only if you happened to be an administrator.
 *
 * Risk Findings and Enforcement sit between the registers and Reports, in the
 * order an officer works: the registers are what exists, Compliance Health ranks
 * who needs attention, the risk queue is what looks wrong, enforcement is what is
 * being done about it, and Reports is the account of it afterwards. Both of the
 * last two gate themselves server-side — the placement here is about being
 * findable, not about being permitted.
 *
 * Compliance Health is the one link deliberately absent from the two GATC menus.
 * `/api/compliance` refuses a testing centre outright: a laboratory supervises
 * instruments assigned to it, not businesses, and offering the link would only
 * lead to a 403.
 */
const NAV_ITEMS: Record<Role, NavItem[]> = {
  Owner: [
    { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
    { href: '/dashboard/instruments', labelKey: 'nav.myInstruments', icon: Scale },
    { href: '/dashboard/applications', labelKey: 'nav.applications', icon: FileText },
    /*
     * Every role gets this link, which is unusual here — most entries are one
     * role's job. A booked inspection has two parties and both of them have
     * something to do with it: the business has to have the instrument and an
     * authorised person on site, and the inspector has to travel. Withholding the
     * link from either side is what made `PATCH /api/schedules` unreachable for
     * both, despite it having accepted an owner reschedule from the beginning.
     */
    { href: '/dashboard/schedule', labelKey: 'nav.inspectionVisits', icon: CalendarDays },
    { href: '/dashboard/certificates', labelKey: 'nav.certificates', icon: Award },
    { href: '/dashboard/compliance', labelKey: 'nav.compliance', icon: Gauge },
    { href: '/dashboard/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/dashboard/settings', labelKey: 'nav.settings', icon: Settings },
  ],
  LMO: [
    { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
    { href: '/dashboard/tasks', labelKey: 'nav.inspectionTasks', icon: ClipboardCheck },
    // Next to the queue, because they answer different questions about the same
    // work: the queue is what is outstanding, the schedule is what day it happens.
    { href: '/dashboard/schedule', labelKey: 'nav.schedule', icon: CalendarDays },
    { href: '/dashboard/applications', labelKey: 'nav.applications', icon: FileText },
    { href: '/dashboard/instruments', labelKey: 'nav.instruments', icon: Scale },
    { href: '/dashboard/certificates', labelKey: 'nav.certificates', icon: Award },
    { href: '/dashboard/compliance', labelKey: 'nav.compliance', icon: Gauge },
    { href: '/dashboard/risk', labelKey: 'nav.risk', icon: ShieldAlert },
    /*
     * Above enforcement, not beside it. A public complaint is what arrives on its
     * own; an enforcement case is what an officer decides to open. Reading order
     * should match that — the inbox before the file it may become.
     */
    { href: '/dashboard/complaints', labelKey: 'nav.complaints', icon: Megaphone },
    { href: '/dashboard/enforcement', labelKey: 'nav.enforcement', icon: Siren },
    { href: '/dashboard/reports', labelKey: 'nav.reports', icon: BarChart3 },
    { href: '/dashboard/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/dashboard/settings', labelKey: 'nav.settings', icon: Settings },
  ],
  // A GATC centre's work arrives as assigned tasks, so the task queue is the
  // register — there is no separate applications view that would show them
  // anything their queue does not.
  GATC: [
    { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
    { href: '/dashboard/tasks', labelKey: 'nav.labTasks', icon: ClipboardCheck },
    // A centre appears here too: `Schedule.assignedToRole` can be GATC or
    // GATCTechnician, so a lab is a party to the appointment and not just a
    // recipient of samples.
    { href: '/dashboard/schedule', labelKey: 'nav.schedule', icon: CalendarDays },
    { href: '/dashboard/instruments', labelKey: 'nav.instruments', icon: Scale },
    { href: '/dashboard/certificates', labelKey: 'nav.certificates', icon: Award },
    { href: '/dashboard/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/dashboard/settings', labelKey: 'nav.settings', icon: Settings },
  ],
  GATCTechnician: [
    { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
    { href: '/dashboard/tasks', labelKey: 'nav.labTasks', icon: ClipboardCheck },
    { href: '/dashboard/schedule', labelKey: 'nav.schedule', icon: CalendarDays },
    { href: '/dashboard/instruments', labelKey: 'nav.instruments', icon: Scale },
    { href: '/dashboard/certificates', labelKey: 'nav.certificates', icon: Award },
    { href: '/dashboard/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/dashboard/settings', labelKey: 'nav.settings', icon: Settings },
  ],
  // Same menu as a system Admin. The difference between the two is enforced by
  // `scopeFilter` on every route, not by hiding links: a StateAdmin who opens
  // Reports sees their own state's figures, not the nation's.
  StateAdmin: [
    { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
    { href: '/dashboard/users', labelKey: 'nav.users', icon: Users },
    { href: '/dashboard/applications', labelKey: 'nav.applications', icon: FileText },
    { href: '/dashboard/instruments', labelKey: 'nav.instruments', icon: Scale },
    { href: '/dashboard/certificates', labelKey: 'nav.certificates', icon: Award },
    // An administrator's use of the calendar is workload, not their own diary: it is
    // the view that shows a Tuesday with four visits and a Wednesday with none.
    { href: '/dashboard/schedule', labelKey: 'nav.inspectionSchedule', icon: CalendarDays },
    { href: '/dashboard/gatc', labelKey: 'nav.gatc', icon: Building2 },
    { href: '/dashboard/compliance', labelKey: 'nav.compliance', icon: Gauge },
    { href: '/dashboard/risk', labelKey: 'nav.risk', icon: ShieldAlert },
    { href: '/dashboard/complaints', labelKey: 'nav.complaints', icon: Megaphone },
    { href: '/dashboard/enforcement', labelKey: 'nav.enforcement', icon: Siren },
    { href: '/dashboard/rules', labelKey: 'nav.rules', icon: Gavel },
    { href: '/dashboard/reports', labelKey: 'nav.reports', icon: BarChart3 },
    { href: '/dashboard/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/dashboard/settings', labelKey: 'nav.settings', icon: Settings },
  ],
  Admin: [
    { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
    { href: '/dashboard/users', labelKey: 'nav.users', icon: Users },
    { href: '/dashboard/applications', labelKey: 'nav.allApplications', icon: FileText },
    { href: '/dashboard/instruments', labelKey: 'nav.allInstruments', icon: Scale },
    { href: '/dashboard/certificates', labelKey: 'nav.allCertificates', icon: Award },
    { href: '/dashboard/schedule', labelKey: 'nav.inspectionSchedule', icon: CalendarDays },
    { href: '/dashboard/gatc', labelKey: 'nav.gatc', icon: Building2 },
    { href: '/dashboard/compliance', labelKey: 'nav.compliance', icon: Gauge },
    { href: '/dashboard/risk', labelKey: 'nav.risk', icon: ShieldAlert },
    { href: '/dashboard/complaints', labelKey: 'nav.complaints', icon: Megaphone },
    { href: '/dashboard/enforcement', labelKey: 'nav.enforcement', icon: Siren },
    { href: '/dashboard/rules', labelKey: 'nav.rules', icon: Gavel },
    { href: '/dashboard/reports', labelKey: 'nav.reportsAnalytics', icon: BarChart3 },
    { href: '/dashboard/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/dashboard/settings', labelKey: 'nav.settings', icon: Settings },
  ],
};

/** Prefixes that identify a record type but have no register page to search yet. */
const NO_REGISTER_YET: Record<string, TranslationKey> = {
  'VT-INSP-': 'search.noteInspection',
  'VT-SEAL-': 'search.noteSeal',
};

type Resolved = { href: string } | { noteKey: TranslationKey } | null;

/**
 * Turns whatever was typed into the register that can actually answer it.
 *
 * The identifier prefixes in `src/lib/ids.ts` are fixed and unique per record type,
 * so a pasted number needs no lookup to route. Anything else is treated as free
 * text and sent to the instruments register, because that is the only search on
 * the API that matches free text — serial number, brand and model. Sending it to
 * applications instead would return nothing and look like an empty database.
 *
 * Returns a key rather than a sentence: this runs outside a component, where there is
 * no locale to translate against, and the caller has one.
 */
function resolveSearch(raw: string): Resolved {
  const q = raw.trim();
  if (!q) return null;
  const upper = q.toUpperCase();
  const query = encodeURIComponent(q);

  for (const [prefix, noteKey] of Object.entries(NO_REGISTER_YET)) {
    if (upper.startsWith(prefix)) return { noteKey };
  }
  if (upper.startsWith('VT-APP-')) return { href: `/dashboard/applications?search=${query}` };
  /*
   * A case number is very often being read off a complainant's reference or an
   * officer's notification, so it may well belong to a case that is already closed.
   * The register widens its own status scope when it is given a `?search=`, which is
   * why this routes there rather than to a filtered view.
   */
  if (upper.startsWith('VT-ENF-')) return { href: `/dashboard/enforcement?search=${query}` };
  // `looksLikeCertNo` also accepts the legacy `CERT-YYYY-XXXXXX` and `LMO-CERT-…`
  // shapes, so a number off an older certificate still routes correctly.
  if (upper.startsWith('VT-CERT-') || looksLikeCertNo(q)) {
    return { href: `/dashboard/certificates?search=${query}` };
  }
  return { href: `/dashboard/instruments?search=${query}` };
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const { t, chosen, adoptLocale } = useLocale();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchNote, setSearchNote] = useState<TranslationKey | null>(null);
  const [unread, setUnread] = useState(0);
  const profileRef = useRef<HTMLDivElement>(null);

  const userRole: Role = session?.user?.role ?? 'Owner';
  const navItems = NAV_ITEMS[userRole];
  const userName = session?.user?.name || 'User';
  const userInitial = userName.charAt(0).toUpperCase();

  /*
   * `limit=1` because only the count is wanted — the route returns `unreadCount`
   * over the whole inbox regardless of how many rows come back, so there is no
   * reason to transfer fifty notifications to render a dot.
   */
  const fetchUnread = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?unread=true&limit=1');
      if (!res.ok) return;
      const data = (await res.json()) as { success: boolean; unreadCount?: number };
      if (data.success) setUnread(data.unreadCount ?? 0);
    } catch {
      // A failed count leaves the badge as it was. Guessing a number here is how
      // the old unconditional dot came to mean nothing.
    }
  }, []);

  /**
   * Picks up the language saved on the account, for a device that has not chosen.
   *
   * A user who sets Hindi on their office desktop and then signs in on a phone would
   * otherwise get English there, because the choice lives in a cookie. This asks the
   * server once — only when no cookie exists, and only inside the dashboard, since for
   * an anonymous visitor to the public pages the request could only ever be a 401.
   * `adoptLocale` rather than `setLocale`, so reading the value does not write it
   * straight back.
   */
  const adoptSavedLocale = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const data = (await res.json()) as {
        success: boolean;
        preferences?: { language?: unknown };
      };
      const saved = data.preferences?.language;
      if (isLocale(saved)) adoptLocale(saved);
    } catch {
      // English is the default and remains a readable answer.
    }
  }, [adoptLocale]);

  useEffect(() => {
    if (status !== 'authenticated' || chosen) return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await adoptSavedLocale();
    })();
    return () => {
      cancelled = true;
    };
  }, [status, chosen, adoptSavedLocale]);

  /*
   * Re-read on navigation rather than on a timer. Opening the inbox is the action
   * that changes this number, and that is a navigation — so the badge clears when
   * it should without holding a poll open on every page in the app.
   */
  useEffect(() => {
    if (status !== 'authenticated') return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await fetchUnread();
    })();
    return () => {
      cancelled = true;
    };
  }, [status, pathname, fetchUnread]);

  /* The dropdown used to stay open until its own button was clicked again. */
  useEffect(() => {
    if (!profileOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!profileRef.current?.contains(e.target as Node)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [profileOpen]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const resolved = resolveSearch(query);
    if (!resolved) return;
    if ('noteKey' in resolved) {
      setSearchNote(resolved.noteKey);
      return;
    }
    setSearchNote(null);
    setQuery('');
    router.push(resolved.href);
  };

  return (
    <div className={styles.layout}>
      {/* Sidebar Overlay (mobile) */}
      {sidebarOpen && (
        <div className={styles.overlay} onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.sidebarHeader}>
          <Link href="/" className={styles.logo}>
            <div className={styles.logoIcon}>
              <Shield size={20} />
            </div>
            <span className={styles.logoText}>VTULA</span>
          </Link>
          <button
            className={styles.closeSidebar}
            onClick={() => setSidebarOpen(false)}
            aria-label={t('nav.closeMenu')}
          >
            <X size={20} />
          </button>
        </div>

        {/*
         * The full role name rather than the enum value: "StateAdmin" is a database
         * token, and this badge is read by the person whose role it is.
         */}
        <div className={styles.roleBadge}>
          <span>{ROLE_LABELS[userRole]}</span>
        </div>

        <nav className={styles.nav}>
          {navItems.map((item) => {
            /*
             * Prefix match, so /dashboard/instruments/new keeps its parent
             * highlighted. `/dashboard` itself has to be exact or it would match
             * every page in the app.
             */
            const isActive =
              item.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem} ${isActive ? styles.navActive : ''}`}
                onClick={() => setSidebarOpen(false)}
              >
                <item.icon size={20} />
                <span>{t(item.labelKey)}</span>
                {item.href === '/dashboard/notifications' && unread > 0 && (
                  <span className={styles.navCount}>{unread > 99 ? '99+' : unread}</span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className={styles.sidebarFooter}>
          <Link href="/verify" className={styles.verifyLink}>
            <QrCode size={18} />
            <span>{t('nav.publicVerify')}</span>
          </Link>
          <button
            className={styles.logoutBtn}
            onClick={() => signOut({ callbackUrl: '/login' })}
          >
            <LogOut size={18} />
            <span>{t('nav.signOut')}</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className={styles.main}>
        {/* Topbar */}
        <header className={styles.topbar}>
          <div className={styles.topbarLeft}>
            <button
              className={styles.menuBtn}
              onClick={() => setSidebarOpen(true)}
              aria-label={t('nav.openMenu')}
            >
              <Menu size={22} />
            </button>
            {/*
             * A real form, so Enter submits. The placeholder lists only what the
             * API can match: serial, brand and model on the instruments register,
             * and exact-ish numbers for applications and certificates.
             */}
            <form className={styles.searchWrap} onSubmit={onSearch} role="search">
              <div className={styles.searchBar}>
                <Search size={18} />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    if (searchNote) setSearchNote(null);
                  }}
                  placeholder={t('nav.searchPlaceholder')}
                  aria-label={t('nav.searchLabel')}
                />
                {query && (
                  <button
                    type="button"
                    className={styles.clearSearch}
                    onClick={() => {
                      setQuery('');
                      setSearchNote(null);
                    }}
                    aria-label={t('nav.clearSearch')}
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
              {searchNote && <p className={styles.searchNote}>{t(searchNote)}</p>}
            </form>
          </div>

          <div className={styles.topbarRight}>
            {/*
              * In the topbar rather than only on the settings page, because finding it
              * there requires already being able to read the English word "Settings" —
              * which is exactly what someone reaching for this control cannot do.
              */}
            <LanguageSwitcher />

            <Link
              href="/dashboard/notifications"
              className={styles.notifBtn}
              aria-label={
                unread > 0 ? t('nav.unreadCount', { count: unread }) : t('nav.notifications')
              }
            >
              <Bell size={20} />
              {/*
               * Rendered only when something is actually unread. The count is the
               * server's, so it cannot drift from the inbox.
               */}
              {unread > 0 && (
                <span className={styles.notifCount}>{unread > 9 ? '9+' : unread}</span>
              )}
            </Link>

            <div className={styles.profileWrap} ref={profileRef}>
              <button
                className={styles.profileBtn}
                onClick={() => setProfileOpen(!profileOpen)}
                aria-expanded={profileOpen}
                aria-haspopup="menu"
              >
                <div
                  className={styles.avatar}
                  style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-accent))' }}
                >
                  {userInitial}
                </div>
                <div className={styles.profileInfo}>
                  <span className={styles.profileName}>{userName}</span>
                  <span className={styles.profileRole}>{ROLE_LABELS[userRole]}</span>
                </div>
                <ChevronDown size={16} />
              </button>

              {profileOpen && (
                <div className={styles.profileDropdown} role="menu">
                  <Link
                    href="/dashboard/profile"
                    className={styles.dropdownItem}
                    onClick={() => setProfileOpen(false)}
                  >
                    <UserCog size={16} />
                    {t('nav.profile')}
                  </Link>
                  <Link
                    href="/dashboard/settings"
                    className={styles.dropdownItem}
                    onClick={() => setProfileOpen(false)}
                  >
                    <Settings size={16} />
                    {t('nav.preferences')}
                  </Link>
                  <button
                    className={styles.dropdownItem}
                    onClick={() => signOut({ callbackUrl: '/login' })}
                  >
                    <LogOut size={16} />
                    {t('nav.signOut')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <DashboardShell>{children}</DashboardShell>
    </Providers>
  );
}
