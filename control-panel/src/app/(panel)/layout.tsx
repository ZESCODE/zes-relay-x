import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import type { RelayStatus, SessionUser } from '@/lib/types';
import { themeFromCookies } from '@/server/auth';
import { ensureBootstrapped } from '@/server/bootstrap';
import { env } from '@/server/env';
import { getRelayManager } from '@/server/relay-manager';
import {
  SESSION_COOKIE,
  findUser,
  verifySessionCookie,
} from '@/server/session-verify';
import { ThemeProvider } from '@/components/layout/ThemeProvider';
import { PanelShell } from '@/components/layout/PanelShell';

export const dynamic = 'force-dynamic';

/**
 * Server shell for every panel page.
 *
 * The session is verified *here* with the signing secret — the edge middleware
 * can only check that the cookie is present. Server components read server
 * state directly instead of calling the panel's own API.
 */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  // Idempotent: creates the data layout, the admin account, the metrics timers
  // and the relay health loop on the very first Node request.
  await ensureBootstrapped();

  const token = cookies().get(SESSION_COOKIE)?.value;
  const session = await verifySessionCookie(token);
  if (!session) redirect('/login');

  const record = await findUser(session.sub);
  if (!record) redirect('/login');

  const user: SessionUser = {
    username: record.username,
    role: 'admin',
    createdAt: record.createdAt,
    mustChangePassword: record.mustChangePassword,
  };

  const manager = getRelayManager();
  await manager.ensureInit();
  const initialStatus: RelayStatus = await manager.status();
  const theme = themeFromCookies(record.theme);

  return (
    <ThemeProvider initialTheme={theme}>
      <PanelShell user={user} panelVersion={env.panelVersion} initialStatus={initialStatus}>
        {children}
      </PanelShell>
    </ThemeProvider>
  );
}
