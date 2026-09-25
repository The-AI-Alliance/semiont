#!/usr/bin/env node
/**
 * Every service image's NOTICE credits exactly the third-party components its
 * runtime stage ships — no fewer, no more.
 *
 * A NOTICE's component list restates, by hand, what the Dockerfile puts in the
 * image, and nothing kept the two in step. Both directions had drifted:
 * `tini` was installed by all eight service images and credited by none, and
 * the gateway's NOTICE kept crediting Git after the image stopped installing
 * it. Attribution that omits a shipped component is a licence obligation
 * unmet; attribution of one that is absent misdescribes the image.
 *
 * What an image ships is read from its Dockerfile's LAST stage — earlier
 * stages build and are discarded:
 *
 *   - the base image: `FROM node:<tag>-alpine` ships Node.js and Alpine Linux;
 *   - every package named by `apk add`;
 *   - every binary copied out of another image, `COPY --from=<registry/image:tag>`
 *     (a `--from` naming a build stage is not a component).
 *
 * What a NOTICE credits is its two-space-indented `<name> - <licence>` lines.
 * Four-space-indented lines are the npm section, whose shape differs per image
 * (installed packages, bundled libraries, font notices) and is not checked
 * here. Names match on their first word, case-insensitively, with a `.js`
 * suffix dropped: `Node.js` is `node`, `Typst (typesetting compiler, …)` is
 * `typst`.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPS = join(ROOT, 'apps');

const key = (name) => name.trim().toLowerCase().split(/[\s(]/)[0].replace(/\.js$/, '');

function shipped(dockerfile) {
  const source = dockerfile.replace(/\\\r?\n/g, ' ');
  const stages = source.split(/^FROM\s+/m).slice(1);
  const last = stages[stages.length - 1];
  if (!last) return null;
  const out = new Set();

  const [image] = last.split(/\s/);
  const [repo, tag = ''] = image.split(':');
  out.add(key(repo.split('/').pop()));
  if (tag.includes('alpine')) out.add('alpine');

  for (const [, args] of last.matchAll(/\bapk\s+add\b([^&;\n]*)/g)) {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '--virtual' || tokens[i] === '-t') { i++; continue; }
      if (!tokens[i].startsWith('-')) out.add(key(tokens[i].split('=')[0]));
    }
  }

  for (const [, ref] of last.matchAll(/\bCOPY\s+--from=(\S+)/g)) {
    if (!ref.includes('/') && !ref.includes(':')) continue;
    out.add(key(ref.split(':')[0].split('/').pop()));
  }
  return out;
}

function credited(notice) {
  const out = new Set();
  for (const [, name] of notice.matchAll(/^ {2}(\S[^\n]*?) - [^\n]*License/gm)) out.add(key(name));
  return out;
}

const problems = [];
let checked = 0;
for (const app of readdirSync(APPS).sort()) {
  const dockerfile = join(APPS, app, 'Dockerfile');
  const notice = join(APPS, app, 'NOTICE');
  if (!existsSync(dockerfile) || !existsSync(notice)) continue;

  const ships = shipped(readFileSync(dockerfile, 'utf-8'));
  const credits = credited(readFileSync(notice, 'utf-8'));
  if (!ships || credits.size === 0) {
    problems.push(`apps/${app}: could not read ${!ships ? 'a final stage from its Dockerfile' : 'any component from its NOTICE'}`);
    continue;
  }
  checked++;
  for (const c of ships) if (!credits.has(c)) problems.push(`apps/${app}/NOTICE does not credit "${c}", which the image ships`);
  for (const c of credits) if (!ships.has(c)) problems.push(`apps/${app}/NOTICE credits "${c}", which the image does not ship`);
}

if (checked === 0) {
  console.error('✗ lint:notice — no apps/<service>/ has both a Dockerfile and a NOTICE. Silence is not agreement.');
  process.exit(1);
}
if (problems.length > 0) {
  console.error('✗ lint:notice — a NOTICE disagrees with what its image ships:');
  for (const p of problems) console.error(`    ${p}`);
  console.error("  Credit what the Dockerfile's last stage installs, and nothing it does not.");
  process.exit(1);
}
console.log(`✓ lint:notice — ${checked} service images credit exactly what they ship`);
