'use client';

import clsx from 'clsx';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Prevent closing by Esc/backdrop (used for destructive confirmations). */
  dismissible?: boolean;
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

/**
 * Accessible dialog: labelled by its heading, traps initial focus, closes on
 * Escape and restores the previously focused element.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const focusTarget =
      panelRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button:not([data-skip-focus])',
      ) ?? panelRef.current;
    focusTarget?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [dismissible, onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-6"
      role="presentation"
    >
      <div
        aria-hidden="true"
        onClick={dismissible ? onClose : undefined}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className={clsx(
          'glass-strong relative z-10 w-full animate-fade-in rounded-2xl p-5 shadow-2xl',
          SIZES[size],
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="modal-title" className="font-display text-base font-semibold tracking-display text-white/90">
              {title}
            </h2>
            {description ? <div className="mt-1 text-sm text-white/55">{description}</div> : null}
          </div>
          {dismissible ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close dialog"
              onClick={onClose}
              data-skip-focus
            >
              ✕
            </Button>
          ) : null}
        </div>
        {children ? <div className="space-y-4 text-sm text-white/75">{children}</div> : null}
        {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  requireText?: string;
  confirmText?: string;
  onConfirmTextChange?: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

/** Confirmation dialog with an optional "type this to continue" guard. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  pending = false,
  requireText,
  confirmText = '',
  onConfirmTextChange,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const blocked = Boolean(requireText) && confirmText !== requireText;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'frost'}
            onClick={onConfirm}
            loading={pending}
            disabled={blocked}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>{message}</div>
        {requireText ? (
          <div className="space-y-1.5">
            <label htmlFor="confirm-text" className="text-xs uppercase tracking-widest text-white/50">
              Type “{requireText}” to continue
            </label>
            <input
              id="confirm-text"
              value={confirmText}
              onChange={(event) => onConfirmTextChange?.(event.target.value)}
              className="w-full rounded-xl px-3 py-2 font-mono text-sm glass-input"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export default Modal;
