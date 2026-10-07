import type { Metadata } from 'next';
import { EnvEditor } from '@/components/config/EnvEditor';
import { getConfigStore } from '@/server/config-store';
import { getRelayManager } from '@/server/relay-manager';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Config' };

/** Server component: renders the masked `data/.env` document. */
export default async function ConfigPage() {
  const [document, status] = await Promise.all([
    getConfigStore().load(),
    getRelayManager().status(),
  ]);

  return <EnvEditor initialDocument={document} relayStatus={status} />;
}
