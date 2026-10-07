'use client';

import clsx from 'clsx';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  createdAt: number;
  /** Milliseconds before auto-dismiss; 0 keeps it until dismissed. */
  durationMs: number;
}

export interface ToastOptions {
  kind?: ToastKind;
  message?: string;
  durationMs?: number;
}

interface ToastContextValue {
  toasts: ToastItem[];
  push: (title: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
  success: (title: string, message?: string) => string;
  error: (title: string, message?: string) => string;
  info: (title: string, message?: string) => string;
  warning: (title: string, message?: string) => string;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_STYLES: Record<ToastKind, { card: string; icon: string; badge: string }> = {
  success: {
    card: 'glass-frost-green',
    icon: 'text-emerald-300',
    badge: 'bg-emerald-500/15 text-emerald-300',
  },
  error: { card: 'glass-frost-red', icon: 'text-red-300', badge: 'bg-red-500/15 text-red-300' },
  warning: {
    card: 'glass-frost-orange',
    icon: 'text-orange-300',
    badge: 'bg-orange-500/15 text-orange-300',
  },
  info: { card: 'glass-frost-blue', icon: 'text-blue-300', badge: 'bg-blue-500/15 text-blue-300' },
};

const ICONS: Record<ToastKind, string> = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: 'i',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (title: string, options: ToastOptions = {}): string => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const item: ToastItem = {
        id,
        kind: options.kind ?? 'info',
        title,
        message: options.message,
        createdAt: Date.now(),
        durationMs: options.durationMs ?? (options.kind === 'error' ? 8000 : 4500),
      };
      setToasts((current) => [...current.slice(-4), item]);
      if (item.durationMs > 0) {
        const timer = window.setTimeout(() => dismiss(id), item.durationMs);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toasts,
      push,
      dismiss,
      clear: () => setToasts([]),
      success: (title, message) => push(title, { kind: 'success', message }),
      error: (title, message) => push(title, { kind: 'error', message }),
      info: (title, message) => push(title, { kind: 'info', message }),
      warning: (title, message) => push(title, { kind: 'warning', message }),
    }),
    [dismiss, push, toasts],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return context;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const styles = KIND_STYLES[toast.kind];
        return (
          <div
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            className={clsx(
              'pointer-events-auto animate-slide-in rounded-xl p-3 shadow-lg backdrop-blur-md',
              styles.card,
            )}
          >
            <div className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className={clsx(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                  styles.badge,
                )}
              >
                {ICONS[toast.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white/90">{toast.title}</p>
                {toast.message ? (
                  <p className="mt-0.5 break-words text-xs text-white/60">{toast.message}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                aria-label="Dismiss notification"
                className="rounded-md px-1 text-white/45 transition hover:bg-white/10 hover:text-white/80"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ToastProvider;
