import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The integration test spawns a real Python relay and a mock upstream.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    reporters: 'default',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
