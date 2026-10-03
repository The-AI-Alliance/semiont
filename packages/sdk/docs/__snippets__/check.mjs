#!/usr/bin/env node
// SAFE-DOCS gate: every ```ts / ```tsx / ```typescript fence in a suite's docs
// must type-check against the BUILT packages, resolved through the exports map
// the way that suite's reader resolves them. Doc rot fails here instead of
// waiting for a reader to paste a dead snippet.
//
// Two suites, each one TypeScript program with its own preludes:
//   - sdk: the sdk docs, plus the repo-root and packages/sdk READMEs, which
//     carry the first sdk code most readers see and are the least likely to
//     be revisited when a signature moves. Resolved like an external node
//     consumer (nodenext).
//   - ui: the react-ui and Browser docs and READMEs. Resolved like the Browser
//     (bundler resolution, as Vite does), with the Browser's `@/` alias, since
//     the Browser docs teach its own modules. Only diagnostics inside the doc
//     fences and the prelude count: an error in Browser source is the Browser
//     typecheck's to report.
//
// A suite's `ambientModules` are the packages its docs are about. A snippet
// may use their exports without importing them: each name a snippet uses but
// does not declare, and that one of those modules exports, is imported for it
// in the footer — from the first module, in order, that exports it. The lists
// are read from the built packages, so a renamed or deleted export still fails
// as a name the snippet cannot find.
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
// not opt-in). A fence that deliberately shows what does not exist — a
// proposal, pseudocode — is marked in its info string, which lint:docs-names
// honours too:
//     ```ts sketch
// Exemption is the last resort — anti-pattern snippets usually still compile
// (they're behaviorally wrong, not type-wrong), and comment-elided literals
// should become prelude bindings instead (SAFE-DOCS design point 6).
//
// Usage: node check.mjs [suite]   — every suite when none is named.

import { createRequire } from 'node:module';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync,
} from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

const REPO_ROOT = resolve(__dirname, '../../../..');

const markdownIn = (dir) => readdirSync(join(REPO_ROOT, dir))
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => join(dir, f));

const SUITES = {
  sdk: {
    docs: [...markdownIn('packages/sdk/docs'), 'README.md', 'packages/sdk/README.md'],
    preludes: ['prelude.ts'],
    options: {},
    ambientModules: [],
    onlyDocDiagnostics: false,
  },
  ui: {
    docs: [
      ...markdownIn('packages/react-ui/docs'),
      ...markdownIn('apps/browser/docs'),
      'packages/react-ui/README.md',
      'apps/browser/README.md',
    ],
    // react-ui's own declarations for the untyped jest-axe and its vitest
    // matcher ride along, so its accessibility tests read as the docs show them.
    preludes: [
      'prelude-ui.ts',
      'prelude-ui-assets.ts',
      '../../../react-ui/src/types/jest-axe.d.ts',
      '../../../react-ui/src/types/vitest-matchers.d.ts',
    ],
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: { '@/*': [join(REPO_ROOT, 'apps/browser/src/*')] },
      allowUmdGlobalAccess: true,
    },
    ambientModules: [
      '@semiont/react-ui',
      '@semiont/react-ui/test-utils',
      '@semiont/sdk',
      'react',
      'vitest',
      '@testing-library/react',
    ],
    onlyDocDiagnostics: true,
  },
};

// The names a prelude declares in its `declare global` blocks.
function preludeVocabulary(preludePaths) {
  const names = new Set();
  for (const path of preludePaths) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isModuleDeclaration(statement) || statement.name.text !== 'global' || !statement.body) continue;
      for (const declaration of statement.body.statements) {
        if (ts.isVariableStatement(declaration)) {
          declaration.declarationList.declarations.forEach((d) => ts.isIdentifier(d.name) && names.add(d.name.text));
        } else if (declaration.name && ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
    }
  }
  return names;
}

// Each name a module exports, mapped to the first of `modules` that exports it.
// The prelude's vocabulary always wins over an export of the same name. A DOM
// or language global wins over a type-only export — React code writes React's
// synthetic event as `React.MouseEvent`, so a bare `MouseEvent` is the DOM's —
// but not over an exported value: a snippet calling `screen.getByRole` means
// testing-library's `screen`, not `window.screen`.
function exportedNames(modules, options, probeDir, preludePaths) {
  if (modules.length === 0) return new Map();
  const probe = join(probeDir, '__exports_probe.ts');
  writeFileSync(probe, `${modules.map((m, i) => `import * as m${i} from '${m}';`).join('\n')}\nexport {};\n`);
  const program = ts.createProgram([probe], options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(probe);
  const globals = new Set(
    checker.getSymbolsInScope(source.endOfFileToken, ts.SymbolFlags.Value | ts.SymbolFlags.Type)
      .map((s) => s.name),
  );
  const vocabulary = preludeVocabulary(preludePaths);
  const owner = new Map();
  source.statements.filter(ts.isImportDeclaration).forEach((decl, i) => {
    const moduleSymbol = checker.getSymbolAtLocation(decl.moduleSpecifier);
    if (!moduleSymbol) throw new Error(`doc-snippets: ambient module '${modules[i]}' does not resolve`);
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const exportedName = exported.name;
      if (exportedName === 'default' || vocabulary.has(exportedName) || owner.has(exportedName)) continue;
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (globals.has(exportedName) && !(target.flags & ts.SymbolFlags.Value)) continue;
      owner.set(exportedName, modules[i]);
    }
  });
  rmSync(probe);
  return owner;
}

// The footer that imports what a snippet uses from the ambient modules without
// declaring: every identifier in it that an ambient module exports, less the
// names its own imports and top-level declarations bind.
function ambientImports(body, ext, owner) {
  const kind = ext === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(`snippet.${ext}`, body, ts.ScriptTarget.Latest, true, kind);
  const declared = new Set();
  const bind = (nameNode) => {
    if (!nameNode) return;
    if (ts.isIdentifier(nameNode)) declared.add(nameNode.text);
    else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      for (const element of nameNode.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
    }
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      bind(clause?.name);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) bind(bindings.name);
      if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach((e) => bind(e.name));
    } else if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((d) => bind(d.name));
    } else if ('name' in statement) {
      bind(statement.name);
    }
  }
  const wanted = new Map(); // module → names
  const visit = (node) => {
    if (ts.isIdentifier(node) && !declared.has(node.text) && owner.has(node.text)) {
      const module = owner.get(node.text);
      if (!wanted.has(module)) wanted.set(module, new Set());
      wanted.get(module).add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...wanted].map(([module, names]) => `import { ${[...names].sort().join(', ')} } from '${module}';\n`).join('');
}

const FENCE_OPEN = /^(\s*)```(ts|tsx|typescript)\b(.*)$/;

const configFile = ts.readConfigFile(join(__dirname, 'tsconfig.json'), ts.sys.readFile);
const baseOptions = ts.parseJsonConfigFileContent(configFile.config, ts.sys, __dirname).options;

function checkSuite(name, suite) {
  const outDir = join(__dirname, '.generated', name);
  const snippets = []; // { genPath, docRel, fenceLine }
  let exempted = 0;

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const options = { ...baseOptions, ...suite.options };
  const preludePaths = suite.preludes.map((p) => join(__dirname, p));
  const owner = exportedNames(suite.ambientModules, options, outDir, preludePaths);

  // ── extract ───────────────────────────────────────────────────────────
  for (const docRel of suite.docs) {
    const lines = readFileSync(join(REPO_ROOT, docRel), 'utf8').split('\n');
    // Repo-relative, NOT the basename: READMEs share one, so a basename key
    // would collide their generated files and make a failure's location
    // ambiguous. The full path also makes the reported location clickable.
    const slug = docRel.replace(/\.md$/, '').replace(/[^\w.-]/g, '_');
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
      if (/\bsketch\b/.test(flags)) {
        exempted += 1;
        continue;
      }
      const ext = lang === 'tsx' ? 'tsx' : 'ts';
      const genPath = join(outDir, `${slug}.L${fenceLine}.${ext}`);
      // Footer (never a header): generated line N maps to doc line
      // fenceLine + N with no offset bookkeeping. Imports hoist, so the
      // ambient ones work from there.
      const text = body.join('\n');
      writeFileSync(genPath, `${text}\n${ambientImports(text, ext, owner)}export {};\n`);
      snippets.push({ genPath, docRel, fenceLine });
    }
  }

  if (snippets.length === 0) {
    console.error(`doc-snippets [${name}]: no checkable fences found`);
    return false;
  }

  // ── one program, both checks ──────────────────────────────────────────
  const rootNames = [...snippets.map((s) => s.genPath), ...preludePaths];
  const program = ts.createProgram(rootNames, options);
  const checker = program.getTypeChecker();

  const byGenPath = new Map(snippets.map((s) => [resolve(s.genPath), s]));
  const counted = new Set([...byGenPath.keys(), ...preludePaths.map((p) => resolve(p))]);
  const failures = [];

  const docLocation = (fileName, zeroBasedLine) => {
    const snip = byGenPath.get(resolve(fileName));
    if (!snip) return `${relative(REPO_ROOT, fileName)}:${zeroBasedLine + 1}`;
    // Generated line 1 is the fence's first body line = doc line fenceLine + 1.
    return `${snip.docRel}:${snip.fenceLine + zeroBasedLine + 1}`;
  };

  // 1. tsc --noEmit equivalent.
  for (const diag of ts.getPreEmitDiagnostics(program)) {
    if (diag.category !== ts.DiagnosticCategory.Error) continue;
    if (suite.onlyDocDiagnostics && diag.file && !counted.has(resolve(diag.file.fileName))) continue;
    const message = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
    if (diag.file) {
      const { line } = diag.file.getLineAndCharacterOfPosition(diag.start ?? 0);
      failures.push(`${docLocation(diag.file.fileName, line)}  TS${diag.code}: ${message}`);
    } else {
      failures.push(`(global)  TS${diag.code}: ${message}`);
    }
  }

  // 2. await-thenable: flag `await e` where no constituent of e's type is thenable.
  const isThenable = (type) => {
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
  };

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

  // ── report ────────────────────────────────────────────────────────────
  console.log(
    `doc-snippets [${name}]: ${snippets.length} fences checked, ${exempted} sketch exemption(s), `
    + `${failures.length} failure(s)`,
  );
  for (const f of failures.sort()) console.log(`  ✗ ${f}`);
  return failures.length === 0;
}

const requested = process.argv[2];
if (requested && !(requested in SUITES)) {
  console.error(`doc-snippets: no suite '${requested}' (suites: ${Object.keys(SUITES).join(', ')})`);
  process.exit(1);
}
const results = Object.entries(SUITES)
  .filter(([name]) => !requested || name === requested)
  .map(([name, suite]) => checkSuite(name, suite));
if (results.includes(false)) process.exit(1);
console.log('✅ every checkable doc fence compiles (and awaits only thenables)');
