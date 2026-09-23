import { defineConfig } from 'vite';
import { createRequire } from 'module';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The app's own version, for the Settings panel's About block. Read from
// package.json at build time rather than carried in an env var.
const pkgVersion = createRequire(import.meta.url)('./package.json').version as string;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // vfile (used by react-markdown) imports Node's 'url' module for file:// path handling.
      // In the browser that code path is never reached, so stub it out.
      'url': path.resolve(__dirname, 'src/lib/browser-stubs/url.ts'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    cssMinify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          const m = id.match(/node_modules\/(?:\.pnpm\/)?([^/]+)/);
          if (!m) return;
          const pkg = m[1];
          if (pkg === 'react' || pkg === 'react-dom' || pkg === 'react-router') return 'vendor';
          if (pkg === 'i18next' || pkg === 'react-i18next') return 'i18n';
        },
      },
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  preview: {
    port: 3000,
    host: '0.0.0.0',
  },
});
