/**
 * What a Worker service is started with, and every way it refuses to start
 * (WORKER-SERVICE.md § Configuration): the one document it reads, the key it
 * signs in with, the provider keys the document names, and a document that
 * names one knowledge base twice; and how it ends when every knowledge base
 * it serves refuses it before any is confirmed (§ Knowledge bases).
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { errorsOf, spec } from '../harness/spec';
import { eachWorkerService, SECOND_WORKER_CLIENT, WORKER_CLIENT, type WorkerServiceWorld } from '../harness/worker-service-world';
import { startWorkerService, type WorkerSettings } from '../harness/worker-service-process';
import { health, KB_LOG, logged } from './support';

type Entry = Record<string, unknown> & { identity: Record<string, unknown>; engines: Array<Record<string, unknown>> };
type Document = Record<string, unknown> & { knowledgeBases: Entry[] };

/** The world's document, as a plain object a case may break. */
async function documentOf(world: WorkerServiceWorld): Promise<Document> {
  return JSON.parse(JSON.stringify((await world.launch()).settings)) as Document;
}

/** The first knowledge base of a document a case breaks. */
const first = (d: Document): Entry => d.knowledgeBases[0]!;

/** The `[fatal]` lines of what a refused worker wrote to stderr. */
const fatal = (stderr: string): string[] => stderr.split('\n').filter((line) => line.startsWith('[fatal]'));

/** What a worker every knowledge base of which refused it says as it ends, when none was confirmed first (R5). */
const NONE_ADMITS = '[fatal] No knowledge base admits this worker: each of its knowledgeBases refused it';

/**
 * What a worker that started would have dialled: a grant of either issuer, its
 * provider, a claim at either knowledge base. A refusal leaves each as it was.
 */
async function dialled(world: WorkerServiceWorld): Promise<{ grants: number[]; shows: number; claims: number[] }> {
  const second = await world.second();
  return {
    grants: [world.world.issuer.grants.get(WORKER_CLIENT) ?? 0, second.world.issuer.grants.get(SECOND_WORKER_CLIENT) ?? 0],
    shows: world.ollama.shows.length,
    claims: [world.claims.length, second.claims.length],
  };
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

eachWorkerService("the worker's boot", (world) => {
  it('is configured by a document the spec accepts', async () => {
    const validate = spec().component('WorkerConfig');
    expect(validate((await world().launch()).settings), errorsOf(validate)).toBe(true);
  });

  it('refuses to start without --config, saying so once on stderr, and exits 1', async () => {
    const before = await dialled(world());
    for (const args of [() => [], () => ['--config'], () => ['--config=']]) {
      const refusal = await world().refused({ args });
      expect(refusal.code).toBe(1);
      expect(fatal(refusal.stderr)).toEqual(["[fatal] The worker's configuration document is not named: start it with --config <path>"]);
    }
    expect(await dialled(world())).toEqual(before);
  });

  it('refuses a --config that names no file, naming the path', async () => {
    const before = await dialled(world());
    const absent = join(tmpdir(), `absent-${randomUUID()}.json`);
    const refusal = await world().refused({ args: () => ['--config', absent] });
    expect(refusal.code).toBe(1);
    const said = fatal(refusal.stderr);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(new RegExp(`^\\[fatal\\] Cannot read the worker's configuration document at ${escaped(absent)} \\(.+\\)\\. The launcher writes it; a worker started another way is given one \\(WorkerConfig in specs/\\)\\.$`));
    expect(await dialled(world())).toEqual(before);
  });

  it('refuses a document that is not JSON, naming the file', async () => {
    const before = await dialled(world());
    const refusal = await world().refused({ verbatim: 'gatewayUrl = "http://gateway"' });
    expect(refusal.code).toBe(1);
    const said = fatal(refusal.stderr);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^\[fatal\] \S+worker\.json is not JSON: .+/);
    expect(await dialled(world())).toEqual(before);
  });

  it.each([
    ['its knowledge bases', (d: Document) => delete (d as Record<string, unknown>)['knowledgeBases'], 'knowledgeBases'],
    ["a knowledge base's domain", (d: Document) => delete first(d)['domain'], 'domain'],
    ["a knowledge base's gateway", (d: Document) => delete first(d)['gatewayUrl'], 'gatewayUrl'],
    ['the account a knowledge base names', (d: Document) => delete (first(d) as Record<string, unknown>)['identity'], 'identity'],
    ["a knowledge base's issuer", (d: Document) => delete first(d).identity['issuer'], 'issuer'],
    ['the client a knowledge base names', (d: Document) => delete first(d).identity['clientId'], 'clientId'],
    ['the engines a knowledge base is offered', (d: Document) => delete (first(d) as Record<string, unknown>)['engines'], 'engines'],
    ['its model catalogue', (d: Document) => delete d['modelCatalogue'], 'modelCatalogue'],
    ['its port', (d: Document) => delete d['port'], 'port'],
    ['its log level', (d: Document) => delete d['logLevel'], 'logLevel'],
    ['its log format', (d: Document) => delete d['logFormat'], 'logFormat'],
    ["an engine's provider and model", (d: Document) => delete first(d).engines[0]!['engine'], 'engine'],
    ['the jobs an engine is used for', (d: Document) => delete first(d).engines[0]!['jobs'], 'jobs'],
    ["the address of an engine's provider", (d: Document) => delete first(d).engines[0]!['baseUrl'], 'baseUrl'],
  ])('refuses a document missing %s, naming the member', async (_what, breakIt, member) => {
    const before = await dialled(world());
    const document = await documentOf(world());
    breakIt(document);
    const refusal = await world().refused({ verbatim: document });
    expect(refusal.code).toBe(1);
    const lines = refusal.stderr.split('\n');
    const head = lines.findIndex((line) => line.startsWith('[fatal]'));
    expect(lines[head]).toMatch(/^\[fatal\] \S+worker\.json is not a worker configuration document \(WorkerConfig\):$/);
    // Each reason is on a line of its own under the head.
    expect(lines.slice(head + 1)).toContain(`  Missing required property: ${member}`);
    expect(await dialled(world())).toEqual(before);
  });

  it.each([
    ['no knowledge base at all', (d: Document) => (d.knowledgeBases = []), /knowledgeBases/],
    ['a knowledge base offered no engine', (d: Document) => (first(d).engines = []), /engines/],
    ['an engine used for no job', (d: Document) => (first(d).engines[0]!['jobs'] = []), /jobs/],
    ['a provider it does not know', (d: Document) => (first(d).engines[0]!['engine'] = { provider: 'mistral', model: 'm' }), /provider/],
    ['a port that is not one', (d: Document) => (d['port'] = 70_000), /port/],
    ['a member the schema does not have', (d: Document) => (d['dispatcherUrl'] = 'http://dispatcher'), /dispatcherUrl/],
    ["a provider's key as a value", (d: Document) => (first(d).engines[0]!['apiKey'] = 'hunter2-not-a-name'), /apiKey/],
    ["a secret beside a knowledge base's client", (d: Document) => (first(d).identity['clientSecret'] = 'hunter2-not-a-name'), /clientSecret/],
  ])('refuses a document with %s, naming the member and no value found in it', async (_what, breakIt, member) => {
    const before = await dialled(world());
    const document = await documentOf(world());
    breakIt(document);
    const refusal = await world().refused({ verbatim: document });
    expect(refusal.code).toBe(1);
    expect(refusal.stderr).toMatch(/^\[fatal\] \S+worker\.json is not a worker configuration document \(WorkerConfig\):$/m);
    expect(refusal.stderr).toMatch(member);
    expect(refusal.output).not.toContain('hunter2-not-a-name');
    expect(refusal.output).not.toContain('http://dispatcher');
    expect(await dialled(world())).toEqual(before);
  });

  it('refuses a document that names one knowledge base twice, naming the later entry and the earlier, and not the domain', async () => {
    const before = await dialled(world());
    const second = await world().second();
    const settings: WorkerSettings = (await world().launch()).settings;
    const [own] = settings.knowledgeBases;
    const other = second.configuration(second.world.origin, own!.engines);
    // The third is the first's domain at another gateway: the domain is what makes a knowledge base the same.
    const refusal = await world().refused({ settings: { ...settings, knowledgeBases: [own!, other, { ...other, domain: own!.domain }] } });
    expect(refusal.code).toBe(1);
    expect(fatal(refusal.stderr)).toEqual(['[fatal] knowledgeBases[2].domain is the domain of knowledgeBases[0]: a worker serves a knowledge base once']);
    expect(refusal.output).not.toContain(own!.domain);
    expect(await dialled(world())).toEqual(before);
  });

  it("refuses to start when a variable a knowledge base's engine names for a provider's key is not set, or is empty, naming the member", async () => {
    const before = await dialled(world());
    const second = await world().second();
    const settings: WorkerSettings = (await world().launch()).settings;
    const [own] = settings.knowledgeBases;
    // The engine is the second knowledge base's, so the line says which knowledge base named the variable.
    const named: WorkerSettings = { ...settings, knowledgeBases: [own!, second.configuration(second.world.origin, [{ ...own!.engines[0]!, apiKeyEnv: 'WORKER_SERVICE_PROVIDER_KEY' }])] };
    for (const env of [world().env, { ...world().env, WORKER_SERVICE_PROVIDER_KEY: '' }]) {
      const refusal = await world().refused({ settings: named, env });
      expect(refusal.code).toBe(1);
      expect(fatal(refusal.stderr)).toEqual(["[fatal] knowledgeBases[1].engines[0].apiKeyEnv names a variable that is not set in the worker's environment"]);
    }
    expect(await dialled(world())).toEqual(before);
  });

  it("refuses a document that has a key's value where the name of its variable belongs, and does not repeat it", async () => {
    const before = await dialled(world());
    const settings: WorkerSettings = (await world().launch()).settings;
    const [own] = settings.knowledgeBases;
    const refusal = await world().refused({ settings: { ...settings, knowledgeBases: [{ ...own!, engines: [{ ...own!.engines[0]!, apiKeyEnv: 'sk-conformance-0123456789abcdef' }] }] } });
    expect(refusal.code).toBe(1);
    expect(fatal(refusal.stderr)).toEqual(["[fatal] knowledgeBases[0].engines[0].apiKeyEnv names a variable that is not set in the worker's environment"]);
    expect(refusal.output).not.toContain('sk-conformance-0123456789abcdef');
    expect(await dialled(world())).toEqual(before);
  });

  it('refuses to start without SEMIONT_OIDC_CLIENT_KEY, or with it empty', async () => {
    const before = await dialled(world());
    for (const value of [undefined, '']) {
      const refusal = await world().refused({ env: { ...world().env, SEMIONT_OIDC_CLIENT_KEY: value } });
      expect(refusal.code).toBe(1);
      expect(fatal(refusal.stderr)).toEqual(["[fatal] SEMIONT_OIDC_CLIENT_KEY is not set in the worker's environment: a worker signs in as a service account"]);
      expect(refusal.output).not.toContain(world().env.SEMIONT_OIDC_CLIENT_KEY!);
    }
    expect(await dialled(world())).toEqual(before);
  });

  it('refuses to start with a key it cannot read, or one that is not RSA, and does not repeat it', async () => {
    const before = await dialled(world());
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    for (const [held, said] of [
      ['not a key at all', 'is not an unencrypted PEM private key'],
      [ec, 'is not an RSA key: a worker signs its assertions with RS256'],
    ] as const) {
      const refusal = await world().refused({ env: { ...world().env, SEMIONT_OIDC_CLIENT_KEY: held } });
      expect(refusal.code).toBe(1);
      expect(fatal(refusal.stderr)).toEqual([`[fatal] SEMIONT_OIDC_CLIENT_KEY in the worker's environment ${said}`]);
      expect(refusal.output).not.toContain(held);
    }
    expect(await dialled(world())).toEqual(before);
  });

  it('exits 1, having served nothing, when the issuer of its one knowledge base refuses its sign-in: saying so in its log, and then once on stderr that no knowledge base admits it', async () => {
    // A key the issuer holds no public half of: its assertion is refused.
    const unregistered = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const refusal = await world().refused({ env: { ...world().env, SEMIONT_OIDC_CLIENT_KEY: unregistered } });
    expect(refusal.code).toBe(1);
    expect(fatal(refusal.stderr)).toEqual([NONE_ADMITS]);
    const refused = logged(refusal.stdout, KB_LOG.refused);
    expect(refused).toEqual([expect.objectContaining({ level: 'error', domain: world().domain, reason: expect.any(String) })]);
    // The refusal is in its log before it ends.
    const lines = refusal.output.split('\n');
    expect(lines.findIndex((line) => logged([line], KB_LOG.refused).length > 0)).toBeLessThan(lines.indexOf(NONE_ADMITS));
    expect(refusal.output).not.toContain(unregistered);
    expect(world().claims).toEqual([]);
  });

  it('exits 1, having served nothing, when each of its knowledge bases refuses it before any is confirmed: one whose issuer refuses its sign-in, one that answers another domain', async () => {
    const w = world();
    const second = await w.second();
    // The second answers as the first: a gateway that is another knowledge base's.
    second.hooks.confirm = () => ({ domain: w.domain });
    const settings: WorkerSettings = (await w.launch()).settings;
    const [own] = settings.knowledgeBases;
    // The first names a client its issuer does not hold.
    const knowledgeBases = [w.configuration(w.world.origin, own!.engines, 'semiont-worker-unregistered'), second.configuration(second.world.origin, own!.engines)];
    const refusal = await w.refused({ settings: { ...settings, knowledgeBases } });
    expect(refusal.code).toBe(1);
    expect(fatal(refusal.stderr)).toEqual([NONE_ADMITS]);
    const refused = logged(refusal.stdout, KB_LOG.refused);
    expect([...refused].sort((a, b) => (String(a['domain']) < String(b['domain']) ? -1 : 1))).toEqual(
      [w.domain, second.domain].sort().map((domain) => expect.objectContaining({ level: 'error', domain, reason: expect.any(String) })),
    );
    expect(refusal.output).not.toContain(w.env.SEMIONT_OIDC_CLIENT_KEY!);
    expect([w.claims, second.claims]).toEqual([[], []]);
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
      expect(refusal.output).not.toContain(world().env.SEMIONT_OIDC_CLIENT_KEY!);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it('takes the path of its document joined to the flag by an equals sign', async () => {
    const launch = await world().launch({ args: (document) => [`--config=${document}`] });
    const process = await startWorkerService(launch);
    try {
      expect((await health(process)).knowledgeBases.map(({ state }) => state)).toEqual(['working']);
    } finally {
      expect(await process.stop()).toBe(0);
    }
  });
});
