'use client';

import { useEffect, useRef, useState } from 'react';

/** Tracks document visibility so polling can pause in background tabs. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const update = (): void => setVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  return visible;
}

export interface UseIntervalOptions {
  /** Pause the interval while the tab is hidden (default true). */
  pauseWhenHidden?: boolean;
  /** Skip scheduling entirely. */
  enabled?: boolean;
  /** Fire immediately on mount instead of after the first delay. */
  immediate?: boolean;
}

/**
 * Declarative `setInterval` that keeps the latest callback without resetting
 * the timer, and optionally pauses while the tab is in the background.
 */
export function useInterval(
  callback: () => void | Promise<void>,
  delayMs: number | null,
  options: UseIntervalOptions = {},
): void {
  const { pauseWhenHidden = true, enabled = true, immediate = false } = options;
  const savedCallback = useRef(callback);
  const visible = useDocumentVisible();

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;
    if (delayMs === null || delayMs <= 0) return;
    if (pauseWhenHidden && !visible) return;

    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      void savedCallback.current();
    };
    if (immediate) tick();
    const handle = window.setInterval(tick, delayMs);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [delayMs, enabled, immediate, pauseWhenHidden, visible]);
}
