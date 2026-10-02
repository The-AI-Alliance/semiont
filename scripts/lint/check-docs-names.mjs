#!/usr/bin/env node
/**
 * Every name the Browser's and react-ui's documents use exists in the tree.
 *
 * Documents restate the code by hand and nothing kept the two in step. When
 * this gate was written, a census of these documents found 139 names that
 * resolved to nothing: a routing guide for a `RoutingProvider` and `useRouting`
 * that did not exist, examples calling `client.emit`, `client.on` and
 * `client.bus.get` after all three were gone, imports of deleted modals and
 * hooks, a performance guide whose every command was missing from
 * `package.json`, and tests pointing at files deleted months before. A reader
 * copying any of them got an error, and nothing said the document was wrong.
 *
 * Checked in `packages/react-ui/docs`, `packages/react-ui/README.md`,
 * `apps/browser/docs` and `apps/browser/README.md`:
 *
 *   - imports from `@semiont/*`: each name is exported by that package (a
 *     wildcard re-export of another package counts, read from its types);
 *   - hooks called and components rendered in code: defined or imported in the
 *     document, exported somewhere in the monorepo, or one of React's own;
 *   - SDK calls: `client.<namespace>.<method>(…)`, `client.bus.<method>(…)`,
 *     `client.<method>(…)` and `session.<method>(…)` name members that exist;
 *   - bus channels: a quoted `namespace:name` in one of the bus's namespaces
 *     is a key of `EventMap`, and so is any channel passed to `emit`, `on`,
 *     `subscribe`, `stream` or `useEventSubscription(s)`;
 *   - repository paths, `npm run` scripts and relative links resolve.
 *
 * THE ONE ESCAPE: a code fence whose info string includes `sketch` is not
 * checked. Use it for code that names what does not exist on purpose — a
 * how-to's new file, a roadmap — and say so in the fence: ```tsx sketch.
 * Everything else a document shows is a claim about the tree.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, relative, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(p, 'utf8');

/**
 * Component names that only ever mean "your component here". A snippet rendering
 * one is showing where the reader's own code goes, not naming something of ours.
 */
const PLACEHOLDERS = new Set(['MyComponent', 'Component', 'YourApp', 'Page']);

/** Findings a person has looked at and kept, with why. Key: `<doc>::<finding>`. */
const ALLOWLIST = new Map([
  ['packages/react-ui/docs/SESSION.md::SignInPrompt', 'the host\'s own sign-in prompt, rendered when no session exists'],
  ['apps/browser/docs/AUTHENTICATION.md::SignInPrompt', 'the host\'s own sign-in prompt, rendered when no session exists'],
  ['apps/browser/docs/AUTHENTICATION.md::LoadingSpinner', 'stands for the inline spinner in know/layout.tsx; the example condenses it'],
  ['apps/browser/docs/AUTHENTICATION.md::AuthenticatedKnowledgeLayout', 'stands for the inline authed layout in know/layout.tsx'],
  ['apps/browser/docs/AUTHORIZATION.md::AnnotationList', 'the reader\'s own list, given the signed-in person'],
  ['packages/react-ui/docs/TESTING.md::AddDocumentButton', 'the component under test in a testing-pattern example'],
  ['packages/react-ui/docs/TESTING.md::CloseButton', 'the component under test in a testing-pattern example'],
  ['apps/browser/docs/KEYBOARD-NAV.md::DeleteIcon', 'the host\'s icon, passed in; react-ui ships no icon set'],
  ['apps/browser/docs/TESTING.md::ComponentThatMightFail', 'the child an error-boundary test throws from'],
]);

// ── What the tree has ─────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'coverage', '.claude']);
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, exts, out); }
    else if (exts.some((x) => e.name.endsWith(x)) && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

const EXPORT_DEF = /export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|abstract\s+class|namespace)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /export\s+(?:type\s+)?\{([^}]*)\}/g;
const EXPORT_STAR = /export\s+\*\s+(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s+['"]([^'"]+)['"]/g;

function namesIn(text, names, stars) {
  for (const m of text.matchAll(EXPORT_DEF)) names.add(m[1]);
  for (const m of text.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  for (const m of text.matchAll(EXPORT_STAR)) {
    if (m[1]) names.add(m[1]); else stars.push(m[2]);
  }
}

/** Names a third-party package exports, read from its type declarations. */
const dtsMemo = new Map();
function externalNames(spec) {
  if (dtsMemo.has(spec)) return dtsMemo.get(spec);
  const pkgDir = join(ROOT, 'node_modules', spec);
  const pj = join(pkgDir, 'package.json');
  if (!existsSync(pj)) {
    throw new Error(`cannot read the types of '${spec}', which a package re-exports wholesale — run \`npm ci\` first`);
  }
  const j = JSON.parse(read(pj));
  const dot = j.exports?.['.'];
  const entry = j.types ?? j.typings ?? dot?.types ?? dot?.import?.types ?? dot?.default?.types ?? 'index.d.ts';
  const names = new Set();
  dtsMemo.set(spec, names);
  const seen = new Set();
  const visit = (file, depth) => {
    if (depth > 8 || seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const stars = [];
    namesIn(read(file), names, stars);
    for (const s of stars) {
      if (s.startsWith('.')) {
        const base = resolve(dirname(file), s);
        const cand = [base, `${base}.d.ts`, `${base.replace(/\.js$/, '')}.d.ts`, join(base, 'index.d.ts')];
        const hit = cand.find((c) => existsSync(c) && statSync(c).isFile());
        if (hit) visit(hit, depth + 1);
      } else {
        for (const n of externalNames(s)) names.add(n);
      }
    }
  };
  visit(join(pkgDir, entry), 0);
  return names;
}

const PACKAGE_SRC = {
  '@semiont/react-ui': 'packages/react-ui/src',
  '@semiont/sdk': 'packages/sdk/src',
  '@semiont/core': 'packages/core/src',
  '@semiont/http-transport': 'packages/http-transport/src',
};
const pkgMemo = new Map();
function packageNames(pkg) {
  if (pkgMemo.has(pkg)) return pkgMemo.get(pkg);
  const names = new Set();
  pkgMemo.set(pkg, names);
  const stars = [];
  for (const f of walk(join(ROOT, PACKAGE_SRC[pkg]), ['.ts', '.tsx'])) namesIn(read(f), names, stars);
  for (const s of new Set(stars)) {
    if (s.startsWith('.')) continue; // in-package re-exports are already scanned
    const base = s.split('/').slice(0, s.startsWith('@') ? 2 : 1).join('/');
    const sub = PACKAGE_SRC[base] ? packageNames(base) : externalNames(s);
    for (const n of sub) names.add(n);
  }
  return names;
}
const importable = (spec) => {
  const base = spec.split('/').slice(0, 2).join('/');
  return PACKAGE_SRC[base] ? packageNames(base) : null;
};

const ANYWHERE = new Set();
for (const pkg of Object.keys(PACKAGE_SRC)) for (const n of packageNames(pkg)) ANYWHERE.add(n);
for (const f of walk(join(ROOT, 'apps/browser/src'), ['.ts', '.tsx'])) namesIn(read(f), ANYWHERE, []);
// A document explaining the code names its internal functions too, not only its exports.
for (const dir of ['apps/browser/src', 'packages/react-ui/src']) {
  for (const f of walk(join(ROOT, dir), ['.tsx', '.ts'])) {
    for (const m of read(f).matchAll(/^(?:export\s+)?(?:default\s+)?function\s+([A-Z][\w]*)|^const\s+([A-Z][\w]*)\s*=/gm)) ANYWHERE.add(m[1] ?? m[2]);
  }
}

const REACT_HOOKS = new Set(['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useContext',
  'useReducer', 'useLayoutEffect', 'useId', 'useTransition', 'useDeferredValue', 'useSyncExternalStore',
  'useImperativeHandle', 'useOptimistic', 'useActionState']);
const REACT_COMPONENTS = new Set(['Suspense', 'Fragment', 'StrictMode', 'Profiler']);

const bp = read(join(ROOT, 'packages/core/src/bus-protocol.ts'));
const CHANNELS = new Set([...bp.matchAll(/^\s*'([a-z][a-z0-9-]*:[a-z0-9-]+)'\s*:/gm)].map((m) => m[1]));
const BUS_NAMESPACES = new Set([...CHANNELS].map((c) => c.split(':')[0]));

const members = (rel) => new Set([...read(join(ROOT, rel)).matchAll(
  /^\s+(?:public\s+|async\s+|get\s+|static\s+)*([a-z][\w$]*)\s*(?:<[^>]*>)?\(/gm)].map((m) => m[1]));
const NAMESPACE_METHODS = new Map();
for (const f of readdirSync(join(ROOT, 'packages/sdk/src/namespaces'))) {
  if (!f.endsWith('.ts') || f === 'types.ts' || f === 'index.ts') continue;
  NAMESPACE_METHODS.set(f.replace(/\.ts$/, ''), members(`packages/sdk/src/namespaces/${f}`));
}
const clientText = read(join(ROOT, 'packages/sdk/src/client.ts'));
const CLIENT_NAMESPACES = new Set([...clientText.matchAll(/readonly\s+([a-z]\w*)\s*[:?]/g)].map((m) => m[1]));
const CLIENT_METHODS = members('packages/sdk/src/client.ts');
const BUS_METHODS = members('packages/core/src/event-bus.ts');
const SESSION_METHODS = members('packages/sdk/src/session/semiont-session.ts');
const BROWSER_METHODS = members('packages/sdk/src/session/semiont-browser.ts');

const SCRIPTS = new Set();
for (const pj of [join(ROOT, 'package.json'),
  ...['packages', 'apps'].flatMap((d) => readdirSync(join(ROOT, d)).map((n) => join(ROOT, d, n, 'package.json')))]) {
  if (existsSync(pj)) for (const s of Object.keys(JSON.parse(read(pj)).scripts ?? {})) SCRIPTS.add(s);
}

// ── What each document says ───────────────────────────────────────────────────

const DOCS = [
  ...readdirSync(join(ROOT, 'packages/react-ui/docs')).filter((f) => f.endsWith('.md')).map((f) => `packages/react-ui/docs/${f}`),
  'packages/react-ui/README.md',
  ...readdirSync(join(ROOT, 'apps/browser/docs')).filter((f) => f.endsWith('.md')).map((f) => `apps/browser/docs/${f}`),
  'apps/browser/README.md',
];

/** Split a document into checked code, prose, and the line each piece starts on. */
function parse(text) {
  const code = []; const prose = [];
  const lines = text.split('\n');
  let fence = null; let buf = []; let start = 0;
  lines.forEach((line, i) => {
    const m = line.match(/^\s*```(.*)$/);
    if (m && fence === null) { fence = m[1].trim(); buf = []; start = i + 2; return; }
    if (m && fence !== null) {
      if (!/\bsketch\b/.test(fence)) code.push({ text: buf.join('\n'), line: start });
      fence = null; return;
    }
    if (fence !== null) buf.push(line); else prose.push({ text: line, line: i + 1 });
  });
  return { code, prose };
}
const lineOf = (block, index) => block.line + block.text.slice(0, index).split('\n').length - 1;

const findings = [];
function report(doc, line, kind, detail) {
  if (ALLOWLIST.has(`${doc}::${detail}`)) return;
  findings.push({ doc, line, kind, detail });
}

for (const doc of DOCS) {
  const abs = join(ROOT, doc);
  const text = read(abs);
  const { code, prose } = parse(text);
  const allCode = code.map((c) => c.text).join('\n');
  const local = new Set([...allCode.matchAll(/(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const imported = new Set();
  for (const m of allCode.matchAll(/import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s+from\s+['"][^'"]+['"]/g)) {
    for (const n of m[1].split(',')) imported.add(n.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim());
  }
  for (const m of allCode.matchAll(/import\s+([A-Z][\w$]*)\s+from\s+['"]/g)) imported.add(m[1]);
  const known = (n) => local.has(n) || imported.has(n) || ANYWHERE.has(n);

  for (const block of code) {
    for (const m of block.text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](@semiont\/[^'"]+)['"]/g)) {
      const exported = importable(m[2]);
      if (!exported) continue;
      for (const raw of m[1].split(',')) {
        const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (n && !exported.has(n)) report(doc, lineOf(block, m.index), 'import', `${n} (from ${m[2]})`);
      }
    }
    for (const m of block.text.matchAll(/(?<![\w.$])(use[A-Z][\w]*)\s*[(<]/g)) {
      if (!known(m[1]) && !REACT_HOOKS.has(m[1])) report(doc, lineOf(block, m.index), 'hook', m[1]);
    }
    for (const m of block.text.matchAll(/(?<![\w.$])<([A-Z][\w]*)(?=[\s/>])/g)) {
      if (!known(m[1]) && !REACT_COMPONENTS.has(m[1]) && !PLACEHOLDERS.has(m[1])) report(doc, lineOf(block, m.index), 'component', m[1]);
    }
    for (const m of block.text.matchAll(/\b(client|session\??\.client|semiont)\??\.([a-z]\w*)\??\.([a-z]\w*)\(/g)) {
      const [, recv, ns, method] = m;
      const at = lineOf(block, m.index);
      if (ns === 'bus') { if (!BUS_METHODS.has(method)) report(doc, at, 'sdk-call', `${recv}.bus.${method}()`); }
      else if (NAMESPACE_METHODS.has(ns)) { if (!NAMESPACE_METHODS.get(ns).has(method)) report(doc, at, 'sdk-call', `${recv}.${ns}.${method}()`); }
      else if (recv !== 'semiont' && !CLIENT_NAMESPACES.has(ns)) report(doc, at, 'sdk-call', `${recv}.${ns}.${method}() — no such namespace`);
    }
    for (const m of block.text.matchAll(/\b(client|session\??\.client)\??\.([a-z]\w*)\(/g)) {
      if (!CLIENT_METHODS.has(m[2])) report(doc, lineOf(block, m.index), 'sdk-call', `${m[1]}.${m[2]}() — not a SemiontClient method`);
    }
    for (const m of block.text.matchAll(/(?<![\w.$])session\??\.([a-z]\w*)\(/g)) {
      if (!SESSION_METHODS.has(m[1])) report(doc, lineOf(block, m.index), 'sdk-call', `session.${m[1]}() — not a SemiontSession method`);
    }
    for (const m of block.text.matchAll(/(?<![\w.$])semiont\.([a-z]\w*)\(/g)) {
      if (!BROWSER_METHODS.has(m[1]) && !CLIENT_METHODS.has(m[1])) report(doc, lineOf(block, m.index), 'sdk-call', `semiont.${m[1]}()`);
    }
    for (const m of block.text.matchAll(/(?:\b(?:emit|on|subscribe|stream|useEventSubscription)\(\s*|^\s*)['"]([a-z][a-z0-9-]*:[a-z0-9-]+)['"](\s*:\s*(?:\(|async|function|\{))?/gm)) {
      const usage = !m[0].trimStart().startsWith("'") && !m[0].trimStart().startsWith('"') || m[2];
      if (usage && !CHANNELS.has(m[1])) report(doc, lineOf(block, m.index), 'channel', m[1]);
    }
  }

  const checkText = (t, line) => {
    for (const m of t.matchAll(/['"`]([a-z][a-z0-9-]*:[a-z0-9-]+)['"`]/g)) {
      if (BUS_NAMESPACES.has(m[1].split(':')[0]) && !CHANNELS.has(m[1])) report(doc, line, 'channel', m[1]);
    }
    for (const m of t.matchAll(/npm run ([\w:.-]+)/g)) if (!SCRIPTS.has(m[1])) report(doc, line, 'script', m[1]);
    for (const m of t.matchAll(/(?:^|[\s`(['"])((?:packages|apps|scripts|specs|tests|docs|\.github)\/[\w.\-/[\]@]+\.[a-z]{2,5})(?=[\s`)'",:;]|$)/g)) {
      const pkgRoot = doc.startsWith('apps/browser') ? 'apps/browser' : 'packages/react-ui';
      if (![join(ROOT, m[1]), join(ROOT, pkgRoot, m[1])].some(existsSync)) report(doc, line, 'path', m[1]);
    }
    if (doc.startsWith('apps/browser')) {
      for (const m of t.matchAll(/(?:^|[\s`(['"])(src\/[\w.\-/[\]@]+\.[a-z]{2,5})(?=[\s`)'",:;]|$)/g)) {
        if (!existsSync(join(ROOT, 'apps/browser', m[1]))) report(doc, line, 'path', m[1]);
      }
    }
  };
  for (const block of code) block.text.split('\n').forEach((l, i) => checkText(l, block.line + i));
  for (const p of prose) {
    checkText(p.text, p.line);
    for (const m of p.text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target) || isAbsolute(target)) continue;
      let decoded = target; try { decoded = decodeURIComponent(target); } catch {}
      if (!existsSync(join(dirname(abs), decoded))) report(doc, p.line, 'link', target);
    }
  }
}

if (findings.length) {
  console.error(`\n✖ ${findings.length} name(s) in the documents resolve to nothing in the tree:\n`);
  for (const f of findings) console.error(`  ${f.doc}:${f.line}  ${f.kind.padEnd(9)} ${f.detail}`);
  console.error('\n  Correct the document, delete what describes something gone, or — for code that names');
  console.error('  what does not exist on purpose (a how-to, a roadmap) — mark its fence ```tsx sketch.');
  process.exit(1);
}
console.log(`✅ every name in ${DOCS.length} documents resolves (${CHANNELS.size} channels, ${ANYWHERE.size} exported names checked against)`);
