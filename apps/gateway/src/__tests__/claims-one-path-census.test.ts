/**
 * Census gate (LEDGER-STATE-TO-THE-BROKER P4): a claim reaches other replicas
 * one way — the shared claims table — and the announcement protocol it
 * replaced stays gone.
 *
 * Two paths for one fact is two answers to "which replicas know this claim",
 * and the second would be a live protocol nobody tests against the first.
 * The reserved client name went with it: it protected a shared address that
 * no longer exists, and a refusal left defending against something that
 * cannot occur is a check nobody can explain.
 *
 * Scans gateway PRODUCTION source only, with comments stripped so only code
 * counts. The one path must also be FOUND: a census that passes on silence
 * would pass on the table being deleted.
 */
import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const GATEWAY_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const CODE = productionFiles(GATEWAY_SRC).map((f) => ({ f, code: stripComments(readFileSync(f, 'utf-8')) }));

describe('claims reach other replicas one way (LEDGER-STATE-TO-THE-BROKER P4)', () => {
  test.each([
    'LEDGER_ADDRESS',
    'CLAIM_CHANNEL',
    "'ledger:",
    'observeClaim',
    'announcementFor',
    'ClaimAnnouncement',
    'is reserved',
  ])('gateway production code does not contain %s', (fragment) => {
    const offenders = CODE.filter(({ code }) => code.includes(fragment)).map(({ f }) => f);
    expect(offenders, `${fragment} is back in gateway production code`).toEqual([]);
  });

  test('the ledger keeps its claims in the plane\'s shared table', () => {
    const ledger = CODE.find(({ f }) => f.endsWith(join('signal', 'ledger.ts')));
    expect(ledger?.code, 'signal/ledger.ts opens a shared table').toMatch(/plane\.table\(/);
  });
});
