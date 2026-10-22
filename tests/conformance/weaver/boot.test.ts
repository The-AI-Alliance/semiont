/**
 * How a Weaver starts, answers for itself and stops (WEAVER.md § Boot, §
 * Health, § Stopping): what its health reports, what it refuses to start
 * without, and that a reconcile it cannot finish does not end it.
 */
import { expect, it } from 'vitest';
import { eachWeaver } from '../harness/weaver-world';
import { uploaded } from './support';

eachWeaver('a Weaver, as a process', (world) => {
  it('reports at its health port how it follows the record and how its reconcile ended', async () => {
    const id = await uploaded(world(), 'Counted');
    await world().caughtUp(id);
    await world().restart();

    const health = await world().weaver.health();

    expect(health.status).toBe('ok');
    expect(health.following).toEqual({ sweep: 'done', stopped: 0, refused: 0, streamDrops: 0 });
    expect(health.reconcile.phase).toBe('done');
    expect(Object.keys(health.reconcile.summary!).sort()).toEqual(['divergent', 'healFailures', 'healed', 'orphaned', 'resourcesChecked']);
    expect(health.reconcile.summary!['resourcesChecked']).toBeGreaterThanOrEqual(1);
  });

  it('stops when it is told to, and says nothing is wrong by its exit', async () => {
    expect(await world().stop()).toBe(0);
    await world().start();
  });

  it('refuses to start without its service account, and names what is missing', async () => {
    await world().stop();
    try {
      const { code, output } = await world().refused({ env: { ...world().launch().env, SEMIONT_OIDC_CLIENT_SECRET: undefined } });
      expect(code).not.toBe(0);
      expect(output).toContain('SEMIONT_OIDC_CLIENT_SECRET');
    } finally {
      await world().start();
    }
  });

  it('refuses to start without the graph database\'s password, and names the variable its settings name', async () => {
    await world().stop();
    try {
      const { code, output } = await world().refused({ env: { ...world().launch().env, NEO4J_PASSWORD: undefined } });
      expect(code).not.toBe(0);
      expect(output).toContain('NEO4J_PASSWORD');
    } finally {
      await world().start();
    }
  });

  it('refuses a graph that lives in one process\'s memory: it could not be shared with a reader', async () => {
    await world().stop();
    try {
      const { code, output } = await world().refused({ settings: { ...world().settings, graph: { ...world().settings.graph, type: 'memory' } } });
      expect(code).not.toBe(0);
      expect(output).toMatch(/memory/);
    } finally {
      await world().start();
    }
  });

  it('gives up, and exits saying why, when the gateway it is told of does not answer', async () => {
    await world().stop();
    try {
      // A port nothing listens on. A Weaver tries again a bounded number of times, then ends.
      const { code, output } = await world().refused({ settings: { ...world().settings, gatewayUrl: 'http://127.0.0.1:9' } });
      expect(code).not.toBe(0);
      expect(output).toMatch(/127\.0\.0\.1:9/);
    } finally {
      await world().start();
    }
  }, 120_000);
});
