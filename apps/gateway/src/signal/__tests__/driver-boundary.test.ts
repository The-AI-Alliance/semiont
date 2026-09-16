/**
 * The signal driver's boundary gates (SIGNAL-PLANE D3 — enforced THREE
 * times, plus the mapping-mirror gate). A SECOND census, deliberately, not
 * an extension of the jobs one: `packages/jobs/src/__tests__/
 * driver-boundary.test.ts` walks `packages/jobs/src` and is structurally
 * blind to this app — the asymmetry the plan records (D1, corrected
 * 2026-09-15). Same policy, two instruments, each naming its own files.
 *
 * All four gates are MUTATION-PROVEN (P1 step 3): each was watched to fail
 * against a deliberate regression and restored by string-reverse — a gate
 * nobody has watched fail is a claim, not a gate.
 */
import { describe, test, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { JOBS_STREAM_SUBJECTS } from '@semiont/jobs';
import { SIGNAL_SUBJECT_PREFIX } from '../nats';

const SIGNAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(p)));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(SIGNAL_DIR, p);

describe('signal driver boundary', () => {
  test("gate 1 — the 'nats' client is imported by exactly the NATS driver", async () => {
    const importers: string[] = [];
    for (const file of await tsFiles(SIGNAL_DIR)) {
      const source = await fs.readFile(file, 'utf-8');
      if (/from ['"]nats['"]/.test(source)) importers.push(rel(file));
    }
    // The driver — the ONE module allowed to know the backend. Even the
    // fixture stays out: it spawns a server binary and probes TCP.
    expect(importers.sort()).toEqual(['nats.ts']);
  });

  test('gate 2 — the NATS driver makes no JetStream calls (client-side half of D3)', async () => {
    // CODE, not prose: the docstring legitimately names JetStream to ban it.
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const source = stripComments(await fs.readFile(path.join(SIGNAL_DIR, 'nats.ts'), 'utf-8'));
    // The API surface that would make the plane durable. `jetstream` covers
    // nc.jetstream()/jsm access; the policy/KV names cover the config route.
    for (const forbidden of [/jetstream/i, /\bjsm\b/, /AckPolicy/, /RetentionPolicy/, /DeliverPolicy/, /\bKV\b/]) {
      expect(forbidden.test(source), `nats.ts code matches forbidden ${forbidden}`).toBe(false);
    }
  });

  test('gate 3 — subject-space disjointness: the signal prefix and every JetStream stream filter cannot overlap', () => {
    // A stream is a SERVER-side subscription: a plain core publish into a
    // captured subject is persisted whatever API our driver called. This is
    // the gate the client-side two cannot provide.
    const filterRoot = (filter: string): string => filter.replace(/(\.\*|\.>|\*|>).*$/, '.');
    for (const filter of JOBS_STREAM_SUBJECTS) {
      const root = filterRoot(filter);
      const overlap =
        SIGNAL_SUBJECT_PREFIX.startsWith(root) || root.startsWith(SIGNAL_SUBJECT_PREFIX);
      expect(overlap, `signal prefix ${SIGNAL_SUBJECT_PREFIX} overlaps stream filter ${filter}`).toBe(false);
    }
  });

  test('gate 4 — the subject mapping is stated ONCE: the prefix literal lives only in the driver', async () => {
    for (const file of await tsFiles(SIGNAL_DIR)) {
      if (rel(file) === 'nats.ts') continue;
      const source = await fs.readFile(file, 'utf-8');
      expect(
        source.includes(`'${SIGNAL_SUBJECT_PREFIX}`) || source.includes(`"${SIGNAL_SUBJECT_PREFIX}`),
        `${rel(file)} restates the subject prefix — the mapping has ONE home`,
      ).toBe(false);
    }
  });

  test('gate 5 — the raw-bus request primitive never enters the gateway', async () => {
    // A gateway-internal busRequest over `asBusRequestPrimitive(eventBus)`
    // emits on a bus a remote plane never feeds: the request reaches no
    // remote actor and hangs its full timeout — the `yield:create`
    // starvation bug (.plans/bugs/
    // yield-create-unbridged-starves-resource-creation.md). The gateway's
    // one primitive is `requestPrimitiveFor` (plane-backed; bit-identical
    // over the in-process driver). CODE, not prose: comments may name the
    // banned symbol to explain this very ban.
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const gatewaySrc = path.join(SIGNAL_DIR, '..');
    const self = fileURLToPath(import.meta.url);
    for (const file of await tsFiles(gatewaySrc)) {
      if (file === self) continue; // the instrument names its own ban
      const source = stripComments(await fs.readFile(file, 'utf-8'));
      expect(
        source.includes('asBusRequestPrimitive'),
        `${path.relative(gatewaySrc, file)} uses the raw-bus request primitive — gateway requests ride requestPrimitiveFor`,
      ).toBe(false);
    }
  });
});
