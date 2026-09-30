/**
 * Boot, health and shutdown (JOBS.md § Configuration, § Health): the one
 * document the dispatcher reads, every way it refuses to start, what its health
 * answers, and a clean stop.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { refusedDispatcherBoot, startDispatcher, type DispatcherLaunch, type DispatcherSettings } from '../harness/dispatcher';
import { withDispatcher, type DispatcherWorld } from '../harness/dispatcher-world';
import { freePort } from '../harness/net';
import { spec, errorsOf } from '../harness/spec';

/** A launch like the world's, on a port of its own, changed as a case needs. */
async function launch(world: DispatcherWorld, change: Partial<DispatcherLaunch> = {}): Promise<DispatcherLaunch> {
  const settings: DispatcherSettings = { ...world.settings, port: await freePort() };
  return { settings, env: world.env, ...change };
}

/** The world's settings, as a plain document a case may break. */
const documentOf = (settings: DispatcherSettings) => JSON.parse(JSON.stringify(settings)) as Record<string, Record<string, unknown>>;

withDispatcher('the dispatcher\'s boot', (world) => {
  it('answers exactly /health, with the queue it holds', async () => {
    const health = await world().dispatcher.health();
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toMatch(/^application\/json/);
    const validate = spec().component('DispatcherHealth');
    expect(validate(health.json), errorsOf(validate)).toBe(true);
    expect(health.json).toEqual({ status: 'ok', queue: 'jetstream' });

    const elsewhere = await world().dispatcher.health('/api/health');
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.text).toBe('');
  });

  it.each([
    ['started without --config', { args: () => [] }, /\[fatal\] The dispatcher's configuration document is not named: start it with --config <path>/],
    ['with --config naming no file', { args: () => ['--config', join(tmpdir(), `absent-${randomUUID()}.json`)] }, /\[fatal\] Cannot read the dispatcher's configuration document at \S*absent-/],
    ['with a document that is not JSON', { verbatim: 'gatewayUrl = "http://gateway"' }, /\[fatal\] The dispatcher's configuration document at \S+ is not JSON/],
  ])('refuses to start %s, saying why', async (_how, change, reason) => {
    const refusal = await refusedDispatcherBoot(await launch(world(), change));
    expect(refusal.code).toBe(1);
    expect(refusal.output).toMatch(reason);
  });

  it.each([
    ['missing a clock', (d: Record<string, Record<string, unknown>>) => delete d['timing']!['tickMs'], /tickMs/],
    ['missing the broker', (d: Record<string, Record<string, unknown>>) => delete d['queue']!['servers'], /servers/],
    ['missing the issuer', (d: Record<string, Record<string, unknown>>) => delete d['identity'], /identity/],
    ['missing the gateway', (d: Record<string, Record<string, unknown>>) => delete d['gatewayUrl'], /gatewayUrl/],
    ['carrying a secret\'s value where its name belongs', (d: Record<string, Record<string, unknown>>) => (d['queue']!['password'] = 'hunter2'), /password/],
  ])('refuses a document %s, naming the field', async (_what, breakIt, field) => {
    const settings = world().settings;
    const document = documentOf(settings);
    breakIt(document);
    const refusal = await refusedDispatcherBoot(await launch(world(), { verbatim: document }));
    expect(refusal.code).toBe(1);
    expect(refusal.output).toMatch(/\[fatal\] The dispatcher's configuration document at \S+ is not valid: /);
    expect(refusal.output).toMatch(field);
    expect(refusal.output).not.toMatch(/hunter2/);
  });

  it('refuses a document naming a broker credential that is not set, naming the variable', async () => {
    const base = await launch(world());
    const settings = { ...base.settings, queue: { ...base.settings.queue, passwordEnv: 'UNSET_QUEUE_PASSWORD' } };
    const refusal = await refusedDispatcherBoot({ ...base, settings });
    expect(refusal.code).toBe(1);
    expect(refusal.output).toMatch(/UNSET_QUEUE_PASSWORD/);
    expect(refusal.output).toMatch(/queue\.passwordEnv/);
  });

  it('refuses to start without its service account', async () => {
    const { SEMIONT_OIDC_CLIENT_SECRET: _secret, ...env } = world().env;
    const refusal = await refusedDispatcherBoot(await launch(world(), { env }));
    expect(refusal.code).not.toBe(0);
    expect(refusal.output).toMatch(/SEMIONT_OIDC_CLIENT_SECRET/);
  });

  it('exits within its boot deadline when the broker cannot be reached, so its supervisor can retry', async () => {
    const base = await launch(world());
    const deadline = 2_000;
    const settings = { ...base.settings, queue: { servers: `nats://127.0.0.1:${await freePort()}` }, timing: { ...base.settings.timing, bootDeadlineMs: deadline } };
    const refusal = await refusedDispatcherBoot({ ...base, settings });
    expect(refusal.code).toBe(1);
    expect(refusal.afterMs).toBeLessThan(deadline + 15_000);
  });

  it('stops on SIGTERM with status 0, and answers nothing after', async () => {
    const extra = await startDispatcher(await launch(world()));
    expect(await extra.stop()).toBe(0);
    await expect(extra.health()).rejects.toThrow();
  });
});
