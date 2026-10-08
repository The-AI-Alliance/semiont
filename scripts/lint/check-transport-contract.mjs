#!/usr/bin/env node
/**
 * lint:transport-contract — the contract documents and the conformance
 * corpus name each other truthfully. The documents are the two transport
 * ones, the worker contract and the Worker service's.
 *
 * - Every rule's `*Held by …*` in docs/protocol/TRANSPORT-CONTRACT.md,
 *   TRANSPORT-HTTP.md, WORKER-CONTRACT.md and WORKER-SERVICE.md names cases
 *   that exist: `sdk/wire/<case>`, `sdk/live/<case>` (a file, or a case built
 *   from a row of specs/src/client/refresh.json), `worker/<case>`,
 *   `worker-service/<case>`, `gateway/<file>`, `dispatcher/<file>`, or a path
 *   in the repository. One that names nothing says "no case".
 * - Every wire case of the SDK suite is named by one of the two documents: a
 *   case holds a client to something, and the contract is where that is said.
 * - Every case of the worker suite is named by a rule of the worker contract,
 *   and its `source` names a section of that contract in which a rule is held
 *   by it.
 * - Every case of the worker-service suite, a `<case>.test.ts` file, is named
 *   by a rule of the Worker service's document, and the comment that heads it
 *   names sections of that document, each a heading there, in one of which a
 *   rule is held by it.
 * - Every SDK case's `source` names files that exist, and sections that are
 *   headings of the document it cites. A wire case's names a section of a
 *   transport document in which a rule is held by that case: the case and the
 *   rule point at each other.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKER_SERVICE_DOC = 'docs/protocol/WORKER-SERVICE.md';
const DOCS = ['docs/protocol/TRANSPORT-CONTRACT.md', 'docs/protocol/TRANSPORT-HTTP.md', 'docs/protocol/WORKER-CONTRACT.md', WORKER_SERVICE_DOC];
const SDK = 'tests/conformance/sdk';
const WORKER = 'tests/conformance/worker/cases';
const WORKER_SERVICE = 'tests/conformance/worker-service';
const failures = [];
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const jsonIn = (dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
const casesIn = (layer) => jsonIn(`${SDK}/${layer}`);

const wire = casesIn('wire');
const live = casesIn('live');
const worker = jsonIn(WORKER);
const workerService = readdirSync(join(ROOT, WORKER_SERVICE)).filter((f) => f.endsWith('.test.ts')).map((f) => f.slice(0, -'.test.ts'.length));
const built = JSON.parse(read('specs/src/client/refresh.json')).refresh.map(
  (row) => `refresh-${row.on.replaceAll(':', '-')}${row.when === undefined ? '' : `-${row.when}`}`,
);

// ── what the documents say holds each rule ─────────────────────────────────
const named = new Set();
/** For each document and section (a heading, or any heading above it), what the rules under it are held by. */
const heldUnder = new Map();
let rules = 0;
for (const doc of DOCS) {
  const above = [];
  for (const line of read(doc).split('\n')) {
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      above.length = heading[1].length - 1;
      above[heading[1].length - 1] = heading[2].replaceAll('`', '').trim();
      continue;
    }
    const held = /\*Held by ([^*]+)\*/.exec(line)?.[1];
    if (held === undefined) continue;
    rules++;
    const tokens = [...held.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const section of above.filter(Boolean)) {
      const key = `${doc} § ${section}`;
      heldUnder.set(key, new Set([...(heldUnder.get(key) ?? []), ...tokens]));
    }
    if (tokens.length === 0) {
      if (!/^no case\.$/.test(held.trim())) failures.push(`${doc}: "Held by ${held.trim()}" names no case and does not say "no case."`);
      continue;
    }
    for (const token of tokens) {
      named.add(token);
      const [suite, layer, name] = token.split('/');
      const exists =
        suite === 'sdk' && layer === 'wire' ? wire.includes(name)
        : suite === 'sdk' && layer === 'live' ? live.includes(name) || built.includes(name)
        : suite === 'worker' && name === undefined ? worker.includes(layer)
        : suite === 'worker-service' && name === undefined ? workerService.includes(layer)
        : suite === 'gateway' || suite === 'dispatcher' ? existsSync(join(ROOT, 'tests/conformance', token))
        : existsSync(join(ROOT, token));
      if (!exists) failures.push(`${doc}: a rule is held by \`${token}\`, which does not exist`);
    }
  }
}
if (rules === 0) failures.push('no contract document states what holds a rule');

for (const name of wire) {
  if (!named.has(`sdk/wire/${name}`)) failures.push(`${SDK}/wire/${name}.json holds a client to something neither transport document states: no rule is held by \`sdk/wire/${name}\``);
}

for (const name of worker) {
  if (!named.has(`worker/${name}`)) failures.push(`${WORKER}/${name}.json holds a worker to something the worker contract does not state: no rule is held by \`worker/${name}\``);
}

for (const name of workerService) {
  if (!named.has(`worker-service/${name}`)) failures.push(`${WORKER_SERVICE}/${name}.test.ts holds a Worker service to something its document does not state: no rule is held by \`worker-service/${name}\``);
}

// ── what each case says it is a case of ────────────────────────────────────
const headings = new Map();
const headingsOf = (doc) => {
  if (!headings.has(doc)) {
    headings.set(doc, read(doc).split('\n').filter((line) => /^#{1,6} /.test(line)).map((line) => line.replace(/^#+ /, '').replaceAll('`', '').trim()));
  }
  return headings.get(doc);
};
/**
 * The sections of `doc` that `said` cites: after each `§ `, the longest
 * heading there that the text goes on with. A heading may have a comma in it,
 * so a citation is matched against the headings and never cut at a mark. One
 * that goes on with no heading is a failure, said as `what` of `where`.
 */
const sectionsCited = (said, doc, where, what) => {
  const text = said.replaceAll('`', '').replace(/\s+/g, ' ');
  const longestFirst = [...headingsOf(doc)].sort((a, b) => b.length - a.length);
  const cited = [];
  for (const { index } of text.matchAll(/§ /g)) {
    const after = text.slice(index + 2);
    const heading = longestFirst.find((h) => after.startsWith(h) && /^($|[,):;.]| \()/.test(after.slice(h.length)));
    if (heading === undefined) failures.push(`${where}: ${what} names ${doc} § ${after.split(/[,():;.]/)[0].trim()}, which is not a heading there`);
    else cited.push(heading);
  }
  return cited;
};
const timing = new Set(JSON.parse(read('specs/src/client/timing.json')).timing.map((entry) => entry.name));

/** Each corpus: where its cases are, the token a rule names one by, and whether a case and a rule must point at each other. */
const CORPORA = [
  { dir: `${SDK}/wire`, token: 'sdk/wire', mutual: true },
  { dir: `${SDK}/live`, token: 'sdk/live', mutual: false },
  { dir: WORKER, token: 'worker', mutual: true },
];
for (const corpus of CORPORA) {
  for (const name of jsonIn(corpus.dir)) {
    const where = `${corpus.dir}/${name}.json`;
    const { source } = JSON.parse(read(where));
    let mutual = false;
    for (const part of source.split(';').map((p) => p.trim())) {
      const [first, ...rest] = part.split(' ');
      if (!first.includes('/')) continue; // a schema's name
      const path = first.replace(/:$/, '');
      if (!path.includes('{') && !existsSync(join(ROOT, path))) {
        failures.push(`${where}: its source names ${path}, which does not exist`);
        continue;
      }
      const said = rest.join(' ');
      if (path.endsWith('.md')) {
        for (const heading of sectionsCited(said, path, where, 'its source')) {
          if (heldUnder.get(`${path} § ${heading}`)?.has(`${corpus.token}/${name}`)) mutual = true;
        }
        for (const [, clause] of said.matchAll(/\b(B\d+[a-z]?)\b/g)) {
          if (!headingsOf(path).some((heading) => heading.startsWith(`${clause} —`))) failures.push(`${where}: its source names ${path} ${clause}, which is not a clause there`);
        }
      } else if (path === 'specs/src/client/timing.json') {
        for (const entry of said.split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!timing.has(entry)) failures.push(`${where}: its source names ${entry}, which specs/src/client/timing.json does not have`);
        }
      }
    }
    if (corpus.mutual && !mutual) failures.push(`${where}: its source names no section of a contract document whose rule is held by \`${corpus.token}/${name}\``);
  }
}

// A worker-service case is a test file: the comment that heads it says which sections it is a case of.
for (const name of workerService) {
  const where = `${WORKER_SERVICE}/${name}.test.ts`;
  const head = /^\/\*\*([\s\S]*?)\*\//.exec(read(where))?.[1];
  if (head === undefined) {
    failures.push(`${where}: no comment heads it to say which sections of ${WORKER_SERVICE_DOC} it is a case of`);
    continue;
  }
  const said = head.split('\n').map((line) => line.replace(/^\s*\* ?/, '')).join(' ');
  if (!said.includes('§ ')) failures.push(`${where}: the comment that heads it names no section of ${WORKER_SERVICE_DOC}`);
  const sections = sectionsCited(said, WORKER_SERVICE_DOC, where, 'the comment that heads it');
  if (sections.length > 0 && !sections.some((section) => heldUnder.get(`${WORKER_SERVICE_DOC} § ${section}`)?.has(`worker-service/${name}`))) {
    failures.push(`${where}: the comment that heads it names no section of ${WORKER_SERVICE_DOC} whose rule is held by \`worker-service/${name}\``);
  }
}

if (failures.length > 0) {
  console.error(`❌ lint:transport-contract — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ lint:transport-contract — ${rules} rules in ${DOCS.length} documents name cases that exist; all ${wire.length} wire cases, ${worker.length} worker cases and ${workerService.length} worker-service cases are named by a rule; every case's source names what exists`);
