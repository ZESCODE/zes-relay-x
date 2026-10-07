'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { setTheme as persistTheme } from '@/lib/api';
import type { ThemeName } from '@/lib/types';

interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  toggle: () => void;
  pending: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /** Theme resolved server-side from the cookie — prevents any flash. */
  initialTheme: ThemeName;
  children: ReactNode;
}

export function ThemeProvider({ initialTheme, children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemeName>(initialTheme);
  const [pending, setPending] = useState(false);

  // Keep React state in sync with the class the server rendered.
  useEffect(() => {
    const current = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    setThemeState(current);
  }, []);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    document.documentElement.classList.toggle('light', next === 'light');
    setPending(true);
    void persistTheme(next)
      .catch(() => undefined)
      .finally(() => setPending(false));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      pending,
    }),
    [pending, setTheme, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    // Fallback keeps components usable outside the provider (e.g. on /login).
    return {
      theme: 'dark',
      setTheme: () => undefined,
      toggle: () => undefined,
      pending: false,
    };
  }
  return context;
}

export default ThemeProvider;
