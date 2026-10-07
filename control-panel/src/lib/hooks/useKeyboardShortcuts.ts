'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';

/**
 * Handles the panel's global keyboard shortcuts:
 *   g then d/p/l/c/a — jump to dashboard / playground / logs / config / admin
 *   ?               — open the shortcut help dialog
 *   Esc             — close dialogs (handled by the Modal component)
 *
 * Shortcuts are ignored while the user is typing in a field.
 */

export interface ShortcutHandlers {
  onNavigate?: (path: string) => void;
  onHelp?: () => void;
  onToggleTheme?: () => void;
  onStartRelay?: () => void;
  onStopRelay?: () => void;
}

interface Sequence {
  key: string;
  path: string;
}

const SEQUENCES: Sequence[] = [
  { key: 'd', path: '/dashboard' },
  { key: 'p', path: '/playground' },
  { key: 'l', path: '/logs' },
  { key: 'c', path: '/config' },
  { key: 'a', path: '/admin' },
];

export const SHORTCUT_HELP: Array<{ keys: string; description: string }> = [
  { keys: 'g d', description: 'Go to dashboard' },
  { keys: 'g p', description: 'Go to playground' },
  { keys: 'g l', description: 'Go to logs' },
  { keys: 'g c', description: 'Go to config' },
  { keys: 'g a', description: 'Go to admin' },
  { keys: '?', description: 'Show this help' },
  { keys: 't', description: 'Toggle theme' },
  { keys: 's', description: 'Start relay' },
  { keys: 'x', description: 'Stop relay' },
  { keys: 'Esc', description: 'Close dialog / cancel stream' },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const [, setPrefix] = useState<string | null>(null);

  useEffect(() => {
    let armed = false;
    let timer: number | null = null;

    const disarm = (): void => {
      armed = false;
      setPrefix(null);
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const onKeyDown = (event: KeyboardEvent | globalThis.KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key;

      if (key === '?') {
        event.preventDefault();
        handlers.onHelp?.();
        return;
      }

      if (armed) {
        const match = SEQUENCES.find((sequence) => sequence.key === key.toLowerCase());
        if (match) {
          event.preventDefault();
          handlers.onNavigate?.(match.path);
        }
        disarm();
        return;
      }

      switch (key.toLowerCase()) {
        case 'g':
          armed = true;
          setPrefix('g');
          timer = window.setTimeout(disarm, 1500);
          break;
        case 't':
          event.preventDefault();
          handlers.onToggleTheme?.();
          break;
        case 's':
          event.preventDefault();
          handlers.onStartRelay?.();
          break;
        case 'x':
          event.preventDefault();
          handlers.onStopRelay?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [handlers]);
}

export type { KeyboardEvent as ReactKeyboardEvent };
