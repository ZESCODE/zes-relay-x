'use client';

import { Modal } from '@/components/ui/Modal';
import { SHORTCUT_HELP } from '@/lib/hooks/useKeyboardShortcuts';

export interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

/** Keyboard shortcut reference, opened with “?”. */
export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Shortcuts are ignored while you are typing in a field."
    >
      <dl className="grid gap-2 sm:grid-cols-2">
        {SHORTCUT_HELP.map((item) => (
          <div
            key={item.keys}
            className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2"
          >
            <dt className="flex gap-1">
              {item.keys.split(' ').map((key) => (
                <kbd key={key} className="kbd">
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className="text-xs text-white/60">{item.description}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

export default ShortcutsHelp;
