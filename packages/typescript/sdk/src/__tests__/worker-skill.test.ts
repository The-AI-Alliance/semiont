/**
 * The `semiont-worker` skill's complete worker, run.
 *
 * The TypeScript block of docs/builder/skills/semiont-worker/SKILL.md that
 * has `main` is a whole program. Node is given it here word for word, as
 * whoever copies it would run it, with a gateway and the issuer it trusts
 * standing in on this machine. What the program sends is read off them.
 *
 * The program imports `@semiont/sdk` and `@semiont/core` by name, so what
 * runs is the built packages: `npm run build --workspace=@semiont/sdk` comes
 * first, and a package that is not built fails this test by name.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isObject, isString } from '@semiont/core';
import { JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS } from '../claims';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PACKAGE = join(REPO, 'packages/sdk');
const SKILL = readFileSync(join(REPO, 'docs/builder/skills/semiont-worker/SKILL.md'), 'utf-8');

/** The skill's TypeScript blocks that are a whole program: the ones that have a `main`. */
const PROGRAMS = [...SKILL.matchAll(/^```typescript\n([\s\S]*?)^```$/gm)]
  .map((fence) => fence[1])
  .filter((block) => block.includes('async function main('));

/** A member of a JSON object. One that is not there is a failure that says so. */
function member(value: unknown, name: string): unknown {
  if (!isObject(value) || !(name in value)) throw new Error(`${JSON.stringify(value)} has no \`${name}\``);
  return value[name];
}

function text(value: unknown): string {
  if (!isString(value)) throw new Error(`${JSON.stringify(value)} is not text`);
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${JSON.stringify(value)} is not a list`);
  return value;
}

/** A JWT that carries `claims`. Nothing here signs one, and nothing in the SDK verifies one. */
function jwt(claims: object): string {
  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(claims)}.${segment('signature')}`;
}

/** One request, as it arrived. */
interface Asked {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

/** One emit the gateway's bus accepted. */
interface Emitted {
  channel: string;
  payload: unknown;
  authorization: string | undefined;
}

interface StandIn {
  origin: string;
  /** Every request, in the order it came. */
  asked: Asked[];
  /** Every emit the bus accepted, in order. */
  emitted: Emitted[];
  close(): Promise<void>;
}

/** What the stand-in is told: who it says an agent is, the tokens it gives, the jobs its queue holds, and each resource's text. */
interface Knows {
  did: string;
  serviceToken: string;
  agentToken: string;
  queue: readonly unknown[];
  resources: Readonly<Record<string, string>>;
}

/**
 * A gateway and the issuer it trusts, on this machine. It names its issuer,
 * grants a service account its token, exchanges that for an agent's, holds a
 * stream open, serves a resource's bytes, and takes emits. Of what is emitted
 * it answers a claim, as the dispatcher does: the next job of its queue, or
 * that none is pending. And it answers a commit, as the record does: every
 * annotation of the batch is held, by its id.
 */
async function standIn(knows: Knows): Promise<StandIn> {
  const asked: Asked[] = [];
  const emitted: Emitted[] = [];
  const streams: ServerResponse[] = [];
  const queue = [...knows.queue];

  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const address = server.address();
  if (address === null || isString(address)) throw new Error('a listening server has a port');
  const origin = `http://127.0.0.1:${address.port}`;
  const issuer = `${origin}/realms/semiont`;

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  /** Say `payload` on `channel` to every open stream, as the answer to the request `correlationId` names. */
  const answer = (channel: string, correlationId: string, payload: unknown): void => {
    for (const stream of streams) stream.write(`event: bus-event\ndata: ${JSON.stringify({ channel, correlationId, payload })}\n\n`);
  };

  server.on('request', (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const { method, url: path } = request;
      if (method === undefined || path === undefined) throw new Error('a request to a server has a method and a path');
      const body = Buffer.concat(chunks).toString('utf-8');
      asked.push({ method, path, authorization: request.headers.authorization, body });

      switch (`${method} ${path}`) {
        case 'GET /.well-known/oauth-protected-resource':
          return json(response, 200, { resource: 'https://kb.example.org', authorization_servers: [issuer], bearer_methods_supported: ['header'] });
        case 'GET /realms/semiont/.well-known/openid-configuration':
          return json(response, 200, { issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token` });
        case 'POST /realms/semiont/token':
          return json(response, 200, { access_token: knows.serviceToken, expires_in: 300 });
        case 'POST /api/tokens/agent':
          return json(response, 200, { token: knows.agentToken, did: knows.did });
        case 'POST /bus/subscribe':
          // The stream is the response: it lasts until one side ends it.
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.flushHeaders();
          streams.push(response);
          return;
        case 'POST /bus/emit': {
          const sent: unknown = JSON.parse(body);
          emitted.push({ channel: text(member(sent, 'channel')), payload: member(sent, 'payload'), authorization: request.headers.authorization });
          json(response, 202, {});
          if (member(sent, 'channel') === 'job:claim') {
            const job = queue.shift();
            if (job === undefined) answer('job:claim-failed', text(member(sent, 'correlationId')), { message: 'No pending job matches', code: 'none-pending' });
            else answer('job:claimed', text(member(sent, 'correlationId')), { response: job });
          }
          if (member(sent, 'channel') === 'mark:commit') {
            const ids = list(member(member(sent, 'payload'), 'annotations')).map((annotation) => member(annotation, 'id'));
            answer('mark:commit-ok', text(member(sent, 'correlationId')), { response: { persisted: ids.length, annotationIds: ids } });
          }
          return;
        }
      }
      const resource = method === 'GET' && path.startsWith('/resources/') ? knows.resources[decodeURIComponent(path.slice('/resources/'.length))] : undefined;
      if (resource === undefined) return json(response, 404, { error: 'The gateway has no such thing' });
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(resource);
    });
  });

  return {
    origin,
    asked,
    emitted,
    close: async () => {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((closed) => server.close(() => closed()));
    },
  };
}

const SECRET = 's3cr3t &=+/';
const DID = 'did:web:example.org:agents:ollama:gemma3%3A4b';
const JOB = {
  status: 'running',
  metadata: {
    id: 'job-1', type: 'mark', userId: 'did:web:kb.example:users:u',
    created: '2026-01-01T00:00:00.000Z', retryCount: 0, maxRetries: 1,
  },
  params: { resourceId: 'res-1', motivation: 'highlighting' },
  startedAt: '2026-01-01T00:00:01.000Z',
  progress: {},
};

describe('the complete worker of the semiont-worker skill', () => {
  let gateway: StandIn | undefined;
  let worker: ChildProcessWithoutNullStreams | undefined;

  afterEach(async () => {
    worker?.kill('SIGKILL');
    await gateway?.close();
  });

  it('claims as its agent, commits a highlight it built, says the job\'s lifecycle, claims again, and stops when it is told to', async () => {
    expect(PROGRAMS, 'the skill shows one TypeScript program').toHaveLength(1);
    const [program] = PROGRAMS;
    for (const imported of program.matchAll(/from '@semiont\/([a-z-]+)'/g)) {
      const built = join(REPO, 'packages', imported[1], 'dist/index.js');
      if (!existsSync(built)) throw new Error(`${built} is missing: this test runs the built packages, so run \`npm run build --workspace=@semiont/sdk\` first`);
    }

    // A case of the table the builders are held by: a text that is one sentence, and the highlight of all of it.
    const table: unknown = JSON.parse(readFileSync(join(REPO, 'specs/src/annotations/builder-cases.json'), 'utf-8'));
    const stated = list(member(table, 'cases'))[2];
    const page = text(member(stated, 'text'));
    expect([member(stated, 'resourceId'), member(stated, 'motivation'), member(stated, 'span')]).toEqual([
      'res-1', 'highlighting', { start: 0, end: 39, exact: page, prefix: '', suffix: '' },
    ]);

    const issued = Math.floor(Date.now() / 1000);
    const serviceToken = jwt({ iat: issued, exp: issued + 300, n: 0 });
    const agentToken = jwt({ iat: issued, exp: issued + 3600, n: 1 });
    const standing = await standIn({ did: DID, serviceToken, agentToken, queue: [JOB], resources: { 'res-1': page } });
    gateway = standing;

    const running = spawn(process.execPath, ['--input-type=module-typescript', '-'], {
      cwd: PACKAGE,
      env: { SEMIONT_API_URL: standing.origin, SEMIONT_OIDC_CLIENT_ID: 'my-worker', SEMIONT_OIDC_CLIENT_SECRET: SECRET },
    });
    worker = running;
    const said = { out: '', err: '' };
    running.stdout.setEncoding('utf-8').on('data', (written: string) => { said.out += written; });
    running.stderr.setEncoding('utf-8').on('data', (written: string) => { said.err += written; });
    let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const over = new Promise<void>((resolve) => running.on('exit', (code, signal) => { ended = { code, signal }; resolve(); }));
    running.stdin.end(program);

    const channels = (): string[] => standing.emitted.map((emit) => emit.channel);
    const account = (): string => [
      `It emitted: ${channels().join(', ')}`,
      `It asked: ${standing.asked.map((request) => `${request.method} ${request.path}`).join(', ')}`,
      `It ended: ${JSON.stringify(ended)}`,
      `stdout:\n${said.out}`,
      `stderr:\n${said.err}`,
    ].join('\n');
    /** Wait for `seen`. A worker that ended, or twenty seconds gone, is a failure that says what there was. */
    const until = async (what: string, seen: () => boolean): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (!seen()) {
        if (ended !== undefined || Date.now() > deadline) throw new Error(`${what} did not happen.\n${account()}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    // Settling the job is an idle moment, and so the next claim.
    await until('the worker\'s second claim', () => channels().filter((channel) => channel === 'job:claim').length === 2);
    expect(channels()).toEqual(['job:claim', 'job:start', 'mark:commit', 'job:complete', 'job:claim']);
    const [claim, start, commit, complete] = standing.emitted.map((emit) => emit.payload);
    expect(claim).toEqual({ accepts: [{ jobType: 'mark', params: { motivation: 'highlighting' } }] });
    // Every message of the lifecycle names the job and the attempt it is.
    const identity = { resourceId: 'res-1', jobId: 'job-1', jobType: 'mark', attempt: 1 };
    expect(start).toEqual(identity);

    // It commits the one highlight, for the job: of the sentence its stand-in model quoted, as the text has it, made by the agent it works as.
    expect([member(commit, 'resourceId'), member(commit, 'jobId')]).toEqual(['res-1', 'job-1']);
    const batch = list(member(commit, 'annotations'));
    expect(batch).toHaveLength(1);
    const [highlight] = batch;
    expect(member(highlight, 'id')).toBe(member(member(stated, 'annotation'), 'id'));
    expect(member(highlight, 'motivation')).toBe('highlighting');
    expect(member(highlight, 'target')).toEqual(member(member(stated, 'annotation'), 'target'));
    expect(member(highlight, 'generator')).toEqual({ '@type': 'Software', '@id': DID, name: 'ollama gemma3:4b', provider: 'ollama', model: 'gemma3:4b' });
    // And it reports what it proposed and what the record holds, established by the record's acknowledgement.
    expect(complete).toEqual({ ...identity, result: { found: 1, persisted: 1 }, durability: 'acknowledged' });

    // It signed in as its service account, and works as the agent that account was exchanged for.
    const [grant] = standing.asked.filter((request) => `${request.method} ${request.path}` === 'POST /realms/semiont/token');
    expect(Object.fromEntries(new URLSearchParams(grant.body))).toEqual({ grant_type: 'client_credentials', client_id: 'my-worker', client_secret: SECRET });
    const [exchange] = standing.asked.filter((request) => request.path === '/api/tokens/agent');
    const exchanged: unknown = JSON.parse(exchange.body);
    expect([exchange.authorization, exchanged]).toEqual([`Bearer ${serviceToken}`, { provider: 'ollama', model: 'gemma3:4b' }]);
    expect(new Set(standing.emitted.map((emit) => emit.authorization))).toEqual(new Set([`Bearer ${agentToken}`]));
    expect(said.out.split('\n')).toContain(`working as ${DID}`);
    // Its stream names what claiming and committing read, and nothing else.
    const [subscription] = standing.asked.filter((request) => request.path === '/bus/subscribe');
    const named: unknown = JSON.parse(subscription.body);
    expect([...list(member(named, 'global'))].sort()).toEqual([...JOB_CLAIM_CHANNELS, ...JOB_COMMIT_CHANNELS].sort());

    // Told to stop while it holds nothing, it ends, and has failed nothing.
    running.kill('SIGTERM');
    const stopped = await new Promise<boolean>((resolve) => {
      const late = setTimeout(() => resolve(false), 20_000);
      void over.then(() => {
        clearTimeout(late);
        resolve(true);
      });
    });
    if (!stopped) throw new Error(`the worker did not end when it was told to.\n${account()}`);
    expect(ended).toEqual({ code: 0, signal: null });
    expect(channels()).not.toContain('job:fail');
    expect(`${said.out}${said.err}`).not.toContain(SECRET);
  }, 60_000);
});
