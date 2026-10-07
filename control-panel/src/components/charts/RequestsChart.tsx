'use client';

import { useMemo, useRef, useState } from 'react';
import type { MetricsTimeseriesPoint } from '@/lib/types';
import { formatNumber } from '@/lib/format';
import {
  PAD,
  VIEW_WIDTH,
  createScale,
  formatAxisTime,
  indexFromPointer,
  niceMax,
  tickValues,
} from './chart-math';

export interface RequestsChartProps {
  points: MetricsTimeseriesPoint[];
  height?: number;
  title?: string;
}

/** Request volume per bucket with the error share overlaid in red. */
export function RequestsChart({ points, height = 220, title = 'Requests' }: RequestsChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const maxValue = useMemo(() => niceMax(Math.max(...points.map((point) => point.requests), 0)), [points]);
  const scale = useMemo(() => createScale(height, maxValue), [height, maxValue]);
  const ticks = useMemo(() => tickValues(maxValue, 4), [maxValue]);

  const slotWidth =
    points.length > 0 ? (VIEW_WIDTH - PAD.left - PAD.right) / points.length : 0;
  const barWidth = Math.max(1.2, Math.min(slotWidth * 0.72, 26));
  const activePoint = hover !== null ? points[hover] : null;
  const totalRequests = points.reduce((total, point) => total + point.requests, 0);
  const totalErrors = points.reduce((total, point) => total + point.errors, 0);
  const peak = points.reduce<MetricsTimeseriesPoint | null>(
    (best, point) => (!best || point.requests > best.requests ? point : best),
    null,
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-sm font-semibold tracking-display text-white/85">{title}</h3>
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-white/50">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2 rounded-sm bg-blue-400/80" />
            ok
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2 rounded-sm bg-red-400/80" />
            errors
          </span>
          <span className="text-white/40 normal-case tracking-normal">
            {formatNumber(totalRequests)} total · {formatNumber(totalErrors)} errors
          </span>
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
            No requests recorded in this range.
          </div>
        ) : (
          <svg
            role="img"
            aria-label={`${title}: ${formatNumber(totalRequests)} requests, ${formatNumber(
              totalErrors,
            )} errors. Peak ${formatNumber(peak?.requests ?? 0)} per bucket.`}
            viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
            preserveAspectRatio="none"
            className="h-full w-full"
          >
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
                    {formatNumber(tick)}
                  </text>
                </g>
              );
            })}

            {points.map((point, index) => {
              const center = scale.toX(index, points.length) + (slotWidth - barWidth) / 2;
              const okHeight = Math.max(0, scale.toY(0) - scale.toY(Math.max(0, point.requests - point.errors)));
              const errorHeight = Math.max(0, scale.toY(0) - scale.toY(point.errors));
              const isHovered = hover === index;
              return (
                <g key={point.t}>
                  <rect
                    x={center}
                    y={scale.toY(0) - okHeight}
                    width={barWidth}
                    height={okHeight}
                    rx={Math.min(3, barWidth / 2)}
                    fill={
                      isHovered ? 'rgb(147 197 253 / 0.95)' : 'rgb(96 165 250 / 0.72)'
                    }
                    vectorEffect="non-scaling-stroke"
                  />
                  {point.errors > 0 ? (
                    <rect
                      x={center}
                      y={scale.toY(0) - errorHeight}
                      width={barWidth}
                      height={errorHeight}
                      rx={Math.min(3, barWidth / 2)}
                      fill={isHovered ? 'rgb(248 113 113)' : 'rgb(239 68 68 / 0.85)'}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                </g>
              );
            })}

            <line
              x1={PAD.left}
              x2={VIEW_WIDTH - PAD.right}
              y1={scale.toY(0)}
              y2={scale.toY(0)}
              stroke="currentColor"
              className="text-white/20"
              vectorEffect="non-scaling-stroke"
            />

            {points.length > 0 ? (
              <text x={PAD.left} y={height - 6} className="fill-current text-white/35" style={{ fontSize: 9 }}>
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

            {hover !== null ? (
              <line
                x1={scale.toX(hover, points.length)}
                x2={scale.toX(hover, points.length)}
                y1={PAD.top}
                y2={height - PAD.bottom}
                stroke="rgb(148 163 184 / 0.5)"
                vectorEffect="non-scaling-stroke"
              />
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
              <span>requests</span>
              <span className="font-mono text-blue-300">{formatNumber(activePoint.requests)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>errors</span>
              <span className="font-mono text-red-300">{formatNumber(activePoint.errors)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>tokens out</span>
              <span className="font-mono text-white/80">{formatNumber(activePoint.tokensCompletion)}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default RequestsChart;
