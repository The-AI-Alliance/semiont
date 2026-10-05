/**
 * Boot, health and shutdown (ARCHIVIST.md § Configuration, § Boot and
 * shutdown): the one document the Archivist reads, every way it refuses to
 * start, what its health answers, and a clean stop.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { refusedArchivistBoot, startArchivistProcess, type ArchivistLaunch, type ArchivistSettings } from '../harness/archivist-process';
import { withArchivist, type ArchivistWorld } from '../harness/archivist-world';
import { freePort } from '../harness/net';
import { archivistSpec, errorsOf, spec } from '../harness/spec';

/** A launch like the world's, on a port of its own, changed as a case needs. */
async function launch(world: ArchivistWorld, change: Partial<ArchivistLaunch> = {}): Promise<ArchivistLaunch> {
  const settings: ArchivistSettings = { ...world.settings, port: await freePort() };
  return { settings, env: world.env, ...change };
}

/** The world's settings, as a plain document a case may break. */
const documentOf = (settings: ArchivistSettings) => JSON.parse(JSON.stringify(settings)) as Record<string, Record<string, unknown>>;

/** A knowledge base of its own beside the world's, for a boot that must be refused. */
function tree(config: string, git: boolean): { root: string; remove: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'conformance-kb-refused-'));
  const root = join(base, 'kb');
  mkdirSync(join(root, '.semiont'), { recursive: true });
  writeFileSync(join(root, '.semiont', 'config'), config);
  if (git) execFileSync('git', ['init', '--quiet'], { cwd: root });
  return { root, remove: () => rmSync(base, { recursive: true, force: true }) };
}

withArchivist("the Archivist's boot", (world) => {
  it('answers /health without a token, naming the actors it hosts', async () => {
    const health = await world().http('GET', '/health', { anonymous: true, route: '/health' });
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toMatch(/^application\/json/);
    expect(health.json).toEqual({ status: 'ok', actors: ['stower', 'browser', 'cloneTokenManager'] });
  });

  it('answers 404, with no body, anywhere its API names no route', async () => {
    for (const path of ['/api/health', '/', '/resources/abc']) {
      const reply = await world().http('GET', path);
      expect(reply.status, path).toBe(404);
      expect(reply.text, path).toBe('');
    }
  });

  it('is configured by a document the spec accepts', () => {
    const validate = spec().component('ArchivistConfig');
    expect(validate(world().settings), errorsOf(validate)).toBe(true);
    expect(archivistSpec().operation('get', '/health')).toBeDefined();
  });

  it.each([
    ['started without --config', { args: () => [] }, /\[fatal\] The archivist's configuration document is not named: start it with --config <path>/i],
    ['with --config naming no file', { args: () => ['--config', join(tmpdir(), `absent-${randomUUID()}.json`)] }, /\[fatal\] Cannot read the archivist's configuration document at \S*absent-/i],
    ['with a document that is not JSON', { verbatim: 'gatewayUrl = "http://gateway"' }, /\[fatal\] .* is not JSON/],
  ])('refuses to start %s, saying why', async (_how, change, reason) => {
    const refusal = await refusedArchivistBoot(await launch(world(), change));
    expect(refusal.code).toBe(1);
    expect(refusal.output).toMatch(reason);
  });

  it.each([
    ['missing the gateway', (d: Record<string, Record<string, unknown>>) => delete d['gatewayUrl'], /gatewayUrl/],
    ['missing the issuer', (d: Record<string, Record<string, unknown>>) => delete d['identity'], /identity/],
    ['missing the working tree', (d: Record<string, Record<string, unknown>>) => delete d['root'], /root/],
    ['missing the state volume', (d: Record<string, Record<string, unknown>>) => delete d['stateHome'], /stateHome/],
    ['missing the anchored-text store', (d: Record<string, Record<string, unknown>>) => delete d['anchoredTextDir'], /anchoredTextDir/],
    ['missing a staging bound', (d: Record<string, Record<string, unknown>>) => delete d['staging']!['maxWaitMs'], /maxWaitMs/],
    ['not saying whether to rebuild', (d: Record<string, Record<string, unknown>>) => delete d['skipRebuild'], /skipRebuild/],
    ['with a role served by a provider it does not know', (d: Record<string, Record<string, unknown>>) => (d['roster']!['actors'] = { matcher: { provider: 'openai', model: 'm' } }), /provider|matcher/],
    ['with a role carrying a credential', (d: Record<string, Record<string, unknown>>) => (d['roster']!['actors'] = { matcher: { provider: 'ollama', model: 'm', apiKey: 'hunter2' } }), /apiKey/],
    ['with a field the schema does not have', (d: Record<string, unknown>) => (d['stateDir'] = '/state'), /stateDir/],
  ])('refuses a document %s, naming the field', async (_what, breakIt, field) => {
    const document = documentOf(world().settings);
    breakIt(document as never);
    const refusal = await refusedArchivistBoot(await launch(world(), { verbatim: document }));
    expect(refusal.code).toBe(1);
    expect(refusal.output).toMatch(/\[fatal\]/);
    expect(refusal.output).toMatch(field);
    expect(refusal.output).not.toContain('hunter2');
  });

  it('refuses to start without its service account', async () => {
    const options = await launch(world());
    const refusal = await refusedArchivistBoot({ ...options, env: { ...options.env, SEMIONT_OIDC_CLIENT_SECRET: undefined } });
    expect(refusal.code).not.toBe(0);
    expect(refusal.output).toMatch(/SEMIONT_OIDC_CLIENT_SECRET/);
  });

  it('refuses a knowledge base that declares no [site] domain', async () => {
    const kb = tree('[project]\nname = "No Identity"\n', false);
    try {
      const options = await launch(world());
      const refusal = await refusedArchivistBoot({ ...options, settings: { ...options.settings, root: kb.root } });
      expect(refusal.code).not.toBe(0);
      expect(refusal.output).toMatch(/\[site\] domain/);
    } finally {
      kb.remove();
    }
  });

  it('refuses a knowledge base that syncs git and is not a checkout', async () => {
    const kb = tree(`[git]\nsync = true\n\n[site]\ndomain = ${JSON.stringify(world().world.kb.domain)}\n`, false);
    try {
      const options = await launch(world());
      const refusal = await refusedArchivistBoot({ ...options, settings: { ...options.settings, root: kb.root } });
      expect(refusal.code).not.toBe(0);
      expect(refusal.output).toMatch(/\[git\] sync = true/);
      expect(refusal.output).toMatch(/is not a git checkout/);
    } finally {
      kb.remove();
    }
  });

  it('stops on SIGTERM with status 0, and serves no more', async () => {
    const options = await launch(world());
    const kb = tree(`[site]\ndomain = ${JSON.stringify(world().world.kb.domain)}\n`, false);
    try {
      const second = await startArchivistProcess({ ...options, settings: { ...options.settings, root: kb.root } });
      expect(await second.stop()).toBe(0);
      await expect(second.http('GET', '/health')).rejects.toThrow();
    } finally {
      kb.remove();
    }
  });
});
