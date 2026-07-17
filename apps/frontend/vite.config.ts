import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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
          if (pkg === 'react' || pkg === 'react-dom' || pkg === 'react-router-dom') return 'vendor';
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
