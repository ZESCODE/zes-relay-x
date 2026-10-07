import type { Config } from 'tailwindcss';

/**
 * ZES Frost Edition design tokens.
 * Mirrors https://github.com/ZESCODE/frost-cards — 4 colour frost tokens
 * (green / blue / orange / red) layered over a glassmorphic base.
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        frost: {
          green: 'rgb(34 197 94)',
          blue: 'rgb(59 130 246)',
          orange: 'rgb(249 115 22)',
          red: 'rgb(239 68 68)',
        },
        ice: {
          50: '#f4f8ff',
          100: '#e8f1ff',
          200: '#d3e4ff',
          300: '#b3d0ff',
          400: '#83b3ff',
          500: '#5a94f7',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      letterSpacing: {
        display: '-0.02em',
      },
      boxShadow: {
        glow: '0 0 40px rgb(59 130 246 / 0.18)',
        'glow-green': '0 0 40px rgb(34 197 94 / 0.16)',
        'glow-orange': '0 0 40px rgb(249 115 22 / 0.16)',
        'glow-red': '0 0 40px rgb(239 68 68 / 0.16)',
        'inset-top': 'inset 0 1px 0 rgb(255 255 255 / 0.08)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'caret-blink': {
          '0%, 70%, 100%': { opacity: '1' },
          '20%, 50%': { opacity: '0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out both',
        'slide-in': 'slide-in 0.22s ease-out both',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        'caret-blink': 'caret-blink 1.1s step-end infinite',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};

export default config;
