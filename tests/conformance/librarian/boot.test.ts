/**
 * How a Librarian starts, answers for itself and stops (LIBRARIAN.md §
 * Settings, § Boot, § Health, § Stopping): what its health reports, that it
 * stops cleanly, every setting it refuses to start without or refuses the
 * value of, and that it gives up when the gateway does not answer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibrarianSettings } from '../harness/librarian-process';
import { eachLibrarian } from '../harness/librarian-world';
import { SPEC_SOURCE } from '../harness/paths';

/** How long a held job may show no activity before its holder calls it stalled: the bound a gather's waits must end under. */
function heldJobStallMs(): number {
  const table = JSON.parse(readFileSync(join(SPEC_SOURCE, 'client/timing.json'), 'utf8')) as { timing: Array<{ name: string; value: number }> };
  const row = table.timing.find((entry) => entry.name === 'heldJobStallMs');
  if (row === undefined) throw new Error('specs/src/client/timing.json has no heldJobStallMs');
  return row.value;
}

/** What a Librarian says of a member its configuration document lacks: the words every service that reads a document refuses one with. */
const missing = (member: string): RegExp => new RegExp(`Missing required property: ${member}\\b`);

/**
 * Each way a Librarian's settings can be ones it refuses to start on: the
 * settings changed that way, and what its refusal names. A setting a case
 * takes away is a member the document lacks, and the refusal names the
 * member.
 */
const REFUSED: ReadonlyArray<[how: string, changed: (settings: LibrarianSettings) => LibrarianSettings, named: RegExp]> = [
  ["without the gateway's address", (settings) => ({ ...settings, gatewayUrl: undefined }), missing('gatewayUrl')],
  ['without the issuer', (settings) => ({ ...settings, issuer: undefined }), missing('issuer')],
  ["without the knowledge base's name", (settings) => ({ ...settings, kbName: undefined }), missing('kbName')],
  ['without the state volume', (settings) => ({ ...settings, stateHome: undefined }), missing('stateHome')],
  ["without the Archivist's address", (settings) => ({ ...settings, archivist: undefined }), missing('archivist')],
  ['without a graph database', (settings) => ({ ...settings, graph: undefined }), missing('graph')],
  ['without a vector database', (settings) => ({ ...settings, vectors: undefined }), missing('vectors')],
  ['without an embedding provider', (settings) => ({ ...settings, embedding: undefined }), missing('embedding')],
  ["without the Matcher's model", (settings) => ({ ...settings, matcher: undefined }), missing('matcher')],
  ["without the Gatherer's model", (settings) => ({ ...settings, gatherer: undefined }), missing('gatherer')],
  // A store in one process's memory could not be shared with the service that writes it.
  ["on a graph that lives in one process's memory", (settings) => ({ ...settings, graph: { type: 'memory' } }), /graph\.type is memory/],
  ["on a vector index that lives in one process's memory", (settings) => ({ ...settings, vectors: { type: 'memory' } }), /vectors\.type is memory/],
  // A gather's two waits, for the graph and for the vectors, must both end before a worker that holds a job is called stalled.
  ['on a settle bound as long as the stall of a held job', (settings) => ({ ...settings, settleTimeoutMs: heldJobStallMs() }), /gather\.settleTimeoutMs must be less than/],
  ['on a settle bound of no time at all', (settings) => ({ ...settings, settleTimeoutMs: 0 }), /gather\.settleTimeoutMs/],
];

eachLibrarian('a Librarian, as a process', (world) => {
  it('answers at its health port for itself and for the two actors it runs', async () => {
    expect(await world().librarian.health()).toEqual({ status: 'ok', actors: ['matcher', 'gatherer'] });
  });

  it('stops when it is told to, and says nothing is wrong by its exit', async () => {
    expect(await world().stopLibrarian()).toBe(0);
    await world().startLibrarian();
  });

  describe('started on settings or an environment it cannot run on', () => {
    // Each of these is a Librarian of its own, given the health port the world's is given: the world's is stopped while they run.
    beforeAll(async () => {
      await world().stopLibrarian();
    });
    afterAll(async () => {
      await world().startLibrarian();
    });

    it.each(REFUSED)('refuses to start %s, and names the setting', async (_how, changed, named) => {
      const { code, output } = await world().refused({ settings: changed(world().settings) });
      expect(code).not.toBe(0);
      expect(output).toMatch(named);
    });

    it.each(['SEMIONT_OIDC_CLIENT_ID', 'SEMIONT_OIDC_CLIENT_SECRET'])('refuses to start without %s, half of its service account, and names it', async (variable) => {
      const { code, output } = await world().refused({ env: { ...world().launch().env, [variable]: undefined } });
      expect(code).not.toBe(0);
      expect(output).toContain(variable);
    });

    it("refuses to start without the graph database's password, and names the variable its settings name", async () => {
      const { code, output } = await world().refused({ env: { ...world().launch().env, NEO4J_PASSWORD: undefined } });
      expect(code).not.toBe(0);
      expect(output).toContain('NEO4J_PASSWORD');
    });

    it('gives up, and exits saying where it was told the gateway is, when the gateway does not answer', async () => {
      // A port nothing listens on. A Librarian tries to sign in there a bounded number of times, which may be once, then ends.
      const { code, output } = await world().refused({ settings: { ...world().settings, gatewayUrl: 'http://127.0.0.1:9' } }, 120_000);
      expect(code).not.toBe(0);
      expect(output).toMatch(/127\.0\.0\.1:9/);
    }, 150_000);
  });
});
