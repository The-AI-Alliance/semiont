#!/usr/bin/env node
/**
 * Phantom-dependency guard.
 *
 * Every bare (non-relative) import in a *publishable* package's built `dist/`
 * must be declared in that package's package.json — `dependencies`,
 * `peerDependencies`, or `optionalDependencies` — or be a Node builtin. A bare
 * import that isn't declared resolves only via monorepo hoisting and then
 * **breaks external consumers** who install the package from npm (e.g.
 * `@semiont/react-ui` leaking `use-sync-external-store`).
 *
 * Run after the packages are built (`build:packages`). No args; exits 1 on any
 * undeclared import.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isBuiltin } from 'module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const versionJson = JSON.parse(readFileSync(resolve(root, 'version.json'), 'utf8'));

// Packages actually installed in the monorepo. A bare import whose package is
// NOT here is an optional/conditional `require` the bundled third-party code
// tolerates (e.g. `@aws-sdk/signature-v4-crt`, `jsdom-testing-mocks`) — even the
// monorepo doesn't resolve it, so it can't be a consumer-breaking phantom.
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const installed = new Set();
for (const key of Object.keys(lock.packages || {})) {
  const i = key.lastIndexOf('node_modules/');
  if (i >= 0) installed.add(key.slice(i + 'node_modules/'.length));
}

// Import specifier -> package name: "@scope/n/sub" -> "@scope/n"; "n/sub" -> "n".
const pkgName = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

function bareImportsOf(distDir) {
  const specs = new Set();
  const re = /(?:from|require\(|import\()\s*["']([^"']+)["']/g;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs') || e.name.endsWith('.cjs')) {
        const src = readFileSync(p, 'utf8');
        let m;
        while ((m = re.exec(src))) {
          const s = m[1];
          // A real module specifier is only @ a-z 0-9 . _ / - — reject minified/CJS
          // noise (template-literal `${x}`, defineProperty boilerplate, etc.).
          if (!/^[@a-zA-Z0-9._/-]+$/.test(s)) continue;
          if (s.startsWith('.') || s.startsWith('/')) continue;
          specs.add(s);
        }
      }
    }
  };
  walk(distDir);
  return specs;
}

let failed = false;
let scanned = 0;
for (const entry of Object.values(versionJson.packages)) {
  if (!entry.publish) continue;
  const distDir = resolve(root, entry.dir, 'dist');
  if (!existsSync(distDir)) continue; // not every published package ships a dist/
  const pj = JSON.parse(readFileSync(resolve(root, entry.dir, 'package.json'), 'utf8'));
  const declared = new Set([
    ...Object.keys(pj.dependencies || {}),
    ...Object.keys(pj.peerDependencies || {}),
    ...Object.keys(pj.optionalDependencies || {}),
  ]);
  const undeclared = new Set();
  for (const spec of bareImportsOf(distDir)) {
    const name = pkgName(spec);
    if (name === pj.name) continue;                  // self-reference
    if (isBuiltin(spec) || isBuiltin(name)) continue; // node:fs, fs, etc.
    if (!declared.has(name) && installed.has(name)) undeclared.add(spec);
  }
  scanned++;
  if (undeclared.size) {
    failed = true;
    console.error(`  ✗ ${pj.name}: undeclared dist import(s) — ${[...undeclared].sort().join(', ')}`);
  } else {
    console.log(`  ✓ ${pj.name}`);
  }
}

console.log('');
if (failed) {
  console.error('Phantom dependency detected. Declare each import above in that package\'s');
  console.error('package.json (dependencies / peerDependencies / optionalDependencies), or');
  console.error('inline it in the bundle. It works in the monorepo via hoisting but breaks');
  console.error('external npm consumers.');
  process.exit(1);
}
console.log(`All ${scanned} publishable package(s) with a dist/: every bare import is declared.`);
