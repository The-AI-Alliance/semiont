/**
 * What a Worker service is started with, and every way it refuses to start
 * (WORKER-SERVICE.md § Configuration): the one document it reads, the two
 * variables of its service account, and the provider keys the document names.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { errorsOf, spec } from '../harness/spec';
import { eachWorkerService, WORKER_CLIENT, type WorkerServiceWorld } from '../harness/worker-service-world';
import { startWorkerService, type WorkerSettings } from '../harness/worker-service-process';

type Document = Record<string, unknown> & { identity: Record<string, unknown>; agents: Array<Record<string, unknown>> };

/** The world's document, as a plain object a case may break. */
async function documentOf(world: WorkerServiceWorld): Promise<Document> {
  return JSON.parse(JSON.stringify((await world.launch()).settings)) as Document;
}

/** The `[fatal]` lines of what a refused worker wrote to stderr. */
const fatal = (stderr: string): string[] => stderr.split('\n').filter((line) => line.startsWith('[fatal]'));

/** What a worker that started would have dialled: a grant of the issuer, its provider, a claim. A refusal leaves each as it was. */
function dialled(world: WorkerServiceWorld): { grants: number; shows: number; claims: number } {
  return { grants: world.world.issuer.grants.get(WORKER_CLIENT) ?? 0, shows: world.ollama.shows.length, claims: world.claims.length };
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

eachWorkerService("the worker's boot", (world) => {
  it('is configured by a document the spec accepts', async () => {
    const validate = spec().component('WorkerConfig');
    expect(validate((await world().launch()).settings), errorsOf(validate)).toBe(true);
  });

  it('refuses to start without --config, saying so once on stderr, and exits 1', async () => {
    const before = dialled(world());
    for (const args of [() => [], () => ['--config'], () => ['--config=']]) {
      const refusal = await world().refused({ args });
      expect(refusal.code).toBe(1);
      expect(fatal(refusal.stderr)).toEqual(["[fatal] The worker's configuration document is not named: start it with --config <path>"]);
    }
    expect(dialled(world())).toEqual(before);
  });

  it('refuses a --config that names no file, naming the path', async () => {
    const before = dialled(world());
    const absent = join(tmpdir(), `absent-${randomUUID()}.json`);
    const refusal = await world().refused({ args: () => ['--config', absent] });
    expect(refusal.code).toBe(1);
    const said = fatal(refusal.stderr);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(new RegExp(`^\\[fatal\\] Cannot read the worker's configuration document at ${escaped(absent)} \\(.+\\)\\. The launcher writes it; a worker started another way is given one \\(WorkerConfig in specs/\\)\\.$`));
    expect(dialled(world())).toEqual(before);
  });

  it('refuses a document that is not JSON, naming the file', async () => {
    const before = dialled(world());
    const refusal = await world().refused({ verbatim: 'gatewayUrl = "http://gateway"' });
    expect(refusal.code).toBe(1);
    const said = fatal(refusal.stderr);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^\[fatal\] \S+worker\.json is not JSON: .+/);
    expect(dialled(world())).toEqual(before);
  });

  it.each([
    ['the gateway', (d: Document) => delete d['gatewayUrl'], 'gatewayUrl'],
    ['the issuer', (d: Document) => delete d.identity['issuer'], 'issuer'],
    ['its identity', (d: Document) => delete (d as Record<string, unknown>)['identity'], 'identity'],
    ['its agents', (d: Document) => delete (d as Record<string, unknown>)['agents'], 'agents'],
    ['its port', (d: Document) => delete d['port'], 'port'],
    ['its log level', (d: Document) => delete d['logLevel'], 'logLevel'],
    ['its log format', (d: Document) => delete d['logFormat'], 'logFormat'],
    ["an agent's provider and model", (d: Document) => delete d.agents[0]!['agent'], 'agent'],
    ["the jobs an agent serves", (d: Document) => delete d.agents[0]!['accepts'], 'accepts'],
    ["the address of an agent's provider", (d: Document) => delete d.agents[0]!['baseUrl'], 'baseUrl'],
  ])('refuses a document missing %s, naming the member', async (_what, breakIt, member) => {
    const before = dialled(world());
    const document = await documentOf(world());
    breakIt(document);
    const refusal = await world().refused({ verbatim: document });
    expect(refusal.code).toBe(1);
    const lines = refusal.stderr.split('\n');
    const head = lines.findIndex((line) => line.startsWith('[fatal]'));
    expect(lines[head]).toMatch(/^\[fatal\] \S+worker\.json is not a worker configuration document \(WorkerConfig\):$/);
    // Each reason is on a line of its own under the head.
    expect(lines.slice(head + 1)).toContain(`  Missing required property: ${member}`);
    expect(dialled(world())).toEqual(before);
  });

  it.each([
    ['no agent at all', (d: Document) => (d.agents = []), /agents/],
    ['an agent that serves no job', (d: Document) => (d.agents[0]!['accepts'] = []), /accepts/],
    ['a provider it does not know', (d: Document) => (d.agents[0]!['agent'] = { provider: 'openai', model: 'm' }), /provider/],
    ['a port that is not one', (d: Document) => (d['port'] = 70_000), /port/],
    ['a member the schema does not have', (d: Document) => (d['dispatcherUrl'] = 'http://dispatcher'), /dispatcherUrl/],
    ["a provider's key as a value", (d: Document) => (d.agents[0]!['apiKey'] = 'hunter2-not-a-name'), /apiKey/],
  ])('refuses a document with %s, naming the member and no value found in it', async (_what, breakIt, member) => {
    const before = dialled(world());
    const document = await documentOf(world());
    breakIt(document);
    const refusal = await world().refused({ verbatim: document });
    expect(refusal.code).toBe(1);
    expect(refusal.stderr).toMatch(/^\[fatal\] \S+worker\.json is not a worker configuration document \(WorkerConfig\):$/m);
    expect(refusal.stderr).toMatch(member);
    expect(refusal.output).not.toContain('hunter2-not-a-name');
    expect(refusal.output).not.toContain('http://dispatcher');
    expect(dialled(world())).toEqual(before);
  });

  it("refuses to start when a variable the document names for a provider's key is not set, or is empty", async () => {
    const before = dialled(world());
    const settings: WorkerSettings = (await world().launch()).settings;
    const named: WorkerSettings = { ...settings, agents: [{ ...settings.agents[0]!, apiKeyEnv: 'WORKER_SERVICE_PROVIDER_KEY' }] };
    for (const env of [world().env, { ...world().env, WORKER_SERVICE_PROVIDER_KEY: '' }]) {
      const refusal = await world().refused({ settings: named, env });
      expect(refusal.code).toBe(1);
      expect(fatal(refusal.stderr)).toEqual(["[fatal] agents[0].apiKeyEnv names a variable that is not set in the worker's environment"]);
    }
    expect(dialled(world())).toEqual(before);
  });

  it("refuses a document that has a key's value where the name of its variable belongs, and does not repeat it", async () => {
    const before = dialled(world());
    const settings: WorkerSettings = (await world().launch()).settings;
    const refusal = await world().refused({ settings: { ...settings, agents: [{ ...settings.agents[0]!, apiKeyEnv: 'sk-conformance-0123456789abcdef' }] } });
    expect(refusal.code).toBe(1);
    expect(fatal(refusal.stderr)).toEqual(["[fatal] agents[0].apiKeyEnv names a variable that is not set in the worker's environment"]);
    expect(refusal.output).not.toContain('sk-conformance-0123456789abcdef');
    expect(dialled(world())).toEqual(before);
  });

  it.each(['SEMIONT_OIDC_CLIENT_ID', 'SEMIONT_OIDC_CLIENT_SECRET'])('refuses to start without %s, or with it empty', async (variable) => {
    const before = dialled(world());
    for (const value of [undefined, '']) {
      const refusal = await world().refused({ env: { ...world().env, [variable]: value } });
      expect(refusal.code).toBe(1);
      expect(fatal(refusal.stderr)).toEqual([`[fatal] ${variable} is not set in the worker's environment: a worker signs in as a service account`]);
      expect(refusal.output).not.toContain(world().env.SEMIONT_OIDC_CLIENT_SECRET!);
    }
    expect(dialled(world())).toEqual(before);
  });

  it('exits 1, having served nothing, when the issuer refuses its service account, saying why once on stderr', async () => {
    const refusal = await world().refused({ env: { ...world().env, SEMIONT_OIDC_CLIENT_SECRET: 'not-the-secret' } });
    expect(refusal.code).toBe(1);
    const said = fatal(refusal.stderr);
    expect(said).toHaveLength(1);
    expect(said[0]!.length).toBeGreaterThan('[fatal] '.length);
    expect(refusal.output).not.toContain('not-the-secret');
    expect(world().claims).toEqual([]);
  });

  it('exits 1 when it cannot listen on its port, saying why once on stderr', async () => {
    // The port is taken: something else listens on it, and answers nobody.
    const holder = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => holder.listen(0, resolve));
    try {
      const settings: WorkerSettings = { ...(await world().launch()).settings, port: (holder.address() as AddressInfo).port };
      const refusal = await world().refused({ settings });
      expect(refusal.code).toBe(1);
      const said = fatal(refusal.stderr);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(String(settings.port));
      expect(refusal.output).not.toContain(world().env.SEMIONT_OIDC_CLIENT_SECRET!);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it('takes the path of its document joined to the flag by an equals sign', async () => {
    const launch = await world().launch({ args: (document) => [`--config=${document}`] });
    const process = await startWorkerService(launch);
    try {
      expect((await process.http('GET', '/health')).status).toBe(200);
    } finally {
      expect(await process.stop()).toBe(0);
    }
  });
});
