'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
} from 'lucide-react';
import Providers from '@/components/Providers';
import styles from './dashboard.module.css';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}

const NAV_ITEMS: Record<string, NavItem[]> = {
  Owner: [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/dashboard/instruments', label: 'My Instruments', icon: Scale },
    { href: '/dashboard/applications', label: 'Applications', icon: FileText },
    { href: '/dashboard/certificates', label: 'Certificates', icon: Award },
    { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
  ],
  LMO: [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/dashboard/tasks', label: 'Inspection Tasks', icon: ClipboardCheck },
    { href: '/dashboard/certificates', label: 'Issued Certificates', icon: Award },
    { href: '/dashboard/reports', label: 'Reports', icon: BarChart3 },
    { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
  ],
  GATC: [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/dashboard/tasks', label: 'Lab Tasks', icon: ClipboardCheck },
    { href: '/dashboard/certificates', label: 'Certificates', icon: Award },
    { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
  ],
  Admin: [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/dashboard/users', label: 'User Management', icon: Users },
    { href: '/dashboard/applications', label: 'All Applications', icon: FileText },
    { href: '/dashboard/certificates', label: 'All Certificates', icon: Award },
    { href: '/dashboard/gatc', label: 'GATC Management', icon: Building2 },
    { href: '/dashboard/reports', label: 'Reports & Analytics', icon: BarChart3 },
    { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
    { href: '/dashboard/settings', label: 'Settings', icon: Settings },
  ],
};

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const userRole = (session?.user as { role?: string })?.role || 'Owner';
  const navItems = NAV_ITEMS[userRole] || NAV_ITEMS.Owner;
  const userName = session?.user?.name || 'User';
  const userInitial = userName.charAt(0).toUpperCase();

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
          >
            <X size={20} />
          </button>
        </div>

        <div className={styles.roleBadge}>
          <span>{userRole}</span>
        </div>

        <nav className={styles.nav}>
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem} ${isActive ? styles.navActive : ''}`}
                onClick={() => setSidebarOpen(false)}
              >
                <item.icon size={20} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className={styles.sidebarFooter}>
          <Link href="/verify" className={styles.verifyLink}>
            <QrCode size={18} />
            <span>Public Verify</span>
          </Link>
          <button
            className={styles.logoutBtn}
            onClick={() => signOut({ callbackUrl: '/login' })}
          >
            <LogOut size={18} />
            <span>Sign Out</span>
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
            >
              <Menu size={22} />
            </button>
            <div className={styles.searchBar}>
              <Search size={18} />
              <input
                type="text"
                placeholder="Search instruments, applications, certificates..."
              />
            </div>
          </div>

          <div className={styles.topbarRight}>
            <Link href="/dashboard/notifications" className={styles.notifBtn}>
              <Bell size={20} />
              <span className={styles.notifDot} />
            </Link>

            <div className={styles.profileWrap}>
              <button
                className={styles.profileBtn}
                onClick={() => setProfileOpen(!profileOpen)}
              >
                <div
                  className={styles.avatar}
                  style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-accent))' }}
                >
                  {userInitial}
                </div>
                <div className={styles.profileInfo}>
                  <span className={styles.profileName}>{userName}</span>
                  <span className={styles.profileRole}>{userRole}</span>
                </div>
                <ChevronDown size={16} />
              </button>

              {profileOpen && (
                <div className={styles.profileDropdown}>
                  <Link href="/dashboard/profile" className={styles.dropdownItem}>
                    <Settings size={16} />
                    Profile Settings
                  </Link>
                  <button
                    className={styles.dropdownItem}
                    onClick={() => signOut({ callbackUrl: '/login' })}
                  >
                    <LogOut size={16} />
                    Sign Out
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
