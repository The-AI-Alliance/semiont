import { mergeConfig, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import baseConfig from '../../vitest.shared.config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [react()],
    test: {
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
        exclude: [
          'src/test/',
          '**/mockData/*',
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
  }),
)
