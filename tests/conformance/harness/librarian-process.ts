/**
 * Starting and stopping Librarian processes.
 *
 * A Librarian is one of `LIBRARIAN_SERVICES`, its settings and an
 * environment. The settings are what LIBRARIAN.md § Settings says a Librarian
 * is told. The harness writes them as the protocol's configuration document
 * (`LibrarianConfig`), into a home directory of the process's own, and starts
 * the Librarian with `--config <document>`. The document states its health
 * port too. The environment holds its service account, the graph database's
 * password under the name its document gives it, and PATH, which finds its
 * command; nothing else from the developer's shell.
 *
 * Every Librarian a world starts is given the world's one health port, so
 * two cannot run at once: a Librarian is not started while anything answers
 * there.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { components } from '@semiont/core';
import { collectLines } from './gateway';
import { call } from './http';
import { MODEL_CATALOGUE, runEnvironment } from './paths';

/** Who serves a model: the provider's kind, the model and the provider's address. */
export interface ModelSettings {
  type: 'ollama';
  model: string;
  baseUrl: string;
}

/**
 * What a Librarian is told. Every member may be left out, for the case that
 * holds what a Librarian does without it.
 */
export interface LibrarianSettings {
  gatewayUrl?: string;
  /** The issuer its service account signs in at. */
  issuer?: string;
  /** Where the Archivist is, for a resource's bytes. */
  archivist?: { host: string; port: number };
  /** The graph database. Its password is the environment's, under `passwordEnv`. */
  graph?: { type: 'neo4j'; uri: string; username: string; database: string; passwordEnv: string } | { type: 'memory' };
  /** The vector database. */
  vectors?: { type: 'qdrant'; host: string; port: number } | { type: 'memory' };
  /** The embedding provider, which gives a query its vector. */
  embedding?: ModelSettings;
  /** The model the Matcher scores candidates with. */
  matcher?: ModelSettings;
  /** The model the Gatherer writes summaries with. */
  gatherer?: ModelSettings;
  /** How long a gather waits for a resource's vectors to settle, in milliseconds. */
  settleTimeoutMs?: number;
  /** The least score a hit of the semantic fallback is answered with. */
  semanticFloor?: number;
}

export interface LibrarianEnvironment {
  SEMIONT_OIDC_CLIENT_ID?: string;
  SEMIONT_OIDC_CLIENT_SECRET?: string;
  [name: string]: string | undefined;
}

/** What a Librarian's health answers: its status, and whatever else its implementation reports. */
export interface LibrarianHealth {
  status: string;
  [member: string]: unknown;
}

export interface LibrarianLaunch {
  /** How the Librarian is started: its line of `LIBRARIAN_SERVICES`. */
  command: readonly string[];
  settings: LibrarianSettings;
  env: LibrarianEnvironment;
  /** The Librarian's home directory. */
  home: string;
  /** The port its health answers on, which its document tells it. */
  port: number;
}

export interface LibrarianProcess {
  readonly origin: string;
  /** Every complete line it wrote, stdout and stderr interleaved. */
  readonly output: string[];
  readonly exited: Promise<number | null>;
  health(): Promise<LibrarianHealth>;
  /** SIGTERM, and wait for it to exit: its exit code. */
  stop(): Promise<number | null>;
  /** SIGKILL: nothing it would settle on the way out is settled. */
  crash(): Promise<void>;
}

// ── The settings, as the document a Librarian reads ────────────────────────

type LibrarianDocument = components['schemas']['LibrarianConfig'];

/** The document as a case may leave it: any member left out, and `identity` without its issuer. */
type WrittenDocument = {
  [Member in keyof LibrarianDocument]: (Member extends 'identity' ? { issuer: string | undefined } : LibrarianDocument[Member]) | undefined;
};

/** An actor's model as the document states it: who the agent is, and where its provider is reached. */
const actor = (settings: ModelSettings | undefined): LibrarianDocument['matcher'] | undefined =>
  settings === undefined ? undefined : { agent: { provider: settings.type, model: settings.model }, baseUrl: settings.baseUrl };

/**
 * The settings as the protocol's configuration document states them
 * (`LibrarianConfig`). A setting a case left out is a member left out, which
 * the document's reader refuses by name. The graph's password is named by its
 * variable, never written. No case changes how the Librarian logs: the log is
 * written as a person reads it.
 */
function document(settings: LibrarianSettings, port: number): string {
  const written: WrittenDocument = {
    gatewayUrl: settings.gatewayUrl,
    identity: { issuer: settings.issuer },
    archivist: settings.archivist,
    graph: settings.graph,
    vectors: settings.vectors,
    embedding: settings.embedding,
    matcher: actor(settings.matcher),
    gatherer: actor(settings.gatherer),
    modelCatalogue: MODEL_CATALOGUE,
    gather: settings.settleTimeoutMs === undefined ? undefined : { settleTimeoutMs: settings.settleTimeoutMs },
    search: settings.semanticFloor === undefined ? undefined : { semanticFloor: settings.semanticFloor },
    port,
    logLevel: 'info',
    logFormat: 'simple',
  };
  // A member that states nothing is not written.
  return JSON.stringify(written);
}

// ── The process ────────────────────────────────────────────────────────────

const originOf = (port: number) => `http://127.0.0.1:${port}`;

async function healthOf(origin: string): Promise<LibrarianHealth | undefined> {
  try {
    const reply = await call(origin, 'GET', '/health');
    return reply.status === 200 ? (reply.json as LibrarianHealth) : undefined;
  } catch {
    return undefined; // not listening
  }
}

async function launch({ command, settings, env, home, port }: LibrarianLaunch): Promise<{ child: ChildProcess; output: string[]; exited: Promise<number | null> }> {
  const origin = originOf(port);
  if (await healthOf(origin)) {
    throw new Error(`something already answers at ${origin}/health: the Librarian that is running there is stopped before another is started on its port`);
  }
  mkdirSync(home, { recursive: true });
  const config = join(home, 'librarian.json');
  writeFileSync(config, document(settings, port));
  const childEnv: Record<string, string> = runEnvironment();
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  const [program, ...prefix] = command;
  const child = spawn(program!, [...prefix, '--config', config], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  collectLines(child.stdout!, [output]);
  collectLines(child.stderr!, [output]);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output, exited };
}

/**
 * Start a Librarian and wait until its health answers. Fails with its output
 * when it exits instead.
 */
export async function startLibrarian(options: LibrarianLaunch, bootMs = 120_000): Promise<LibrarianProcess> {
  const { child, output, exited } = await launch(options);
  const origin = originOf(options.port);
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + bootMs;
  for (;;) {
    if (gone) throw new Error(`the Librarian exited before serving (code ${child.exitCode}):\n${output.join('\n')}`);
    if (await healthOf(origin)) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the Librarian did not serve in time:\n${output.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const running = () => child.exitCode === null && child.signalCode === null;
  return {
    origin,
    output,
    exited,
    async health() {
      const health = await healthOf(origin);
      if (!health) throw new Error(`the Librarian's health did not answer:\n${output.slice(-20).join('\n')}`);
      return health;
    },
    async stop() {
      if (running()) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        await exited;
        clearTimeout(timer);
      }
      return child.exitCode;
    },
    async crash() {
      if (running()) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

/**
 * Start a Librarian that must refuse: it exits without its health ever
 * answering. Returns its exit code and its output. One that serves, and one
 * that has neither served nor exited by `timeoutMs`, is a failure.
 */
export async function refusedLibrarianBoot(options: LibrarianLaunch, timeoutMs = 60_000): Promise<{ code: number | null; output: string }> {
  const { child, output, exited } = await launch(options);
  const origin = originOf(options.port);
  let done = false;
  let served = false;
  let waitedOut = false;
  void exited.then(() => {
    done = true;
  });
  const timer = setTimeout(() => {
    waitedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  while (!done) {
    if (await healthOf(origin)) {
      served = true;
      child.kill('SIGKILL');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  clearTimeout(timer);
  const code = await exited;
  if (served) throw new Error(`the Librarian served although it should have refused to start:\n${output.join('\n')}`);
  if (waitedOut) throw new Error(`the Librarian had neither refused to start nor served after ${timeoutMs} ms:\n${output.join('\n')}`);
  return { code, output: output.join('\n') };
}
