import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { themeFromCookies } from '@/server/auth';
import { env } from '@/server/env';
import { ToastProvider } from '@/components/ui/Toast';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'ZES Relay Control Panel',
    template: '%s · ZES Relay',
  },
  description:
    'Frost-styled control panel for the pol_relay OpenAI-compatible relay: lifecycle, live metrics, log tail and playground.',
  applicationName: 'ZES Relay Control Panel',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#020617',
};

/**
 * The theme class is resolved on the server from the `zes_theme` cookie so the
 * first paint is already correct — no flash, no inline bootstrap script.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const theme = themeFromCookies();

  return (
    <html lang="en" className={theme} suppressHydrationWarning>
      <body className="frost-bg min-h-screen antialiased">
        <ToastProvider>{children}</ToastProvider>
        <footer className="relative z-10 pb-4 text-center text-[10px] text-white/25">
          ZES Relay Control Panel {env.panelVersion} · local-only control plane for pol_relay.py
        </footer>
      </body>
    </html>
  );
}
