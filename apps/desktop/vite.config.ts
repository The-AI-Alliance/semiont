import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { appConfigPlugin } from './vite-app-config.ts';

function contentSecurityPolicyPlugin(): Plugin {
  return {
    name: 'desktop-content-security-policy',
    transformIndexHtml: {
      order: 'pre',
      handler: (_html, context) => {
        // In packaged Electron builds the main process attaches a CSP response
        // header generated from the saved KB configuration. A static meta policy
        // could only be permissive enough for every future KB origin.
        if (context.server === undefined) return [];
        const connectSources = ["'self'", 'http:', 'https:'];
        connectSources.push('ws://localhost:*', 'ws://127.0.0.1:*');
        const directives = [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: http: https:",
          "font-src 'self' data:",
          `connect-src ${connectSources.join(' ')}`,
          "worker-src 'self' blob:",
          "media-src 'self' blob: http: https:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-src 'none'",
        ];
        return [{
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: directives.join('; '),
          },
          injectTo: 'head',
        }];
      },
    },
  };
}

// vitest/config re-exports vite's defineConfig, so this one file drives both
// the dev/build server and the unit-test runner.
export default defineConfig({
  plugins: [react(), appConfigPlugin(), contentSecurityPolicyPlugin()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.ts'],
  },
});
