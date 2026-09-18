'use client';

import { useEffect, useRef, useState } from 'react';
import { Globe, Check } from 'lucide-react';
import { LOCALES, LOCALE_LABELS } from '@/lib/i18n';
import { useLocale } from './LocaleProvider';
import styles from './LanguageSwitcher.module.css';

/**
 * The control that changes the interface language.
 *
 * A menu rather than a two-way toggle. With two locales a segmented "EN | हिन्दी"
 * switch would read better, but `LOCALES` is the list a third language is added to,
 * and a toggle silently becomes wrong on the day that happens — this iterates the
 * list and keeps working.
 *
 * Placed in the dashboard topbar and on the public trust centre. The trust centre
 * matters more: the settings page can only offer this to someone who has already
 * signed in, and a citizen checking a sticker outside a shop has no account.
 */
export default function LanguageSwitcher({ align = 'right' }: { align?: 'left' | 'right' }) {
  const { locale, setLocale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Same dismissal behaviour as the profile menu in the dashboard topbar: clicking
  // anywhere else closes it, rather than requiring a second click on the button.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        // The accessible name says what the control does; the visible label says
        // which language is on. Both are needed — "हिन्दी" alone does not tell a
        // screen reader user whether it is the current state or the alternative.
        aria-label={t('language.change')}
        title={t('language.current', { name: LOCALE_LABELS[locale] })}
      >
        <Globe size={17} />
        <span className={styles.triggerLabel}>{LOCALE_LABELS[locale]}</span>
      </button>

      {open && (
        <div className={`${styles.menu} ${align === 'left' ? styles.menuLeft : ''}`} role="menu">
          <p className={styles.menuHead}>{t('common.language')}</p>
          {LOCALES.map((code) => (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={code === locale}
              className={`${styles.option} ${code === locale ? styles.optionOn : ''}`}
              onClick={() => {
                setOpen(false);
                if (code !== locale) setLocale(code);
              }}
            >
              {/*
                * The language's own name in its own script — never "Hindi" written in
                * English. Someone who needs this control may not be able to read the
                * label that would tell them where to find it.
                */}
              <span lang={code}>{LOCALE_LABELS[code]}</span>
              {code === locale && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
