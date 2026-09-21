#!/usr/bin/env node
/**
 * The realm's roles are each one string in two languages, and nothing makes
 * them agree.
 *
 * The launcher WRITES each into the realm's hardcoded-claim mapper; its fake
 * runtime emits it; `@semiont/core` holds the value and the predicate its
 * readers check it with. Change one and nothing fails to build — every call
 * gated on that role simply starts returning 401 (service role) or refusing
 * every job:claim (worker role) against a realm that looks correct in the
 * console. That is the failure this gate makes loud.
 *
 * The TypeScript readers live in core, so they cannot drift. Go cannot import
 * that module, and a fake runtime importing the production package to borrow a
 * literal would be a worse coupling than this check — so the remaining sites
 * are held together here.
 *
 * A site that cannot be found is a FAILURE, not a pass: the whole point is that
 * silence must not be mistaken for agreement.
 *
 * `semiont-service` (SERVICE_ROLE): the floor every service client carries — the
 * gateway gates `/api/tokens/agent` on it and the Archivist gates its read path.
 * `semiont-worker` (WORKER_ROLE): the grant only the worker client carries — the
 * dispatcher authorizes a `job:claim` by it (EXTRACT-JOBS P0).
 */
import { readFileSync } from 'fs';

const ROLES = [
  {
    label: 'service role',
    sites: [
      {
        file: 'apps/launcher/internal/launcher/identity.go',
        what: 'the realm mapper the launcher writes',
        pattern: /serviceRole\s*=\s*"([^"]+)"/,
      },
      {
        file: 'apps/launcher/internal/fakert/main.go',
        what: "the fake runtime's emitted claim",
        pattern: /roles\s*:=\s*\[\]string\{"([^"]+)"\}/,
      },
      {
        file: 'packages/core/src/service-role.ts',
        what: 'the value both TypeScript readers check',
        pattern: /SERVICE_ROLE\s*=\s*'([^']+)'/,
      },
    ],
  },
  {
    label: 'worker role',
    sites: [
      {
        file: 'apps/launcher/internal/launcher/identity.go',
        what: "the realm mapper's worker grant",
        pattern: /workerRole\s*=\s*"([^"]+)"/,
      },
      {
        file: 'apps/launcher/internal/fakert/main.go',
        what: "the fake runtime's worker grant",
        pattern: /append\(roles,\s*"([^"]+)"\)/,
      },
      {
        file: 'packages/core/src/service-role.ts',
        what: 'the value the dispatcher authorizes a job:claim by',
        pattern: /WORKER_ROLE\s*=\s*'([^']+)'/,
      },
    ],
  },
];

let failed = false;

for (const role of ROLES) {
  const found = [];
  const missing = [];

  for (const site of role.sites) {
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
    failed = true;
    console.error(`\n✖ the ${role.label} could not be read where it is supposed to live:\n`);
    for (const s of missing) {
      console.error(`  ${s.file}\n    ${s.what} — ${s.why}`);
    }
    console.error(
      '\n  If a site moved, move this gate with it. An unreadable site is a failure,\n' +
        '  because a gate that silently checks two of three things is not a gate.\n',
    );
    continue;
  }

  const values = [...new Set(found.map((s) => s.value))];
  if (values.length > 1) {
    failed = true;
    console.error(`\n✖ the ${role.label} disagrees across languages:\n`);
    for (const s of found) {
      console.error(`  ${s.value.padEnd(24)} ${s.file}\n${' '.repeat(27)}(${s.what})`);
    }
    console.error(
      '\n  One string, one realm. A mismatch refuses the calls gated on it while the\n' +
        '  realm looks correct in the console.\n',
    );
    continue;
  }

  console.log(`✅ ${role.label}: ${found.length} sites agree on "${values[0]}"`);
}

if (failed) process.exit(1);
