import type { Metadata } from 'next';
import { AdminView } from '@/components/admin/AdminView';
import { getBackupService } from '@/server/backup';
import { getRelayManager } from '@/server/relay-manager';
import { collectSystemInfo } from '@/server/system';
import { getTokenStore } from '@/server/token-store';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Admin' };

/** Server component: system inventory, tokens, backups and lifecycle state. */
export default async function AdminPage() {
  const [system, tokens, backups, status] = await Promise.all([
    collectSystemInfo(),
    getTokenStore().list(),
    getBackupService().list(),
    getRelayManager().status(),
  ]);

  return (
    <AdminView
      initialSystem={system}
      initialTokens={tokens}
      initialBackups={backups.backups}
      initialBackupBytes={backups.totalBytes}
      relayStatus={status}
    />
  );
}
