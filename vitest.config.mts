import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@ansible-lens/core': path.resolve(import.meta.dirname, 'packages/core/src/index.ts'),
      '@ansible-lens/server': path.resolve(import.meta.dirname, 'packages/server/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts', 'scripts/**/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/contracts/**', 'packages/core/src/index.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
