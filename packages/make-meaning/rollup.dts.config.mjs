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

const entries = [
  { input: 'dist-types/index.d.ts', file: 'dist/index.d.ts' },
  { input: 'dist-types/smelter-main.d.ts', file: 'dist/smelter-main.d.ts' },
];

export default entries.map(({ input, file }) => ({
  input,
  output: { file, format: 'es' },
  plugins: [dts()],
  external: isExternal,
}));
