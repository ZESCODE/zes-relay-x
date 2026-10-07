import type { Metadata } from 'next';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { getConfigStore } from '@/server/config-store';
import { getPresetStore } from '@/server/preset-store';
import { fetchRelayModels } from '@/server/upstream';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Playground' };

/**
 * Server component: seeds the model dropdown from the relay (with a cached /
 * static fallback when the relay is down) and loads saved presets.
 */
export default async function PlaygroundPage() {
  const values = await getConfigStore().readValues();
  const port = Number.parseInt(values.POL_RELAY_PORT, 10) || 7179;

  const [models, presets] = await Promise.all([
    fetchRelayModels(port, 4000),
    getPresetStore().list(),
  ]);

  const initialModels = {
    models: models.models,
    fetchedAt: new Date().toISOString(),
    latencyMs: models.latencyMs,
    source: (models.ok ? 'relay' : 'fallback') as 'relay' | 'cache' | 'fallback',
    error: models.error,
  };

  return <ChatPanel initialModels={initialModels} initialPresets={presets} />;
}
