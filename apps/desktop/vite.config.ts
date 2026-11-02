import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { appConfigPlugin } from './vite-app-config.ts';

// vitest/config re-exports vite's defineConfig, so this one file drives both
// the dev/build server and the unit-test runner.
export default defineConfig({
  plugins: [react(), appConfigPlugin()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.ts'],
  },
});
