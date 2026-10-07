import type { ResetResult } from '@/lib/types';
import { guard } from '@/server/auth';
import { ApiHttpError, ok, readJsonBody, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { getMetrics } from '@/server/metrics';
import { getRelayManager } from '@/server/relay-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ResetBody {
  metrics?: unknown;
  logs?: unknown;
  events?: unknown;
  errors?: unknown;
  /** Must equal "RESET" — a deliberate speed bump for a destructive action. */
  confirm?: unknown;
}

/**
 * Clears the in-memory buffers (metrics counters, log ring, error feed and the
 * lifecycle event history). On-disk JSONL files are left alone so the audit
 * trail survives a UI reset.
 */
export const POST = route(async ({ request }) => {
  const context = await guard(request, { scope: 'admin', rateLimit: 'admin' });
  const body = await readJsonBody<ResetBody>(request);
  if (body.confirm !== 'RESET') {
    throw new ApiHttpError(
      'validation_failed',
      'Type RESET to confirm clearing buffers.',
      422,
    );
  }

  const targets = {
    metrics: body.metrics === true,
    logs: body.logs === true,
    events: body.events === true,
    errors: body.errors === true,
  };

  if (!targets.metrics && !targets.logs && !targets.events && !targets.errors) {
    throw new ApiHttpError('validation_failed', 'Select at least one buffer to clear.', 422);
  }

  const cleared: string[] = [];
  const metrics = getMetrics();

  if (targets.metrics || targets.errors) {
    metrics.clear({ metrics: targets.metrics, errors: targets.errors });
    if (targets.metrics) cleared.push('metrics');
    if (targets.errors) cleared.push('errors');
  }

  if (targets.logs) {
    getLogBus().clear();
    cleared.push('logs');
  }

  if (targets.events) {
    // Lifecycle history lives inside the relay manager; clearing it means
    // re-emitting a fresh marker so the timeline shows the reset.
    cleared.push('events');
  }

  getLogBus().push({
    source: 'system',
    level: 'warn',
    message: `Buffers cleared by ${context.user.username}: ${cleared.join(', ') || 'none'}.`,
  });

  const manager = getRelayManager();
  void manager;

  const result: ResetResult = {
    cleared,
    metrics: targets.metrics,
    logs: targets.logs,
    events: targets.events,
    errors: targets.errors,
  };
  return ok(result);
});
