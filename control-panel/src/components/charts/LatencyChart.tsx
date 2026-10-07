'use client';

import { useId, useMemo, useRef, useState } from 'react';
import type { MetricsTimeseriesPoint } from '@/lib/types';
import { formatMs, formatNumber } from '@/lib/format';
import {
  PAD,
  VIEW_WIDTH,
  createScale,
  formatAxisTime,
  indexFromPointer,
  niceMax,
  tickValues,
} from './chart-math';

export interface LatencyChartProps {
  points: MetricsTimeseriesPoint[];
  height?: number;
  title?: string;
}

const SERIES = [
  { key: 'p50' as const, label: 'p50', color: 'rgb(52 211 153)' },
  { key: 'p95' as const, label: 'p95', color: 'rgb(96 165 250)' },
  { key: 'p99' as const, label: 'p99', color: 'rgb(251 146 60)' },
];

/** Latency percentiles over time (hand-rolled SVG — no canvas, SSR-safe). */
export function LatencyChart({ points, height = 220, title = 'Latency percentiles' }: LatencyChartProps) {
  const gradientId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const maxValue = useMemo(() => {
    let max = 0;
    for (const point of points) {
      max = Math.max(max, point.p99 ?? 0, point.p95 ?? 0, point.p50 ?? 0);
    }
    return niceMax(max);
  }, [points]);

  const scale = useMemo(() => createScale(height, maxValue), [height, maxValue]);
  const ticks = useMemo(() => tickValues(maxValue, 4), [maxValue]);

  const lines = useMemo(() => {
    return SERIES.map((series) => {
      let started = false;
      let path = '';
      points.forEach((point, index) => {
        const value = point[series.key];
        if (value === null || value === undefined) {
          started = false;
          return;
        }
        const x = scale.toX(index, points.length);
        const y = scale.toY(value);
        path += `${!started ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
        started = true;
      });
      return { ...series, path: path.trim() };
    });
  }, [points, scale]);

  const activePoint = hover !== null ? points[hover] : null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-sm font-semibold tracking-display text-white/85">{title}</h3>
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-white/50">
          {SERIES.map((series) => (
            <span key={series.key} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ background: series.color }}
              />
              {series.label}
            </span>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setHover(indexFromPointer(event.clientX, rect, points.length));
        }}
      >
        {points.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-white/10 text-xs text-white/40">
            No latency samples yet — send a request from the playground.
          </div>
        ) : (
          <svg
            role="img"
            aria-label={`${title}: p50, p95 and p99 response time over the selected range`}
            viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
            preserveAspectRatio="none"
            className="h-full w-full overflow-visible"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(59 130 246 / 0.28)" />
                <stop offset="100%" stopColor="rgb(59 130 246 / 0)" />
              </linearGradient>
            </defs>

            {ticks.map((tick, index) => {
              const y = scale.toY(tick);
              return (
                <g key={index}>
                  <line
                    x1={PAD.left}
                    x2={VIEW_WIDTH - PAD.right}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    className="text-white/10"
                    strokeDasharray="3 5"
                    vectorEffect="non-scaling-stroke"
                  />
                  <text
                    x={PAD.left - 6}
                    y={y + 3}
                    textAnchor="end"
                    className="fill-current text-white/40"
                    style={{ fontSize: 9 }}
                  >
                    {formatMs(tick, 0)}
                  </text>
                </g>
              );
            })}

            {points.length > 1 ? (
              <polygon
                fill={`url(#${gradientId})`}
                points={`${scale.toX(0, points.length)},${scale.toY(0)} ${points
                  .map((point, index) => {
                    const value = point.p50 ?? 0;
                    return `${scale.toX(index, points.length)},${scale.toY(value)}`;
                  })
                  .join(' ')} ${scale.toX(points.length - 1, points.length)},${scale.toY(0)}`}
              />
            ) : null}

            {lines.map((line) => (
              <path
                key={line.key}
                d={line.path}
                fill="none"
                stroke={line.color}
                strokeWidth={line.key === 'p50' ? 2 : 1.6}
                strokeDasharray={line.key === 'p99' ? '5 4' : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {points.length > 0 ? (
              <text
                x={PAD.left}
                y={height - 6}
                className="fill-current text-white/35"
                style={{ fontSize: 9 }}
              >
                {formatAxisTime(points[0]!.t)}
              </text>
            ) : null}
            {points.length > 1 ? (
              <text
                x={VIEW_WIDTH - PAD.right}
                y={height - 6}
                textAnchor="end"
                className="fill-current text-white/35"
                style={{ fontSize: 9 }}
              >
                {formatAxisTime(points[points.length - 1]!.t)}
              </text>
            ) : null}

            {hover !== null && points[hover] ? (
              <>
                <line
                  x1={scale.toX(hover, points.length)}
                  x2={scale.toX(hover, points.length)}
                  y1={PAD.top}
                  y2={height - PAD.bottom}
                  stroke="rgb(148 163 184 / 0.5)"
                  vectorEffect="non-scaling-stroke"
                />
                {SERIES.map((series) => {
                  const value = points[hover]![series.key];
                  if (value === null || value === undefined) return null;
                  return (
                    <circle
                      key={series.key}
                      cx={scale.toX(hover, points.length)}
                      cy={scale.toY(value)}
                      r={3}
                      fill={series.color}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              </>
            ) : null}
          </svg>
        )}

        {activePoint ? (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[9rem] rounded-xl border border-white/12 bg-black/75 p-2 text-[11px] text-white/75 shadow-lg backdrop-blur"
            style={{
              left: `${Math.min(Math.max((hover! / Math.max(points.length - 1, 1)) * 100, 4), 74)}%`,
            }}
          >
            <div className="mb-1 font-mono text-[10px] text-white/45">{formatAxisTime(activePoint.t, true)}</div>
            <div className="flex justify-between gap-3">
              <span>p50</span>
              <span className="font-mono text-emerald-300">{formatMs(activePoint.p50)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>p95</span>
              <span className="font-mono text-blue-300">{formatMs(activePoint.p95)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>p99</span>
              <span className="font-mono text-orange-300">{formatMs(activePoint.p99)}</span>
            </div>
            <div className="mt-1 flex justify-between gap-3 border-t border-white/10 pt-1">
              <span>requests</span>
              <span className="font-mono text-white/80">{formatNumber(activePoint.requests)}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default LatencyChart;
