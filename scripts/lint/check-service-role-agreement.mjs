#!/usr/bin/env node
/**
 * The realm's roles are each one string in two languages, and nothing makes
 * them agree.
 *
 * The launcher WRITES each into the realm's hardcoded-claim mapper; its fake
 * runtime emits it; the Rust SDK holds the value the gateway and the
 * dispatcher check. Change one and nothing fails to build — every call
 * gated on that role simply starts returning 401 (service role) or refusing
 * every job:claim (worker role) against a realm that looks correct in the
 * console. That is the failure this gate makes loud.
 *
 * Go cannot import the Rust SDK, and a fake runtime importing the production
 * package to borrow a literal would be a worse coupling than this check, so
 * the sites are held together here.
 *
 * A site that cannot be found is a FAILURE, not a pass: the whole point is that
 * silence must not be mistaken for agreement.
 *
 * `semiont-service` (SERVICE_ROLE): the floor every service client carries — the
 * Archivist gates its read path on it.
 * `semiont-worker` (WORKER_ROLE): the grant only the worker client carries — the
 * dispatcher authorizes a `job:claim` by it.
 *
 * The spec names roles too: a limit on a principal states a coefficient per
 * role (`x-semiont-limits`, `roles`). A role named there that is none of these
 * would bind no one, silently, so every one must be an agreed role.
 *
 * The claim that marks an agent's account is held the same way, its name and
 * the value it holds: the launcher writes it into the realm, its fake runtime
 * emits it, and the Rust SDK holds what the gateway names an agent by. It is a
 * kind, not a role, so a limit cannot name it.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROLES = [
  {
    label: 'service role',
    sites: [
      {
        file: 'packages/go/launcher/identity.go',
        what: 'the realm mapper the launcher writes',
        pattern: /serviceRole\s*=\s*"([^"]+)"/,
      },
      {
        file: 'packages/go/launcher/fakert/main.go',
        what: "the fake runtime's emitted claim",
        pattern: /roles\s*:=\s*\[\]string\{"([^"]+)"\}/,
      },
      {
        file: 'packages/rust/sdk/src/roles.rs',
        what: 'the value the Rust SDK holds, which the Archivist gates its read path on',
        pattern: /SERVICE_ROLE:\s*&str\s*=\s*"([^"]+)"/,
      },
    ],
  },
  {
    label: 'worker role',
    sites: [
      {
        file: 'packages/go/launcher/identity.go',
        what: "the realm mapper's worker grant",
        pattern: /workerRole\s*=\s*"([^"]+)"/,
      },
      {
        file: 'packages/go/launcher/fakert/main.go',
        what: "the fake runtime's worker grant",
        pattern: /append\(roles,\s*"([^"]+)"\)/,
      },
      {
        file: 'packages/rust/sdk/src/roles.rs',
        what: 'the grant the Rust SDK holds: the dispatcher authorizes a job:claim by it, and the Archivist refuses a write from its holder that cites no jobId',
        pattern: /WORKER_ROLE:\s*&str\s*=\s*"([^"]+)"/,
      },
    ],
  },
  {
    label: 'kind claim',
    role: false,
    sites: [
      {
        file: 'packages/go/launcher/identity.go',
        what: "the claim the realm's kind mapper stamps",
        pattern: /kindClaim\s*=\s*"([^"]+)"/,
      },
      {
        file: 'packages/go/launcher/fakert/main.go',
        what: "the fake runtime's emitted kind claim",
        pattern: /kindClaim, agentKind := "([^"]+)"/,
      },
      {
        file: 'packages/rust/sdk/src/roles.rs',
        what: 'the claim the gateway reads an account\'s kind from',
        pattern: /KIND_CLAIM:\s*&str\s*=\s*"([^"]+)"/,
      },
    ],
  },
  {
    label: 'agent kind',
    role: false,
    sites: [
      {
        file: 'packages/go/launcher/identity.go',
        what: "the value the realm's kind mapper stamps on an agent's account",
        pattern: /agentKind\s*=\s*"([^"]+)"/,
      },
      {
        file: 'packages/go/launcher/fakert/main.go',
        what: "the fake runtime's emitted agent kind",
        pattern: /kindClaim, agentKind := "[^"]+", "([^"]+)"/,
      },
      {
        file: 'packages/rust/sdk/src/roles.rs',
        what: 'the value the gateway names an agent by',
        pattern: /AGENT_KIND:\s*&str\s*=\s*"([^"]+)"/,
      },
    ],
  },
];

let failed = false;
const agreed = [];

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
  if (role.role !== false) agreed.push(values[0]);
}

const PATHS = 'specs/src/paths';
const named = [];
for (const file of readdirSync(PATHS).filter((f) => f.endsWith('.json'))) {
  const item = JSON.parse(readFileSync(join(PATHS, file), 'utf8'));
  for (const op of Object.values(item)) {
    for (const [key, limit] of Object.entries(op?.['x-semiont-limits'] ?? {})) {
      for (const role of Object.keys(limit?.roles ?? {})) named.push({ role, where: `${join(PATHS, file)} x-semiont-limits.${key}` });
    }
  }
}
const unknown = named.filter((n) => !agreed.includes(n.role));
if (unknown.length > 0) {
  failed = true;
  console.error(`\n✖ the spec's limits name roles the realm does not know (${agreed.join(', ')}):\n`);
  for (const n of unknown) console.error(`  ${n.role.padEnd(24)} ${n.where}`);
} else if (named.length > 0) {
  console.log(`✅ the spec's limits name only agreed roles (${named.length} coefficients)`);
}

if (failed) process.exit(1);
