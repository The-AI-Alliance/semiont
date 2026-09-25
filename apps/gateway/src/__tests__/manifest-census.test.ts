/**
 * Census gate (GATEWAY-DEPENDS-ON-CORE-ONLY P2–P4): `apps/gateway/package.json`
 * says what the gateway actually uses, in the block that matches HOW it uses it.
 *
 * It matters more here than for most packages: the published gateway's
 * `dependencies` are this manifest's `dependencies` block verbatim
 * (`deriveGatewayRuntimeDeps`), and tsup externalizes every node_modules
 * import (`skipNodeModulesBundle`). So the block is exactly what the image
 * installs, and a production value import of anything outside it is a crash
 * at startup rather than a bundled copy.
 *
 * Each rule catches a failure the others cannot:
 *  - declared and never used (a devDependency nothing imports or runs);
 *  - used and never declared (resolves in the monorepo only because the root
 *    hoists it — a phantom that breaks an external consumer);
 *  - declared as runtime but only ever imported as a TYPE, which is erased at
 *    build: every other rule sees it as used, declared, and imported by
 *    production code.
 */
import { describe, test, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { builtinModules } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const GATEWAY_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_ROOT = join(GATEWAY_SRC, '..');
const REPO_ROOT = join(GATEWAY_ROOT, '..', '..');

interface Manifest {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}
const manifest = JSON.parse(readFileSync(join(GATEWAY_ROOT, 'package.json'), 'utf-8')) as Manifest;
const runtime = Object.keys(manifest.dependencies);
const dev = Object.keys(manifest.devDependencies);
const declared = new Set([...runtime, ...dev]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const isTest = (file: string) => file.includes('/__tests__/') || file.endsWith('.test.ts');

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

interface Import { pkg: string; typeOnly: boolean; file: string; production: boolean }

const BUILTINS = new Set(builtinModules);

function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined;
  const [first, second] = specifier.split('/');
  const pkg = first?.startsWith('@') ? (second ? `${first}/${second}` : undefined) : first;
  return !pkg || BUILTINS.has(pkg) ? undefined : pkg;
}

// `verbatimModuleSyntax` is false, so an import whose every named specifier is
// `type`-prefixed is elided exactly like `import type`.
function isTypeOnly(typeKeyword: string | undefined, clause: string): boolean {
  if (typeKeyword) return true;
  const named = clause.trim().match(/^\{([\s\S]*)\}$/)?.[1];
  if (named === undefined) return false;
  const specifiers = named.split(',').map((s) => s.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((s) => s.startsWith('type '));
}

function importsOf(file: string): Import[] {
  const code = stripComments(readFileSync(file, 'utf-8'));
  const production = !isTest(file);
  const found: Import[] = [];
  const add = (specifier: string, typeOnly: boolean) => {
    const pkg = packageOf(specifier);
    if (pkg) found.push({ pkg, typeOnly, file, production });
  };
  for (const [, typeKeyword, clause = '', specifier] of code.matchAll(/\b(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (specifier) add(specifier, isTypeOnly(typeKeyword, clause));
  }
  for (const [, specifier] of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) if (specifier) add(specifier, false);
  for (const [, specifier] of code.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) if (specifier) add(specifier, false);
  return found;
}

const IMPORTS = tsFiles(GATEWAY_SRC).flatMap(importsOf);
const rel = (file: string) => file.slice(GATEWAY_ROOT.length + 1);

/** The executables a package installs, read from its own manifest. */
function binsOf(pkg: string): string[] {
  for (const base of [GATEWAY_ROOT, REPO_ROOT]) {
    const path = join(base, 'node_modules', pkg, 'package.json');
    if (!existsSync(path)) continue;
    const { bin } = JSON.parse(readFileSync(path, 'utf-8')) as { bin?: string | Record<string, string> };
    if (!bin) return [];
    return typeof bin === 'string' ? [pkg.split('/').pop() as string] : Object.keys(bin);
  }
  return [];
}

const scriptTokens = new Set(Object.values(manifest.scripts).flatMap((s) => s.split(/[\s&|;]+/)));

const vitestConfigs = readdirSync(GATEWAY_ROOT)
  .filter((f) => /^vitest(\..+)?\.config\.m?[jt]s$/.test(f))
  .map((f) => readFileSync(join(GATEWAY_ROOT, f), 'utf-8'));

/**
 * Vitest plugins are loaded by vitest itself, never imported. Each is used
 * only while the thing that engages it is still there, so each check can fail.
 */
const VITEST_PLUGINS: Record<string, () => boolean> = {
  '@vitest/ui': () => scriptTokens.has('--ui'),
  '@vitest/coverage-v8': () => vitestConfigs.some((c) => /provider:\s*['"]v8['"]/.test(c)),
};

function isUsed(pkg: string): boolean {
  if (IMPORTS.some((i) => i.pkg === pkg)) return true;
  if (binsOf(pkg).some((bin) => scriptTokens.has(bin))) return true;
  return VITEST_PLUGINS[pkg]?.() ?? false;
}

describe('the gateway manifest says what the gateway uses (GATEWAY-DEPENDS-ON-CORE-ONLY)', () => {
  test('its only runtime @semiont/* dependencies are core and observability', () => {
    expect(runtime.filter((d) => d.startsWith('@semiont/')).sort()).toEqual([
      '@semiont/core',
      '@semiont/observability',
    ]);
  });

  test('every runtime dependency has a VALUE import in production source', () => {
    const typeOnlyOrUnused = runtime.filter(
      (d) => !IMPORTS.some((i) => i.pkg === d && i.production && !i.typeOnly),
    );
    expect(typeOnlyOrUnused, 'declared as runtime but never reached at runtime').toEqual([]);
  });

  test('every production value import is a runtime dependency', () => {
    const outside = IMPORTS.filter((i) => i.production && !i.typeOnly && !runtime.includes(i.pkg))
      .map((i) => `${i.pkg} (${rel(i.file)})`);
    expect([...new Set(outside)], 'the published image would not install these').toEqual([]);
  });

  test('every bare import resolves to a declared dependency', () => {
    const phantoms = IMPORTS.filter((i) => !declared.has(i.pkg)).map((i) => `${i.pkg} (${rel(i.file)})`);
    expect([...new Set(phantoms)], 'resolves only because the monorepo root hoists it').toEqual([]);
  });

  test('every devDependency is imported, run by a script, or engaged as a vitest plugin', () => {
    const unused = dev.filter((d) => !d.startsWith('@types/') && !isUsed(d));
    expect(unused, 'declared and never used').toEqual([]);
  });
});
