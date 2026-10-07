'use client';

import clsx from 'clsx';
import { useId, useRef, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: string;
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
  /** Right-aligned slot rendered next to the tab strip. */
  actions?: ReactNode;
}

/**
 * Accessible tab strip (roving focus, arrow-key navigation). Panel content is
 * rendered by the caller so the component stays presentational.
 */
export function Tabs({ tabs, active, onChange, className, actions }: TabsProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const enabled = tabs.filter((tab) => !tab.disabled);
    const index = enabled.findIndex((tab) => tab.id === active);
    if (index === -1) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % enabled.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    else return;
    event.preventDefault();
    const target = enabled[next];
    if (!target) return;
    onChange(target.id);
    const button = listRef.current?.querySelector<HTMLButtonElement>(`#${baseId}-${target.id}`);
    button?.focus();
  };

  return (
    <div className={clsx('flex flex-wrap items-center justify-between gap-2', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Sections"
        onKeyDown={onKeyDown}
        className="glass-card flex flex-wrap gap-1 rounded-xl p-1"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              id={`${baseId}-${tab.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => onChange(tab.id)}
              className={clsx(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition-all',
                selected
                  ? 'bg-gradient-to-br from-blue-500/30 to-indigo-500/25 text-white/90 shadow-[0_0_16px_rgba(59,130,246,0.25)]'
                  : 'text-white/55 hover:bg-white/10 hover:text-white/80',
                tab.disabled && 'cursor-not-allowed opacity-45',
              )}
            >
              {tab.label}
              {tab.badge ? <span className="ml-1.5 opacity-80">{tab.badge}</span> : null}
            </button>
          );
        })}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function TabPanel({
  id,
  active,
  children,
  className,
}: {
  id: string;
  active: string;
  children: ReactNode;
  className?: string;
}) {
  if (id !== active) return null;
  return (
    <div role="tabpanel" className={clsx('mt-4 animate-fade-in', className)}>
      {children}
    </div>
  );
}

export default Tabs;
