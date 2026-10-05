import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest configuration for packages
 * Individual packages can extend this configuration
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The layout every package in this repo uses: a package with a different
    // layout overrides it, and one with this layout says nothing.
    // `.tsx` is not optional here: react-ui and the browser have `.test.tsx`
    // suites, and a `.ts`-only glob silently runs none of them. One glob,
    // because `src/**` already reaches into `__tests__` directories at any
    // depth.
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
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
        // Every sidecar's `*-main.ts` is process wiring — config, credential,
        // a health server, the pumps. No suite imports one; they are proven by the
        // launcher's `--dry-run` goldens and by the live round trip. If anyone
        // later wants them covered, the honest form is a boot-refusal test per
        // main (see `sidecar-boot-refusal.test.ts`), not a coverage number.
        'src/*-main.ts',
      ],
      // No blanket `thresholds` here: one reads as a repo-wide floor and binds
      // only the packages that import this file. A threshold belongs in the
      // package that measured it, at the value it measured.
    },
  },
});