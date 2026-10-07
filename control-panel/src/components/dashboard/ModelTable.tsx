'use client';

import { Badge } from '@/components/ui/Badge';
import { formatMs, formatNumber, formatRelative } from '@/lib/format';
import type { ModelMetric } from '@/lib/types';

export interface ModelTableProps {
  models: ModelMetric[];
  emptyHint?: string;
}

/** Per-model traffic, token and latency breakdown. */
export function ModelTable({ models, emptyHint = 'No model traffic recorded yet.' }: ModelTableProps) {
  if (models.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-white/40">
        {emptyHint}
      </p>
    );
  }

  const maxRequests = Math.max(...models.map((model) => model.requests), 1);

  return (
    <div className="scroll-slim -mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[42rem] border-separate border-spacing-y-1.5 text-left text-xs">
        <caption className="sr-only">Per-model request, token and latency metrics</caption>
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-white/45">
            <th scope="col" className="px-3 py-1 font-semibold">
              Model
            </th>
            <th scope="col" className="px-3 py-1 font-semibold">
              Requests
            </th>
            <th scope="col" className="px-3 py-1 font-semibold">
              Errors
            </th>
            <th scope="col" className="px-3 py-1 font-semibold">
              Tokens in / out
            </th>
            <th scope="col" className="px-3 py-1 font-semibold">
              Avg / p95
            </th>
            <th scope="col" className="px-3 py-1 font-semibold">
              Last used
            </th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => {
            const errorShare = model.requests > 0 ? model.errors / model.requests : 0;
            return (
              <tr key={model.model} className="glass-card rounded-xl">
                <th scope="row" className="rounded-l-xl px-3 py-2 font-medium text-white/85">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-mono text-[11px]">{model.model}</span>
                    {model.streams > 0 ? <Badge tone="blue">{model.streams} streams</Badge> : null}
                  </span>
                  <span className="mt-1 block h-1 w-full max-w-[10rem] overflow-hidden rounded-full bg-white/10">
                    <span
                      className="block h-full rounded-full bg-gradient-to-r from-blue-400/80 to-indigo-400/70"
                      style={{ width: `${Math.max(4, (model.requests / maxRequests) * 100)}%` }}
                    />
                  </span>
                </th>
                <td className="px-3 py-2 font-mono text-white/80">{formatNumber(model.requests)}</td>
                <td className="px-3 py-2">
                  <span className={errorShare > 0 ? 'font-mono text-red-300' : 'font-mono text-white/60'}>
                    {formatNumber(model.errors)}
                  </span>
                  {errorShare > 0 ? (
                    <span className="ml-1 text-[10px] text-white/40">
                      ({Math.round(errorShare * 100)}%)
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 font-mono text-white/70">
                  {formatNumber(model.tokensPrompt)} / {formatNumber(model.tokensCompletion)}
                </td>
                <td className="px-3 py-2 font-mono text-white/70">
                  {formatMs(model.avgLatencyMs)}
                  <span className="text-white/35"> / </span>
                  {formatMs(model.p95LatencyMs)}
                </td>
                <td className="rounded-r-xl px-3 py-2 text-white/50">
                  {model.lastUsedAt ? formatRelative(model.lastUsedAt) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default ModelTable;
