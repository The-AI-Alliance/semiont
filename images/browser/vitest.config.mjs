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
      // Vitest's 'basic' reporter is deprecated; this is its equivalent
      reporters: [
        ['default', { summary: false }]
      ],
      coverage: {
        exclude: [
          'vitest.setup.ts',
          '**/public/**',
          'scripts/**',
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
