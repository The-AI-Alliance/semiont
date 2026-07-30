// Bundle the per-file .d.ts shards tsc emits into single bundled .d.ts
// files (one per entry point), so the published package's types resolve
// under `moduleResolution: NodeNext`. Without this, the published dist
// has bundled .js (from tsup) alongside sharded .d.ts (from tsc) with
// no matching per-shard .js — NodeNext rejects the broken re-export
// chain. See `.plans/CLEANUP-SDK.md` item 1.
//
// Inputs come from `dist-types/` (emitted by `tsc -p tsconfig.build.json`).
// Outputs go to `dist/`, replacing the shards with bundled files.
//
// Externals are derived from package.json's `dependencies` +
// `peerDependencies` so the .d.ts bundle references them rather than
// trying to inline their types.

import { dts } from 'rollup-plugin-dts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { builtinModules } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

const externalPackages = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...builtinModules,
]);

function isExternal(id) {
  // Asset side-effect imports (`import './Toast.css'`) appear in .d.ts
  // shards when a source module does `import './foo.css'`. They are
  // runtime concerns only — externalize so rollup-plugin-dts doesn't
  // try to resolve them as type sources.
  if (/\.(css|scss|sass|less|svg|png|jpg|jpeg|gif|webp)$/.test(id)) return true;
  const norm = id.replace(/^node:/, '');
  if (externalPackages.has(norm)) return true;
  for (const name of externalPackages) {
    if (id === name || id.startsWith(name + '/')) return true;
  }
  return false;
}

// A test-only entry must IMPORT the shared surface (`EventBus`, `ITransport`,
// `StateUnit`, …) rather than inline private copies of it. Inlined copies of
// classes with private members (`EventBus`) are NOMINALLY distinct types, so a
// `FaultyTransport` typed against the inlined `EventBus` was not assignable
// where consumers hold index types — every consumer needed
// `as unknown as ITransport` (the sdk liveness suites carried exactly that,
// found during the testing-double work). Only the shards an entry DECLARES
// stay bundled; everything else is externalized to the package specifier that
// actually owns it.
//
// Per-entry ownership matters since the axioms split: `faulty-transport` is
// OWNED by `dist/testing.d.ts` and must be EXTERNAL to `dist/testing/
// axioms.d.ts` — otherwise the axioms bundle inlines a second, nominally
// distinct `FaultyTransport`, and a consumer holding one from
// `@semiont/core/testing` could not pass it where the axiom harness expects
// one. That is the same nominal-inlining bug, one level over.
function selfExternal({ ownShards, redirects = {} }) {
  return {
    name: 'dts-self-external',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const base = resolve(dirname(importer), source)
        .replace(/\.d\.ts$/, '')
        .split('/')
        .pop();
      if (ownShards.has(base)) return null;
      return { id: redirects[base] ?? '@semiont/core', external: true };
    },
  };
}

const entries = [
  { input: 'dist-types/index.d.ts', file: 'dist/index.d.ts' },
  { input: 'dist-types/config/node-config-loader.d.ts', file: 'dist/config/node-config-loader.d.ts' },
  {
    input: 'dist-types/testing.d.ts',
    file: 'dist/testing.d.ts',
    selfExternal: { ownShards: new Set(['testing', 'faulty-transport']) },
  },
  {
    input: 'dist-types/testing/axioms.d.ts',
    file: 'dist/testing/axioms.d.ts',
    selfExternal: {
      ownShards: new Set(['axioms', 'state-unit-axioms', 'liveness-axioms']),
      redirects: { 'faulty-transport': '@semiont/core/testing' },
    },
  },
];

export default entries.map(({ input, file, selfExternal: cfg }) => ({
  input,
  output: { file, format: 'es' },
  plugins: cfg ? [selfExternal(cfg), dts()] : [dts()],
  external: isExternal,
}));
