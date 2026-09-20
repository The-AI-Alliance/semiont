#!/usr/bin/env bash
set -euo pipefail

# Audit: every relative `vi.mock()` / `vi.doMock()` specifier resolves to a
# module that exists.
#
# Vitest SILENTLY NO-OPS a mock whose path resolves to nothing. That is the
# whole reason for this gate: a test reads as isolated, the mock factory sits
# there looking deliberate, and the real module loads anyway. Nothing fails, so
# nothing tells you.
#
# It has happened twice, in both directions:
#
#   - Modules deleted out from under their mocks. `../db`,
#     `../../validation/schemas` and `../../config` were mocked in three
#     gateway tests long after the gateway stopped having them (removed
#     2026-09-19). Each still implied a dependency this process had dropped.
#   - A mock addressed from the wrong directory. JsonLdPanel's test mocked
#     `../../../lib/codemirror-json-theme`, copying the specifier from the
#     COMPONENT — but a vi.mock path resolves against the file that writes it,
#     and the test sits one level deeper in `__tests__/`. It pointed at
#     `src/components/lib/`, which has never existed.
#
# Scope: RELATIVE specifiers only. A bare specifier ('@semiont/make-meaning',
# 'node:fs') resolves through node_modules or tsconfig paths — a different
# question, and one a missing package already fails loudly on.
#
# Markdown is excluded deliberately. A snippet's `../../db` has no real
# anchor directory to resolve against, so every doc hit would be a false
# positive. Doc snippets in packages/sdk/docs are covered by
# audit-doc-snippets.sh instead; elsewhere they are unguarded.
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "🔍 Auditing vi.mock targets (every relative specifier resolves)..."

node - <<'NODE'
const fs = require('fs');
const path = require('path');

// The extensions a bundler would try, plus directory entry points. `.d.ts` is
// absent on purpose: mocking a types-only module mocks nothing at runtime.
const CANDIDATES = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs',
];

// A filesystem walk, not `git grep`: a test file written but not yet staged is
// exactly when this is worth knowing, and git would report it clean. Rooted at
// the workspaces so no stale worktree under .claude/ is ever descended into.
const SKIP = new Set(['node_modules', 'dist', 'dist-types', 'coverage', '.git', '.next', 'build']);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (SOURCE.test(e.name)) out.push(full);
  }
  return out;
}

const files = ['apps', 'packages', 'demo']
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d))
  .filter((f) => fs.readFileSync(f, 'utf-8').includes('vi.'));

const SPEC = /vi\.(?:mock|doMock)\(\s*['"](\.[^'"]*)['"]/g;
const findings = [];
let scanned = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf-8');
  const dir = path.dirname(file);
  for (const m of src.matchAll(SPEC)) {
    scanned++;
    const spec = m[1];
    const base = path.normalize(path.join(dir, spec));
    const hit = CANDIDATES.some((ext) => fs.existsSync(base + ext)) || fs.existsSync(base);
    if (!hit) {
      const line = src.slice(0, m.index).split('\n').length;
      findings.push({ file, line, spec, base });
    }
  }
}

if (findings.length === 0) {
  console.log(`✅ vi.mock targets resolve (${scanned} relative specifier(s) across ${files.length} file(s))`);
  process.exit(0);
}

console.log(`❌ ${findings.length} vi.mock specifier(s) resolve to nothing — the mock never fires and the real module loads:`);
for (const f of findings) {
  console.log(`   ${f.file}:${f.line}`);
  console.log(`     '${f.spec}' → ${f.base} (no such module)`);
}
console.log('');
console.log('   Either the module was deleted and the mock should go with it, or the');
console.log('   specifier was copied from a file at a different depth — a vi.mock path');
console.log('   resolves against the file that writes it, not the file that imports it.');
process.exit(1);
NODE
