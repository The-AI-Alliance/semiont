#!/usr/bin/env node
/**
 * `semiont-service` is one string in two languages, and nothing makes them agree.
 *
 * The launcher WRITES it into the realm's hardcoded-claim mapper; its fake
 * runtime emits it; `@semiont/core` holds the value and the predicate the
 * gateway and the Archivist both read it with. Change one and nothing fails to
 * build — every service-to-service call simply starts returning 401 against a
 * realm that looks correct in the console. That is the failure this gate makes
 * loud.
 *
 * The two TypeScript readers were collapsed into core, so they cannot drift.
 * Go cannot import that module, and a fake runtime importing the production
 * package to borrow a literal would be a worse coupling than this check — so
 * the remaining three sites are held together here.
 *
 * A site that cannot be found is a FAILURE, not a pass: the whole point is
 * that silence must not be mistaken for agreement.
 */
import { readFileSync } from 'fs';

const SITES = [
  {
    file: 'apps/launcher/internal/launcher/identity.go',
    what: 'the realm mapper the launcher writes',
    pattern: /serviceRole\s*=\s*"([^"]+)"/,
  },
  {
    file: 'apps/launcher/internal/fakert/main.go',
    what: "the fake runtime's emitted claim",
    pattern: /"roles":\s*\[\]string\{"([^"]+)"\}/,
  },
  {
    file: 'packages/core/src/service-role.ts',
    what: 'the value both TypeScript readers check',
    pattern: /SERVICE_ROLE\s*=\s*'([^']+)'/,
  },
];

const found = [];
const missing = [];

for (const site of SITES) {
  let source;
  try {
    source = readFileSync(site.file, 'utf8');
  } catch {
    missing.push({ ...site, why: 'file not found' });
    continue;
  }
  const m = site.pattern.exec(source);
  if (m === null) {
    missing.push({ ...site, why: 'no declaration matched' });
    continue;
  }
  found.push({ ...site, value: m[1] });
}

if (missing.length > 0) {
  console.error('\n✖ the service role could not be read where it is supposed to live:\n');
  for (const s of missing) {
    console.error(`  ${s.file}\n    ${s.what} — ${s.why}`);
  }
  console.error(
    '\n  If a site moved, move this gate with it. An unreadable site is a failure,\n' +
      '  because a gate that silently checks two of three things is not a gate.\n',
  );
  process.exit(1);
}

const values = [...new Set(found.map((s) => s.value))];
if (values.length > 1) {
  console.error('\n✖ the service role disagrees across languages:\n');
  for (const s of found) {
    console.error(`  ${s.value.padEnd(24)} ${s.file}\n${' '.repeat(27)}(${s.what})`);
  }
  console.error(
    '\n  One string, one realm. The launcher stamps it and the gateway and Archivist\n' +
      '  check it; a mismatch refuses every service-to-service call while the realm\n' +
      '  looks correct in the console.\n',
  );
  process.exit(1);
}

console.log(`✅ service role: ${found.length} sites agree on "${values[0]}"`);
