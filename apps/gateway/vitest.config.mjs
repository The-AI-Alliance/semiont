import { mergeConfig, defineConfig } from 'vitest/config';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import baseConfig from '../../vitest.shared.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
    // Build-time defines the bundle gets from tsup.config.ts. Tests assert on the
    // real version, so it comes from the same package.json the bundle reads.
    define: {
      __SEMIONT_VERSION__: JSON.stringify(
        JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')).version,
      ),
    },
    test: {
      // JSON reporter for consistent test count reporting
      reporters: ['default', 'json'],
      outputFile: './test-results.json',
      // Unit tests only use the unit test setup (SEMIONT_ENV=unit)
      setupFiles: ['./src/__tests__/setup.ts'],
      // Don't fail on uncaught exceptions from intentional error tests
      dangerouslyIgnoreUnhandledErrors: true,
      include: [
        'src/**/__tests__/**/*.test.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts'
      ],
      exclude: [
        'node_modules',
        'dist',
        'src/**/*.d.ts',
        // Exclude integration tests - they require separate setup
        'src/__tests__/integration/**/*.test.ts'
      ],
      coverage: {
        exclude: [
          'src/__tests__/',
        ],
        reportsDirectory: './coverage',
        // A real floor, measured and enforced here rather than asserted
        // repo-wide: this is the one package that had thresholds that bound.
        thresholds: {
          global: {
            branches: 70,
            functions: 70,
            lines: 70,
            statements: 70
          }
        }
      },
      // Increased timeouts for container operations
      testTimeout: 60000,
      hookTimeout: 60000,
      // Enable type checking for tests
      typecheck: {
        enabled: true
      },
      // Pool options for integration tests
      pool: 'threads',
      isolate: true
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }),
);
