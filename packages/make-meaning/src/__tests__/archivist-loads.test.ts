/**
 * What the Archivist process loads.
 *
 * The Archivist dials the bus and nothing else, and its image is sized for
 * that. A module it imports for a constant still evaluates everything that
 * module imports, so the claim is held on the import graph, from the entry
 * point: no file it loads imports the graph, vector or inference packages for
 * a value.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';

const SRC = resolve(__dirname, '..');
const DISCOVERY_PACKAGES = ['@semiont/graph', '@semiont/vectors', '@semiont/inference'];

/** The specifiers a file imports for a value: `import type` and all-`type` clauses are erased. */
function valueImports(source: string): string[] {
  const found: string[] = [];
  const statement = /^(?:import|export)\s+(?!type\b)([^;'"]*?)\s*from\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;
  for (const match of source.matchAll(statement)) {
    const [, clause, from, bare, dynamic] = match;
    if (from === undefined) {
      found.push((bare ?? dynamic)!);
      continue;
    }
    const named = clause!.match(/^\{([\s\S]*)\}$/);
    const erased = named !== null && named[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '));
    if (!erased) found.push(from);
  }
  return found;
}

function resolveLocal(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  const file = [`${base}.ts`, resolve(base, 'index.ts')].find(existsSync);
  if (!file) throw new Error(`${from} imports ${specifier}, which resolves to no file`);
  return file;
}

/** Every make-meaning file the entry point loads, with the packages each imports for a value. */
function loadedFrom(entry: string): Map<string, string[]> {
  const loaded = new Map<string, string[]>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (loaded.has(file)) continue;
    const specifiers = valueImports(readFileSync(file, 'utf8'));
    loaded.set(file, specifiers.filter((s) => !s.startsWith('.')));
    queue.push(...specifiers.filter((s) => s.startsWith('.')).map((s) => resolveLocal(file!, s)));
  }
  return loaded;
}

describe('what the Archivist process loads', () => {
  const loaded = loadedFrom(resolve(SRC, 'archivist-main.ts'));

  it('follows the entry point into its actors', () => {
    const files = [...loaded.keys()].map((file) => file.slice(SRC.length + 1));
    expect(files).toEqual(expect.arrayContaining(['stower.ts', 'browser.ts', 'clone-token-manager.ts', 'service-channels.ts']));
  });

  it('loads no graph, vector or inference package', () => {
    const offenders = [...loaded]
      .flatMap(([file, packages]) => packages
        .filter((p) => DISCOVERY_PACKAGES.some((d) => p === d || p.startsWith(`${d}/`)))
        .map((p) => `${file.slice(SRC.length + 1)} imports ${p}`));
    expect(offenders).toEqual([]);
  });

  it('the Librarian, walked the same way, does load them', () => {
    const packages = new Set([...loadedFrom(resolve(SRC, 'librarian-main.ts')).values()].flat());
    expect(DISCOVERY_PACKAGES.filter((d) => !packages.has(d))).toEqual([]);
  });
});
