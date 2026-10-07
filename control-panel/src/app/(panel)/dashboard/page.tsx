import type { Metadata } from 'next';
import { getLogBus } from '@/server/log-bus';
import { getMetrics } from '@/server/metrics';
import { getRelayManager } from '@/server/relay-manager';
import { getConfigStore } from '@/server/config-store';
import { DashboardView } from '@/components/dashboard/DashboardView';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * Server component: renders the first paint from the live in-process metrics,
 * then `DashboardView` takes over with SSE + polling.
 */
export default async function DashboardPage() {
  const manager = getRelayManager();
  await manager.ensureInit();

  const [status, config] = await Promise.all([manager.status(), getConfigStore().load()]);
  const metrics = getMetrics();
  const summary = metrics.summary();
  summary.buffers.logs = getLogBus().bufferSize;

  return (
    <DashboardView
      initialStatus={status}
      initialSummary={summary}
      initialSeries={metrics.timeseries('1h')}
      initialErrors={metrics.errorList(20)}
      configPath={config.path}
    />
  );
}
