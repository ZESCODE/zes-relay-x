import type { Metadata } from 'next';
import { LoginForm } from '@/components/layout/LoginForm';
import { env } from '@/server/env';
import { ThemeProvider } from '@/components/layout/ThemeProvider';
import { themeFromCookies } from '@/server/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in',
};

/** Splash + credential form. The panel console stays locked until sign-in. */
export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const theme = themeFromCookies();
  const target =
    typeof searchParams?.next === 'string' && searchParams.next.startsWith('/')
      ? searchParams.next
      : '/dashboard';

  return (
    <ThemeProvider initialTheme={theme}>
      <main className="frost-bg frost-grid flex min-h-screen items-center justify-center p-4">
        <div className="relative z-10 w-full max-w-md">
          <div className="mb-6 text-center">
            <span
              aria-hidden="true"
              className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500/40 to-indigo-500/30 text-2xl text-white shadow-[0_0_36px_rgba(59,130,246,0.4)]"
            >
              ❄
            </span>
            <h1 className="font-display text-2xl font-bold tracking-display text-white/90">
              ZES Relay Control Panel
            </h1>
            <p className="mt-1 text-xs text-white/45">
              Local control plane for <span className="font-mono">pol_relay.py</span> · v{env.panelVersion}
            </p>
          </div>

          <LoginForm nextPath={target} />

          <p className="mt-4 text-center text-[11px] leading-relaxed text-white/35">
            First run? The generated one-time password is printed once in the panel&apos;s server log
            (<span className="font-mono">data/logs/panel.jsonl</span>, source <span className="font-mono">system</span>),
            or set <span className="font-mono">PANEL_ADMIN_PASSWORD</span> before starting.
          </p>
        </div>
      </main>
    </ThemeProvider>
  );
}
