'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Badge } from '@/components/ui/Badge';
import { HealthBadge } from '@/components/dashboard/HealthBadge';
import { formatUptime } from '@/lib/format';
import type { RelayStatus, SessionUser } from '@/lib/types';

export interface SidebarProps {
  user: SessionUser | null;
  panelVersion: string;
  status: RelayStatus | null;
  /** Called after a nav click so the mobile drawer can close. */
  onNavigate?: () => void;
  onSignOut?: () => void;
  signingOut?: boolean;
  className?: string;
}

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: '◈', hint: 'g d' },
  { href: '/playground', label: 'Playground', icon: '✦', hint: 'g p' },
  { href: '/logs', label: 'Logs', icon: '≡', hint: 'g l' },
  { href: '/config', label: 'Config', icon: '⚙', hint: 'g c' },
  { href: '/admin', label: 'Admin', icon: '⛨', hint: 'g a' },
];

export function Sidebar({
  user,
  panelVersion,
  status,
  onNavigate,
  onSignOut,
  signingOut,
  className,
}: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={clsx(
        'glass-card flex h-full w-64 shrink-0 flex-col gap-4 rounded-2xl p-4',
        className,
      )}
    >
      <div>
        <Link href="/dashboard" className="flex items-center gap-2.5" onClick={onNavigate}>
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/40 to-indigo-500/30 text-sm font-bold text-white shadow-[0_0_20px_rgba(59,130,246,0.35)]"
          >
            ❄
          </span>
          <span className="leading-tight">
            <span className="block font-display text-sm font-semibold tracking-display text-white/90">
              Relay Control
            </span>
            <span className="block font-mono text-[10px] text-white/40">pol_relay · v{panelVersion}</span>
          </span>
        </Link>
      </div>

      <nav aria-label="Panel sections" className="flex flex-col gap-1">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              data-active={active ? 'true' : 'false'}
              aria-current={active ? 'page' : undefined}
              className="sidebar-link"
            >
              <span aria-hidden="true" className="w-4 text-center text-[13px] opacity-80">
                {item.icon}
              </span>
              <span className="flex-1">{item.label}</span>
              <span className="kbd opacity-0 transition-opacity group-hover:opacity-100">{item.hint}</span>
            </Link>
          );
        })}
      </nav>

      <div className="glass-divider my-1" />

      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">Relay</p>
        <HealthBadge status={status} />
        <dl className="space-y-1 text-[11px] text-white/50">
          <div className="flex justify-between gap-2">
            <dt>Port</dt>
            <dd className="font-mono text-white/70">{status?.port ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>PID</dt>
            <dd className="font-mono text-white/70">{status?.pid ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Uptime</dt>
            <dd className="font-mono text-white/70">
              {status?.uptimeMs ? formatUptime(status.uptimeMs) : '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Upstream</dt>
            <dd className="max-w-[7.5rem] truncate font-mono text-white/70" title={status?.config.upstreamBase}>
              {status?.config.upstreamBase.replace(/^https?:\/\//, '') ?? '—'}
            </dd>
          </div>
        </dl>
        {status?.config.skipAuth ? (
          <Badge tone="orange" title="POL_SKIP_AUTH=true — the relay forwards caller credentials">
            skip-auth
          </Badge>
        ) : (
          <Badge tone="blue" title="POL_SKIP_AUTH=false — the relay injects POL_API_KEY">
            key injected
          </Badge>
        )}
      </div>

      <div className="mt-auto space-y-2">
        {user?.mustChangePassword ? (
          <p className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-2 text-[11px] text-orange-200">
            You are still using the generated one-time password. Change it in{' '}
            <Link href="/admin" className="underline">
              Admin → Account
            </Link>
            .
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 p-2">
          <span className="min-w-0">
            <span className="block truncate text-xs text-white/80">{user?.username ?? 'unknown'}</span>
            <span className="block text-[10px] text-white/40">admin session</span>
          </span>
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className="rounded-lg border border-white/15 px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/10 disabled:opacity-50"
          >
            {signingOut ? '…' : 'Sign out'}
          </button>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
