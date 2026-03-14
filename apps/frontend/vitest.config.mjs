import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // Don't fail on uncaught exceptions from intentional error tests
    dangerouslyIgnoreUnhandledErrors: true,
    // Pool configuration to reduce memory usage
    pool: 'threads',
    maxConcurrency: 2,
    // Configure reporters (replaces deprecated 'basic' reporter)
    reporters: [
      ['default', { summary: false }]
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/*',
        '**/__tests__/**',
        'vitest.setup.ts',
        'public/**',
        '**/public/**',
        '**/mockServiceWorker.js',
        'scripts/**',
        'next.config.js',
        'postcss.config.js',
        'tailwind.config.ts'
      ],
    },
    typecheck: {
      tsconfig: './tsconfig.test.json'
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})