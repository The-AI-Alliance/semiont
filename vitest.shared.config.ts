import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest configuration for packages
 * Individual packages can extend this configuration
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov', 'cobertura'],
      exclude: [
        'node_modules/',
        'dist/',
        'build/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/test/**',
        '**/tests/**',
        '**/examples/**',
        '**/demo/**',
        '**/index.ts', // Export files
        '**/types.ts', // Generated types
        // D3: every sidecar's `*-main.ts` is process wiring — config, credential,
        // a health server, the pumps. No suite imports one; they are proven by the
        // launcher's `--dry-run` goldens and by the live round trip. If anyone
        // later wants them covered, the honest form is a boot-refusal test per
        // main (see `sidecar-boot-refusal.test.ts`), not a coverage number.
        'src/*-main.ts',
      ],
      // No blanket `thresholds` here. One bound exactly one package while
      // fourteen others did not import this file, so it read as a repo-wide
      // floor and enforced nothing — a comment pretending to be a gate. A
      // threshold belongs in the package that measured it, at the value it
      // measured, with the date (see apps/gateway for one that is real).
    },
  },
});