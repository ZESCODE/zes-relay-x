import type { MetricsTimeseriesPoint } from '@/lib/types';

/** Shared helpers for the hand-rolled SVG charts. */

export const VIEW_WIDTH = 1000;
export const PAD = { top: 12, right: 14, bottom: 22, left: 46 };

export interface Scale {
  toX: (index: number, count: number) => number;
  toY: (value: number) => number;
}

export function createScale(height: number, maxValue: number): Scale {
  const plotHeight = Math.max(1, height - PAD.top - PAD.bottom);
  const plotWidth = VIEW_WIDTH - PAD.left - PAD.right;
  const safeMax = maxValue > 0 ? maxValue : 1;
  return {
    toX: (index, count) => PAD.left + (count <= 1 ? 0 : (index / (count - 1)) * plotWidth),
    toY: (value) => PAD.top + plotHeight - (value / safeMax) * plotHeight,
  };
}

export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function tickValues(max: number, count = 4): number[] {
  const out: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    out.push((max / count) * index);
  }
  return out;
}

export function indexFromPointer(
  clientX: number,
  rect: DOMRect,
  count: number,
): number | null {
  if (count <= 0 || rect.width === 0) return null;
  const ratio = (clientX - rect.left) / rect.width;
  const plotRatio = (ratio * VIEW_WIDTH - PAD.left) / (VIEW_WIDTH - PAD.left - PAD.right);
  const index = Math.round(plotRatio * (count - 1));
  return Math.min(Math.max(index, 0), count - 1);
}

export function formatAxisTime(iso: string, withDate = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (!withDate) return time;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function seriesBounds(points: MetricsTimeseriesPoint[]): { maxRequests: number; maxLatency: number } {
  let maxRequests = 0;
  let maxLatency = 0;
  for (const point of points) {
    maxRequests = Math.max(maxRequests, point.requests);
    maxLatency = Math.max(maxLatency, point.p99 ?? 0, point.p95 ?? 0, point.avgLatencyMs ?? 0);
  }
  return { maxRequests: niceMax(maxRequests), maxLatency: niceMax(maxLatency) };
}
