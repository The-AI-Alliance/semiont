#!/usr/bin/env node
// SAFE-DOCS gate: every ```ts / ```tsx / ```typescript fence in the sdk docs
// must type-check against the BUILT packages, resolved through the exports map
// the way an external consumer resolves them. Doc rot fails here instead of
// waiting for a reader to paste a dead snippet.
//
// What a green run does and does not claim:
//   - Shape, not meaning: a method whose semantics changed but whose signature
//     didn't still slips through. Behavioral truth stays with the contract
//     suites (CACHE-SEMANTICS B-numbers, the liveness axioms).
//   - `tsc` alone misses the thenable-era rot — `await` on a non-thenable is
//     legal TypeScript and resolves to the value itself. The await-thenable
//     walk below covers that class, implemented against the compiler API
//     because this repo carries no eslint and one rule doesn't justify the
//     stack (SAFE-DOCS log, D-deviation). It flags `await e` where NO
//     constituent of e's type is thenable (any/unknown are skipped; `for
//     await` is not checked — no doc snippet uses it).
//   - @semiont/* resolve via workspace links → exports map → dist (consumer-
//     shaped); TRANSITIVE deps still resolve via monorepo hoisting. Full
//     external fidelity is the verdaccio drift check's job, not this gate's.
//
// Fence contract: every ts/tsx/typescript fence compiles by default (opt-out,
// not opt-in). Exempt genuine pseudocode with an info-string marker:
//     ```ts no-check
// Exemption is the last resort — anti-pattern snippets usually still compile
// (they're behaviorally wrong, not type-wrong), and comment-elided literals
// should become prelude bindings instead (SAFE-DOCS design point 6).

import { createRequire } from 'node:module';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

const DOCS_DIR = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '..');
const OUT_DIR = join(__dirname, '.generated');

// ── extract ─────────────────────────────────────────────────────────────
const FENCE_OPEN = /^(\s*)```(ts|tsx|typescript)\b(.*)$/;
const snippets = []; // { genPath, docPath, docRel, fenceLine }
let exempted = 0;

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const docFiles = readdirSync(DOCS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => join(DOCS_DIR, f));

for (const docPath of docFiles) {
  const lines = readFileSync(docPath, 'utf8').split('\n');
  const base = basename(docPath, '.md');
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;
    const [, indent, lang, flags] = open;
    const fenceLine = i + 1; // 1-based line of the opening fence
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\s*```\s*$/.test(lines[j])) break;
      body.push(
        lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j],
      );
    }
    i = j; // resume after the closing fence
    if (/\bno-check\b/.test(flags)) {
      exempted += 1;
      continue;
    }
    const ext = lang === 'tsx' ? 'tsx' : 'ts';
    const genPath = join(OUT_DIR, `${base}.L${fenceLine}.${ext}`);
    // Footer (never a header): generated line N maps to doc line
    // fenceLine + N with no offset bookkeeping.
    writeFileSync(genPath, `${body.join('\n')}\nexport {};\n`);
    snippets.push({
      genPath,
      docPath,
      docRel: `${base}.md`,
      fenceLine,
    });
  }
}

if (snippets.length === 0) {
  console.error(`doc-snippets: no checkable fences found under ${DOCS_DIR}`);
  process.exit(1);
}

// ── one program, both checks ────────────────────────────────────────────
const configFile = ts.readConfigFile(join(__dirname, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, __dirname);
const rootNames = [...snippets.map((s) => s.genPath), join(__dirname, 'prelude.ts')];
const program = ts.createProgram(rootNames, parsed.options);
const checker = program.getTypeChecker();

const byGenPath = new Map(snippets.map((s) => [resolve(s.genPath), s]));
const failures = [];

function docLocation(fileName, zeroBasedLine) {
  const snip = byGenPath.get(resolve(fileName));
  if (!snip) return `${fileName}:${zeroBasedLine + 1}`;
  // Generated line 1 is the fence's first body line = doc line fenceLine + 1.
  return `${snip.docRel}:${snip.fenceLine + zeroBasedLine + 1}`;
}

// 1. tsc --noEmit equivalent.
for (const diag of ts.getPreEmitDiagnostics(program)) {
  if (diag.category !== ts.DiagnosticCategory.Error) continue;
  const message = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
  if (diag.file) {
    const { line } = diag.file.getLineAndCharacterOfPosition(diag.start ?? 0);
    failures.push(`${docLocation(diag.file.fileName, line)}  TS${diag.code}: ${message}`);
  } else {
    failures.push(`(global)  TS${diag.code}: ${message}`);
  }
}

// 2. await-thenable: flag `await e` where no constituent of e's type is thenable.
function isThenable(type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((p) => {
    if (p.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true; // can't know — skip
    const then = p.getProperty('then');
    if (!then) return false;
    const declaration = then.valueDeclaration ?? then.declarations?.[0];
    if (!declaration) return false;
    const thenType = checker.getTypeOfSymbolAtLocation(then, declaration);
    const callables = thenType.isUnion() ? thenType.types : [thenType];
    return callables.some((t) => t.getCallSignatures().length > 0);
  });
}

for (const snip of snippets) {
  const source = program.getSourceFile(snip.genPath);
  if (!source) continue;
  const visit = (node) => {
    if (ts.isAwaitExpression(node)) {
      const type = checker.getTypeAtLocation(node.expression);
      if (!isThenable(type)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        failures.push(
          `${docLocation(snip.genPath, line)}  await-thenable: awaiting a non-thenable `
          + `(${checker.typeToString(type)}) — live queries are not awaitable; use .fresh()`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// ── report ──────────────────────────────────────────────────────────────
console.log(
  `doc-snippets: ${snippets.length} fences checked, ${exempted} no-check exemption(s), `
  + `${failures.length} failure(s)`,
);
if (failures.length > 0) {
  for (const f of failures.sort()) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✅ every checkable doc fence compiles (and awaits only thenables)');
