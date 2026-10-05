#!/usr/bin/env node
/**
 * Every name the builder's, the packages', the apps' and the protocol's documents use exists in the tree.
 *
 * Documents restate the code by hand, and this gate is what keeps the two in
 * step. Without it a document can import an export or call a client method
 * that does not exist, give a command missing from `package.json` or point at
 * a file that is not there: a reader copying any of them gets an error, and
 * nothing says the document is wrong.
 *
 * Checked in `docs/builder` (the guides, the skills and `react-ui`), the root `README.md`,
 * `packages/README.md`, every npm package's `README.md` and `docs`, `apps/README.md`, every
 * app's `README.md` and `docs`, `docs/protocol` and `docs/protocol/flows`:
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
 *   - `npm run` scripts exist, and repository paths and relative links name
 *     what the repository holds.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (`repository-files.mjs`,
 * as every lint here that asks): the files git tracks, and new ones it does
 * not ignore. The disk is never asked whether a path or a link resolves. The
 * disk also holds whatever this machine has built, so asking it gives one
 * verdict here and another in CI.
 *
 * A file git ignores is one a build makes. A document may name one as a path
 * where the manifest of the package it is in declares that the build produces
 * it (`main`, `module`, `types`, `bin`, a target of `exports`): the place to
 * find the server you just built. It may never link to one, since a reader of
 * the repository cannot open it. A generated file no manifest declares is
 * described by the committed source it is generated from.
 *
 * The documents read are the repository's too. Exported names are read from
 * each package's source as built, generated modules included, so this gate
 * runs after the build, as the doc-snippets gate does.
 *
 * THE ONE ESCAPE: a code fence whose info string includes `sketch` is not
 * checked. Use it for code that names what does not exist on purpose — a
 * how-to's new file, a roadmap — and say so in the fence: ```tsx sketch.
 * Everything else a document shows is a claim about the tree.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, normalize, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { repositoryFiles, ignoredByGit } from './repository-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(p, 'utf8');

// ── What the repository holds ─────────────────────────────────────────────────

const TREE = new Set(repositoryFiles(ROOT));
const TREE_DIRS = new Set();
for (const file of TREE) for (let d = dirname(file); d !== '.'; d = dirname(d)) TREE_DIRS.add(d);

/** The Markdown files directly in `dir`. */
const markdownIn = (dir) => [...TREE].filter((f) => f.endsWith('.md') && dirname(f) === dir);

/** The directory of the nearest manifest above `file`, or null when there is none. */
function manifestDirOf(file) {
  for (let d = dirname(file); ; d = dirname(d)) {
    if (TREE.has(d === '.' ? 'package.json' : `${d}/package.json`)) return d;
    if (d === '.') return null;
  }
}

/** The files a package's manifest declares its build produces. */
const builtMemo = new Map();
function builtFiles(dir) {
  if (builtMemo.has(dir)) return builtMemo.get(dir);
  const declared = new Set();
  builtMemo.set(dir, declared);
  const j = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  const add = (v) => {
    if (typeof v === 'string') declared.add(normalize(join(dir, v)));
    else if (v && typeof v === 'object') Object.values(v).forEach(add);
  };
  [j.main, j.module, j.types, j.typings, j.bin, j.exports].forEach(add);
  return declared;
}

/**
 * How a repository-relative path stands: `held` by the repository, a `built`
 * file its package's manifest declares, an `undeclared` one git ignores and
 * nothing vouches for, or `absent`.
 */
const standingMemo = new Map();
function standing(path) {
  const p = normalize(path).replace(/\/$/, '');
  if (standingMemo.has(p)) return standingMemo.get(p);
  let is;
  if (p === '.' || TREE.has(p) || TREE_DIRS.has(p)) is = 'held';
  else if (p.startsWith('..')) is = 'outside';
  else if (!ignoredByGit(ROOT, p)) is = 'absent';
  else {
    const dir = manifestDirOf(p);
    is = dir !== null && builtFiles(dir).has(p) ? 'built' : 'undeclared';
  }
  standingMemo.set(p, is);
  return is;
}
const WHY_NOT = {
  absent: 'not in the repository',
  outside: 'outside the repository',
  undeclared: 'git ignores it, so a build makes it, and no package manifest declares it; name the committed source it is generated from',
};
/** Why none of `standings` is good enough for a path, worst last. */
const why = (standings) => WHY_NOT[standings.includes('undeclared') ? 'undeclared' : standings.includes('outside') ? 'outside' : 'absent'];

// ── What the packages export ──────────────────────────────────────────────────

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
const COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const EXPORT_STAR = /export\s+\*\s+(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s+['"]([^'"]+)['"]/g;

function namesIn(text, names, stars) {
  for (const m of text.matchAll(EXPORT_DEF)) names.add(m[1]);
  for (const m of text.matchAll(EXPORT_LIST)) {
    // A list may carry comments between its names; they are not names.
    for (const part of m[1].replace(COMMENT, '').split(',')) {
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

/** Every npm package under `packages/`, by the name it is imported under. */
const NPM_PACKAGES = [...TREE].filter((f) => /^packages\/[^/]+\/package\.json$/.test(f)).map((f) => f.split('/')[1]);
const PACKAGE_SRC = Object.fromEntries(NPM_PACKAGES.map((dir) => [
  JSON.parse(read(join(ROOT, 'packages', dir, 'package.json'))).name,
  `packages/${dir}/src`,
]));
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
  ...['packages', 'apps', 'tests'].flatMap((d) => readdirSync(join(ROOT, d)).map((n) => join(ROOT, d, n, 'package.json')))]) {
  if (existsSync(pj)) for (const s of Object.keys(JSON.parse(read(pj)).scripts ?? {})) SCRIPTS.add(s);
}

// ── What each document says ───────────────────────────────────────────────────

/** The README of an app or a package, and the documents in its `docs` directory. */
const ownDocs = (dir) => [`${dir}/README.md`, ...markdownIn(`${dir}/docs`)];

const DOCS = [
  ...markdownIn('docs/builder'),
  'docs/builder/skills/README.md',
  ...[...TREE].filter((f) => /^docs\/builder\/skills\/[^/]+\/SKILL\.md$/.test(f)),
  'README.md',
  ...markdownIn('docs/builder/react-ui'),
  'packages/README.md',
  ...NPM_PACKAGES.flatMap((dir) => ownDocs(`packages/${dir}`)),
  'apps/README.md',
  ...[...TREE].filter((f) => /^apps\/[^/]+\/README\.md$/.test(f)).flatMap((f) => ownDocs(dirname(f))),
  ...markdownIn('docs/protocol'),
  ...markdownIn('docs/protocol/flows'),
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
    for (const n of m[1].replace(COMMENT, '').split(',')) imported.add(n.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim());
  }
  for (const m of allCode.matchAll(/import\s+([A-Z][\w$]*)\s+from\s+['"]/g)) imported.add(m[1]);
  const known = (n) => local.has(n) || imported.has(n) || ANYWHERE.has(n);
  // A package's document may hold a client or a session of its own — an
  // inference client, an MCP client, a graph driver's session. A name the
  // document declares from anything that is not the SDK's is not held to it.
  const itsOwn = (name) => [...allCode.matchAll(new RegExp(String.raw`(?:const|let|var)\s+${name}\s*(?::[^=\n]+)?=\s*([^;\n]+)`, 'g'))]
    .some((m) => !/semiont|createTest|\.client\b/i.test(m[1].split('(')[0]));
  const sdkClient = !itsOwn('client');
  const sdkSession = !itsOwn('session');

  for (const block of code) {
    for (const m of block.text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](@semiont\/[^'"]+)['"]/g)) {
      const exported = importable(m[2]);
      if (!exported) continue;
      for (const raw of m[1].replace(COMMENT, '').split(',')) {
        const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (n && !exported.has(n)) report(doc, lineOf(block, m.index), 'import', `${n} (from ${m[2]})`);
      }
    }
    for (const m of block.text.matchAll(/(?<![\w.$])(use[A-Z][\w]*)\s*[(<]/g)) {
      if (!known(m[1]) && !REACT_HOOKS.has(m[1])) report(doc, lineOf(block, m.index), 'hook', m[1]);
    }
    for (const m of block.text.matchAll(/(?<![\w.$])<([A-Z][\w]*)(?=[\s/>])/g)) {
      if (!known(m[1]) && !REACT_COMPONENTS.has(m[1])) report(doc, lineOf(block, m.index), 'component', m[1]);
    }
    for (const m of block.text.matchAll(/\b(client|session\??\.client|semiont)\??\.([a-z]\w*)\??\.([a-z]\w*)\(/g)) {
      const [, recv, ns, method] = m;
      if (recv === 'client' ? !sdkClient : recv !== 'semiont' && !sdkSession) continue;
      const at = lineOf(block, m.index);
      if (ns === 'bus') { if (!BUS_METHODS.has(method)) report(doc, at, 'sdk-call', `${recv}.bus.${method}()`); }
      else if (NAMESPACE_METHODS.has(ns)) { if (!NAMESPACE_METHODS.get(ns).has(method)) report(doc, at, 'sdk-call', `${recv}.${ns}.${method}()`); }
      else if (recv !== 'semiont' && !CLIENT_NAMESPACES.has(ns)) report(doc, at, 'sdk-call', `${recv}.${ns}.${method}() — no such namespace`);
    }
    for (const m of block.text.matchAll(/\b(client|session\??\.client)\??\.([a-z]\w*)\(/g)) {
      if (m[1] === 'client' ? !sdkClient : !sdkSession) continue;
      if (!CLIENT_METHODS.has(m[2])) report(doc, lineOf(block, m.index), 'sdk-call', `${m[1]}.${m[2]}() — not a SemiontClient method`);
    }
    for (const m of block.text.matchAll(/(?<![\w.$])session\??\.([a-z]\w*)\(/g)) {
      if (!sdkSession) continue;
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
      // A path is the repository's, or its document's own package's: a
      // README's `docs/TESTING.md` is the one beside it. The react-ui builder
      // docs live under docs/builder and still name react-ui's files.
      const pkgRoot = doc.startsWith('docs/builder/react-ui/') ? 'packages/react-ui' : doc.match(/^(?:apps|packages)\/[^/]+/)?.[0];
      const standings = [m[1], ...(pkgRoot ? [join(pkgRoot, m[1])] : [])].map(standing);
      if (!standings.some((is) => is === 'held' || is === 'built')) report(doc, line, 'path', `${m[1]} — ${why(standings)}`);
    }
    if (doc.startsWith('apps/browser')) {
      for (const m of t.matchAll(/(?:^|[\s`(['"])(src\/[\w.\-/[\]@]+\.[a-z]{2,5})(?=[\s`)'",:;]|$)/g)) {
        const is = standing(join('apps/browser', m[1]));
        if (is !== 'held') report(doc, line, 'path', `${m[1]} — ${why([is])}`);
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
      const is = standing(join(dirname(doc), decoded));
      if (is !== 'held') report(doc, p.line, 'link', `${target} — ${is === 'built' || is === 'undeclared' ? 'git ignores it, so a reader of the repository cannot open it' : why([is])}`);
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
