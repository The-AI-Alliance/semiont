#!/usr/bin/env node
/**
 * A browser withholds some APIs from a page that is not a secure context: one
 * served over plain http from any host but localhost. The launcher registers
 * such an origin for the Browser (the host's LAN address), so code a browser
 * can reach must not depend on them. `crypto.randomUUID` and `crypto.subtle`
 * are both withheld there, and nothing else in the tree says they are a
 * class.
 *
 * This census finds every use of a secure-context-only API in the sources a
 * browser can reach, and fails on any site not listed below with its role. A
 * listed site that is not there fails too: an allowlist that outlives
 * its sites stops describing the tree.
 *
 * Scanned: the TypeScript of apps/browser, packages/react-ui, packages/sdk and
 * packages/core, comments blanked. Not scanned: tests.
 */
import { readFileSync } from 'fs';
import { repositoryFiles } from './repository-files.mjs';
import { withoutComments } from './source-text.mjs';

const REACHABLE = ['apps/browser/src/', 'packages/react-ui/src/', 'packages/sdk/src/', 'packages/core/src/'];

const ALLOWED = {
  'packages/react-ui/src/lib/clipboard.ts': [
    'the one read of navigator.clipboard, returned as absent where the page has none: a copy control renders only where it is present',
  ],
  'packages/sdk/src/testing.ts': [
    'a test helper run in Node, where crypto.subtle always exists; no browser bundle reaches it',
  ],
};

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const TEST = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?tsx?$/;
const APIS = [
  { name: 'crypto.subtle', re: /\bcrypto\s*\.\s*subtle\b/g },
  { name: 'crypto.randomUUID', re: /\bcrypto\s*\.\s*randomUUID\b/g },
  { name: 'navigator.clipboard', re: /\bnavigator\s*\.\s*clipboard\b/g },
  { name: 'navigator.serviceWorker', re: /\bnavigator\s*\.\s*serviceWorker\b/g },
  { name: 'navigator.credentials', re: /\bnavigator\s*\.\s*credentials\b/g },
  { name: 'navigator.share', re: /\bnavigator\s*\.\s*share\b/g },
  { name: 'navigator.geolocation', re: /\bnavigator\s*\.\s*geolocation\b/g },
  { name: 'getUserMedia', re: /\bgetUserMedia\b/g },
];

const files = repositoryFiles(process.cwd())
  .filter((f) => REACHABLE.some((root) => f.startsWith(root)) && SOURCE.test(f) && !TEST.test(f));

const found = new Map();
for (const file of files) {
  let text;
  try {
    text = withoutComments(readFileSync(file, 'utf8'));
  } catch {
    continue; // tracked but deleted in the working tree
  }
  const sites = [];
  for (const { name, re } of APIS) {
    for (const m of text.matchAll(re)) {
      sites.push({ line: text.slice(0, m.index).split('\n').length, name });
    }
  }
  if (sites.length > 0) found.set(file, sites.sort((a, b) => a.line - b.line));
}

let failed = false;
for (const [file, sites] of found) {
  const roles = ALLOWED[file];
  if (!roles) {
    failed = true;
    console.error(`\n✖ ${file} uses an API a browser withholds outside a secure context:`);
    for (const s of sites) console.error(`    line ${s.line}: ${s.name}`);
  } else if (sites.length !== roles.length) {
    failed = true;
    console.error(`\n✖ ${file} uses such an API ${sites.length} time(s); the census lists ${roles.length}:`);
    for (const s of sites) console.error(`    line ${s.line}: ${s.name}`);
    for (const r of roles) console.error(`    listed: ${r}`);
  }
}
for (const [file, roles] of Object.entries(ALLOWED)) {
  if (!found.has(file)) {
    failed = true;
    console.error(`\n✖ ${file} is listed (${roles.join('; ')}) but no longer uses such an API — remove it from the census.`);
  }
}

if (failed) {
  console.error(
    '\n  The Browser is served from origins that are not secure contexts, where these\n' +
      '  APIs do not exist. Use what every page has (crypto.getRandomValues, the\n' +
      "  session's own SHA-256), or render the control only where the API is present.\n" +
      '  A site that is genuinely unreachable from a browser goes in ALLOWED with its role.\n',
  );
  process.exit(1);
}
const total = [...found.values()].reduce((n, s) => n + s.length, 0);
console.log(`✅ secure-context APIs: ${total} sites in ${found.size} files, each with its role`);
