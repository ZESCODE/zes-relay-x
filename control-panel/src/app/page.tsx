import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, verifySessionCookie } from '@/server/session-verify';

export const dynamic = 'force-dynamic';

/**
 * Entry point: authenticated users land on the dashboard, everyone else on the
 * login screen. The middleware performs the same redirect for navigations; this
 * keeps direct requests (bookmarks, scripts) correct too.
 */
export default async function RootPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const session = await verifySessionCookie(token);
  redirect(session ? '/dashboard' : '/login');
}
