/**
 * How a Librarian starts, answers for itself and stops (LIBRARIAN.md §
 * Settings, § Boot, § Health, § Stopping): what its health reports, that it
 * stops cleanly, every setting it refuses to start without or refuses the
 * value of, and that it gives up when the gateway does not answer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibrarianService, LibrarianSettings } from '../harness/librarian-process';
import { eachLibrarian } from '../harness/librarian-world';
import { SPEC_SOURCE } from '../harness/paths';

/** How long a held job may show no activity before its holder calls it stalled: the bound a gather's waits must end under. */
function heldJobStallMs(): number {
  const table = JSON.parse(readFileSync(join(SPEC_SOURCE, 'client/timing.json'), 'utf8')) as { timing: Array<{ name: string; value: number }> };
  const row = table.timing.find((entry) => entry.name === 'heldJobStallMs');
  if (row === undefined) throw new Error('specs/src/client/timing.json has no heldJobStallMs');
  return row.value;
}

/**
 * What a refusal must say, for each form a Librarian is given its settings
 * in. A refusal names the setting as its Librarian is told it: one that reads
 * a `.semiontconfig` names a key or a section of that file, and one that reads
 * a configuration document names a member of the document, in the words every
 * service that reads a document refuses one with.
 */
type Named = Readonly<Record<LibrarianService['configuredBy'], readonly RegExp[]>>;

/** What a Librarian that reads a document says of a member the document lacks. */
const missing = (member: string): readonly RegExp[] => [new RegExp(`Missing required property: ${member}\\b`)];

/**
 * Each way a Librarian's settings can be ones it refuses to start on: the
 * settings changed that way, and what its refusal names. A setting a case
 * takes away is a key or a section the `.semiontconfig` lacks, and a member
 * the document lacks. The state volume is a variable the first Librarian's
 * environment lacks, and a member the second's document lacks.
 */
const REFUSED: ReadonlyArray<[how: string, changed: (settings: LibrarianSettings) => LibrarianSettings, named: Named]> = [
  ["without the gateway's address", (settings) => ({ ...settings, gatewayUrl: undefined }), { semiontconfig: [/gateway.{0,3}(publicURL|url)/i], document: missing('gatewayUrl') }],
  ['without the issuer', (settings) => ({ ...settings, issuer: undefined }), { semiontconfig: [/issuer/], document: missing('issuer') }],
  ["without the knowledge base's name", (settings) => ({ ...settings, kbName: undefined }), { semiontconfig: [/kb.{0,3}name/i], document: missing('kbName') }],
  ['without the state volume', (settings) => ({ ...settings, stateHome: undefined }), { semiontconfig: [/state.?(home|volume|tree|dir)/i], document: missing('stateHome') }],
  ["without the Archivist's address", (settings) => ({ ...settings, archivist: undefined }), { semiontconfig: [/archivist/i], document: missing('archivist') }],
  ['without a graph database', (settings) => ({ ...settings, graph: undefined }), { semiontconfig: [/graph/], document: missing('graph') }],
  ['without a vector database', (settings) => ({ ...settings, vectors: undefined }), { semiontconfig: [/vector/], document: missing('vectors') }],
  ['without an embedding provider', (settings) => ({ ...settings, embedding: undefined }), { semiontconfig: [/embedding/], document: missing('embedding') }],
  ["without the Matcher's model", (settings) => ({ ...settings, matcher: undefined }), { semiontconfig: [/matcher/], document: missing('matcher') }],
  ["without the Gatherer's model", (settings) => ({ ...settings, gatherer: undefined }), { semiontconfig: [/gatherer/], document: missing('gatherer') }],
  // A store in one process's memory could not be shared with the service that writes it.
  ["on a graph that lives in one process's memory", (settings) => ({ ...settings, graph: { type: 'memory' } }), { semiontconfig: [/memory/, /graph/], document: [/graph\.type is memory/] }],
  [
    "on a vector index that lives in one process's memory",
    (settings) => ({ ...settings, vectors: { type: 'memory' } }),
    { semiontconfig: [/memory/, /vector/], document: [/vectors\.type is memory/] },
  ],
  // A gather's two waits, for the graph and for the vectors, must both end before a worker that holds a job is called stalled.
  [
    'on a settle bound as long as the stall of a held job',
    (settings) => ({ ...settings, settleTimeoutMs: heldJobStallMs() }),
    { semiontconfig: [/settleTimeoutMs/], document: [/gather\.settleTimeoutMs must be less than/] },
  ],
  ['on a settle bound of no time at all', (settings) => ({ ...settings, settleTimeoutMs: 0 }), { semiontconfig: [/settleTimeoutMs/], document: [/gather\.settleTimeoutMs/] }],
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
      for (const name of named[world().configuredBy]) expect(output).toMatch(name);
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
