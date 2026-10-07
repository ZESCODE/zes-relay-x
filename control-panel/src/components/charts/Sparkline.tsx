'use client';

import { useId } from 'react';

export interface SparklineProps {
  values: number[];
  /** SVG stroke colour (any CSS colour). */
  stroke?: string;
  fill?: string;
  height?: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Minimal area sparkline. Uses `preserveAspectRatio="none"` plus
 * `vector-effect="non-scaling-stroke"` so the line stays crisp at any width.
 */
export function Sparkline({
  values,
  stroke = 'rgb(96 165 250)',
  fill = 'rgb(59 130 246 / 0.18)',
  height = 36,
  className,
  ariaLabel = 'trend',
}: SparklineProps) {
  const gradientId = useId();
  const width = 200;
  const series = values.length > 1 ? values : [0, 0];
  const max = Math.max(...series, 1);
  const min = Math.min(...series, 0);
  const span = max - min || 1;

  const points = series.map((value, index) => {
    const x = (index / (series.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const area = `0,${height} ${points.join(' ')} ${width},${height}`;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ width: '100%', height }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} />
          <stop offset="100%" stopColor="transparent" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default Sparkline;
