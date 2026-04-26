import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts', 'src/web.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  // The OTel SDKs are large; consumers bring their own runtime install.
  external: [
    '@opentelemetry/api',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/core',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/sdk-trace-web',
    '@opentelemetry/semantic-conventions',
  ],
});
