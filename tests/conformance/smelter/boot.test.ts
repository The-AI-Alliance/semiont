/**
 * How a Smelter starts, answers for itself and stops (SMELTER.md § Settings,
 * § Boot, § Health, § Stopping): what its health reports, what it refuses to
 * start without, that what is recorded while its reconcile runs is applied
 * then, and that it stops cleanly. With it, the names of what a reconcile
 * reports (§ Reconcile), and what a Smelter does when its provider has not
 * fetched its model yet (§ The embedding provider).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../harness/net';
import { NOT_FETCHED } from '../harness/ollama-embed';
import type { SmelterSettings } from '../harness/smelter-process';
import { eachSmelter } from '../harness/smelter-world';

/**
 * Each setting SMELTER.md § Settings says a Smelter refuses to start without:
 * the settings without it, and the member of the configuration document its
 * refusal names.
 */
const REQUIRED: ReadonlyArray<[what: string, without: (settings: SmelterSettings) => SmelterSettings, named: RegExp]> = [
  ["the gateway's URL", (settings) => ({ ...settings, gatewayUrl: undefined }), /gatewayUrl/],
  ['the issuer', (settings) => ({ ...settings, issuer: undefined }), /issuer/],
  ["the Archivist's address", (settings) => ({ ...settings, archivist: undefined }), /archivist/],
  ["the vector database's host", (settings) => ({ ...settings, vectors: { ...settings.vectors, host: undefined } }), /Missing required property: host/],
  ["the embedding provider's kind", (settings) => ({ ...settings, embedding: { ...settings.embedding, type: undefined } }), /embedding/],
  ["the embedding provider's model", (settings) => ({ ...settings, embedding: { ...settings.embedding, model: undefined } }), /Missing required property: model/],
  ["the embedding provider's address", (settings) => ({ ...settings, embedding: { ...settings.embedding, baseUrl: undefined } }), /Missing required property: baseUrl/],
  ['the directory of the anchored-text store', (settings) => ({ ...settings, anchoredTextDir: undefined }), /anchoredTextDir/],
];

eachSmelter('a Smelter, as a process', (world) => {
  it('answers at its health port for itself, for the events it has applied, and for how its reconcile ended', async () => {
    const health = await world().smelter.health();

    expect(Object.keys(health).sort()).toEqual(['eventsProcessed', 'reconcile', 'status']);
    expect(health.status).toBe('ok');
    expect(health.eventsProcessed).toBe(0);
    // The knowledge base holds nothing yet, and the index held nothing: its reconcile had nothing to do, and reports the eleven counts of that.
    expect(health.reconcile).toEqual({
      phase: 'done',
      summary: {
        resourcesEmbedded: 0,
        resourcesSkipped: {},
        resourcesUnavailable: 0,
        resourcesFailed: 0,
        resourcesRestamped: 0,
        resourcesReanchored: 0,
        resourceVectorsDeleted: 0,
        annotationsEmbedded: 0,
        annotationVectorsDeleted: 0,
        resourcesEligible: 0,
        resourcesIndexed: 0,
      },
    });
  });

  it('stops when it is told to, and says nothing is wrong by its exit', async () => {
    expect(await world().stop()).toBe(0);
    await world().start();
  });

  describe('started without something it needs', () => {
    // Each of these is a Smelter of its own, and a Smelter's health port is a constant: the world's is stopped while they run.
    beforeAll(async () => {
      await world().stop();
    });
    afterAll(async () => {
      await world().start();
    });

    it.each(['SEMIONT_OIDC_CLIENT_ID', 'SEMIONT_OIDC_CLIENT_SECRET'])('refuses to start without %s, half of its service account, and names it', async (variable) => {
      const { code, output } = await world().refused({ env: { ...world().launch().env, [variable]: undefined } });
      expect(code).not.toBe(0);
      expect(output).toContain(variable);
    });

    it.each(REQUIRED)('refuses to start without %s, and says which is missing', async (_what, without, named) => {
      const { code, output } = await world().refused({ settings: without(world().settings) });
      expect(code).not.toBe(0);
      expect(output).toMatch(named);
    });
  });

  it('asks its embedding provider again when it answers 404 as the Smelter starts: the model is taken to be on its way', async () => {
    // A Smelter asks its provider how wide the model's vectors are when it makes its collections, so it is started on an index that has none.
    await world().stop();
    await world().clearIndex();
    const before = world().provider.mark();
    world().provider.script(NOT_FETCHED);

    await world().start();

    const [first, second] = world().provider.since(before);
    expect(first?.status).toBe(404);
    expect(second?.status).toBe(200);
    expect(second?.body).toEqual(first?.body);
    expect((await world().smelter.health()).status).toBe('ok');
  });

  it('counts the events it has applied since it started, and not the work of its reconcile', async () => {
    const id = await world().created('A Smelter counts each event it applies.\n', 'text/plain');
    await world().settled(id);
    expect((await world().applied(1)).eventsProcessed).toBe(1);

    // Started again on an index that was cleared, its reconcile indexes the resource: that is work, and no event.
    await world().stop();
    await world().clearIndex();
    await world().start();

    const health = await world().smelter.health();
    expect(health.reconcile).toMatchObject({ phase: 'done', summary: { resourcesEmbedded: 1 } });
    expect(health.eventsProcessed).toBe(0);
  });

  it('answers at its health port while its reconcile is still at work, and applies what is recorded meanwhile', async () => {
    const waitedFor = 'What its reconcile is kept waiting for.';
    const indexed = await world().created('Indexed before it stopped, and archived while its reconcile ran.\n', 'text/plain');
    const missing = await world().created(`${waitedFor}\n`, 'text/plain');
    await world().settled(indexed);
    await world().settled(missing);

    // It is started with one resource's points gone from the index, and its provider holds the request that would bring them back.
    await world().stop();
    await world().index.deletePointsOf('resources', missing);
    world().provider.choose = (request) => (request.texts.some((text) => text.includes(waitedFor)) ? { hold: true } : undefined);
    await world().start({}, 'serving');
    await eventually('its reconcile to ask for the vectors it is kept waiting for', 30_000, () => (world().provider.held === 1 ? true : undefined));
    expect((await world().smelter.health()).reconcile.phase).toBe('running');

    // An event recorded now is applied now, and not when the reconcile has ended.
    await world().archived(indexed);
    expect((await world().applied(1)).reconcile.phase).toBe('running');

    world().provider.release();
    expect((await world().reconciled()).reconcile).toMatchObject({ phase: 'done', summary: { resourcesEmbedded: 1 } });
  });
});
