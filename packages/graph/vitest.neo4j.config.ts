import { defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.shared.config.js';

// The stores against a real neo4j: `npm run test:neo4j`. A run of its own,
// because `npm test` needs no database and this one cannot run without one
// (`src/__tests__/helpers/live-neo4j.ts` says what it reads). The shared
// config is spread, not merged: `mergeConfig` concatenates arrays, and the
// shared `include` would bring every unit suite into this run.
export default defineConfig({
  test: {
    ...baseConfig.test,
    include: ['src/**/*.live.ts'],
    // One database, and suites that count its rows.
    fileParallelism: false,
  },
});
