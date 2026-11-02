import { build } from 'esbuild';

// Bundle the Electron main + preload (TypeScript) to CommonJS. Emitting `.cjs`
// sidesteps the package's "type": "module" entirely — no ESM/CJS guessing. The
// renderer is built separately by Vite (the `electron:build` script).
//
// Only `electron` is external (provided by the runtime). Everything else — smol-toml,
// @semiont/core's type guards — is BUNDLED IN and transpiled ESM→CJS, so the CJS main
// never does a runtime `require()` of an ES module (which throws ERR_REQUIRE_ESM). The
// bundle stays tiny because esbuild tree-shakes to only what's imported.
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'info',
};

await build({ ...shared, entryPoints: ['electron/main.ts'], outfile: 'out/main/index.cjs' });
await build({ ...shared, entryPoints: ['electron/preload.ts'], outfile: 'out/preload/index.cjs' });

console.log('✓ built electron main + preload → out/main, out/preload');
