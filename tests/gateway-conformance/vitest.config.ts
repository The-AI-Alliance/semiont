import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['cases/**/*.test.ts'],
    globalSetup: ['harness/global-setup.ts'],
    // Every file boots its own gateways, issuer, Archivist and broker on
    // ports of its own, so files run in parallel; the cases inside a file
    // share its gateways and run in order.
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
