#!/usr/bin/env node
/**
 * The broker stays replaceable: the code that talks to NATS is the code that
 * implements an interface in front of it, and nothing else.
 *
 * The gateway reaches the broker through its signal plane (`SignalPlane` and
 * `SharedTable`, apps/gateway/src/signal/mod.rs); the dispatcher's job queue
 * through `JobQueue` (packages/jobs/src/job-queue-interface.ts). Each has a
 * NATS implementation and a second one. A module that used the NATS client
 * beside them would tie the rest to the broker, and nothing would say so. So:
 *
 *   - the `async_nats` crate is named only in the gateway's NATS plane;
 *   - that plane (`signal::nats`, `NatsPlane`) is named only where the plane
 *     is chosen, the composition in app.rs;
 *   - the `nats` npm client (or `@nats-io/*`) is imported only by the
 *     JetStream job queue.
 *
 * Production code only: a test may name the broker, and the conformance
 * suite's harness starts one. Each allowed file must still use what it is
 * allowed, so an entry cannot outlive the implementation it was for.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutComments } from './source-text.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const gatewaySource = (file) => file.startsWith('apps/gateway/src/') && file.endsWith('.rs');
const javascriptSource = (file) =>
  /^(apps|packages)\//.test(file) &&
  /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) &&
  !/(^|\/)__tests__\/|\.(test|spec)\.[^/]+$/.test(file);

const RULES = [
  {
    what: 'the async_nats crate',
    uses: /\basync_nats\b/,
    scope: gatewaySource,
    allowed: ['apps/gateway/src/signal/nats.rs'],
  },
  {
    what: "the gateway's NATS plane",
    uses: /\bsignal::nats\b|\bNatsPlane\b/,
    scope: gatewaySource,
    allowed: ['apps/gateway/src/app.rs', 'apps/gateway/src/signal/nats.rs'],
  },
  {
    what: 'the nats npm client',
    uses: /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](?:nats|@nats-io\/[^'"]+)['"]/m,
    scope: javascriptSource,
    allowed: ['packages/jobs/src/jetstream-job-queue.ts'],
  },
];

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const text = new Map();
const source = (file) => {
  if (!text.has(file)) text.set(file, withoutComments(readFileSync(join(ROOT, file), 'utf8')));
  return text.get(file);
};

const problems = [];
for (const rule of RULES) {
  for (const file of tracked) {
    if (!rule.scope(file) || rule.allowed.includes(file)) continue;
    if (rule.uses.test(source(file))) problems.push(`${file} uses ${rule.what}, which only ${rule.allowed.join(' and ')} may`);
  }
  for (const file of rule.allowed) {
    if (!tracked.includes(file)) problems.push(`${file} is allowed ${rule.what}, and is gone`);
    else if (!rule.uses.test(source(file))) problems.push(`${file} is allowed ${rule.what}, and no longer uses it: drop it from the rule`);
  }
}

if (problems.length > 0) {
  console.error('✗ lint:broker-boundary — the broker is reached around its interface:');
  for (const p of problems) console.error(`    ${p}`);
  console.error('  Reach the broker through SignalPlane/SharedTable (the gateway) or JobQueue (the job queue).');
  process.exit(1);
}
console.log('✓ lint:broker-boundary — async_nats only in the gateway\'s NATS plane, that plane chosen only in app.rs, and the nats client only in the JetStream job queue');
