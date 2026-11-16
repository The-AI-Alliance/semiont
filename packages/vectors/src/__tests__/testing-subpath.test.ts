/**
 * `@semiont/vectors/testing` is a published subpath, not an accident.
 *
 * MANDATORY-EMBEDDING P3 makes a provider mandatory at every KnowledgeBase /
 * Gatherer / Matcher construction site, so every consumer's test suite needs a
 * double. `MockEmbeddingProvider` used to live in `src/__tests__/`, which
 * `tsconfig.build.json` excludes — invisible outside this package. This exports
 * it the way `@semiont/core/testing` does (MANDATORY-EMBEDDING D3).
 *
 * The assertions are deliberately STATIC — they read the manifests rather than
 * importing `@semiont/vectors/testing` and seeing if it resolves. A resolving
 * import would reach through the workspace symlink into `dist/`, which does not
 * exist when `npm run build` runs `typecheck` as its first step: the test would
 * make the package unbuildable from clean. The real end-to-end proof is the
 * first cross-package import, which lands in P3.
 *
 * A subpath needs FOUR things in agreement, and shipping three of them is a
 * silent failure — the export map resolves to a file the build never emitted.
 * Hence one test per leg.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(pkgRoot, rel), 'utf-8');

describe('@semiont/vectors/testing subpath', () => {
  it('has a source entry point exporting the mock provider', () => {
    expect(existsSync(resolve(pkgRoot, 'src/testing.ts'))).toBe(true);
    expect(read('src/testing.ts')).toMatch(/MockEmbeddingProvider/);
  });

  it('declares the ./testing subpath in package.json exports', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.exports['./testing']).toEqual({
      types: './dist/testing.d.ts',
      import: './dist/testing.js',
      default: './dist/testing.js',
    });
  });

  it('builds the runtime entry (tsup) — else the export map points at nothing', () => {
    expect(read('tsup.config.ts')).toMatch(/src\/testing\.ts/);
  });

  it('builds the types entry (rollup-dts) — else `types` resolves to a missing file', () => {
    expect(read('rollup.dts.config.mjs')).toMatch(/dist-types\/testing\.d\.ts/);
  });

  it('splits shared chunks, now that the package has more than one entry', () => {
    // Two entries bundling the same module each get a PRIVATE copy without
    // this. `@semiont/core`'s config documents the incident: the sdk shipped a
    // dist/testing.js holding private copies and prototype spies silently
    // missed. react-ui is a live instance (its dist/index.js and
    // dist/test-utils.js each inline ToastProvider/SemiontProvider). Today this
    // package's testing entry imports only a type, so nothing is duplicated —
    // this guards the moment it imports something runtime.
    const tsup = read('tsup.config.ts');
    expect(tsup).toMatch(/splitting:\s*true/);
    expect(tsup).toMatch(/treeshake:\s*true/);
  });
});
