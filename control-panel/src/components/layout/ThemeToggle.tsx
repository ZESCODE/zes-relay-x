'use client';

import clsx from 'clsx';
import { useTheme } from './ThemeProvider';

export interface ThemeToggleProps {
  className?: string;
}

/**
 * Light/dark switch. The DOM class flips immediately and the preference is
 * persisted through `POST /api/theme`, which sets the cookie server-side so the
 * next server render already knows the theme (no flash of the wrong palette).
 */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggle, pending } = useTheme();

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      aria-pressed={theme === 'light'}
      disabled={pending}
      title="Toggle theme (t)"
      className={clsx(
        'glass-btn flex size-9 items-center justify-center rounded-xl text-sm text-white/80',
        className,
      )}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
    </button>
  );
}

export default ThemeToggle;
