/**
 * Starting and stopping Librarian processes.
 *
 * A Librarian is one of `LIBRARIAN_SERVICES`, its settings and an
 * environment. The settings are what a Librarian is told, whatever form its
 * implementation reads them in. The TypeScript Librarian reads a
 * `.semiontconfig` in its home directory, and finds the state volume by
 * `XDG_STATE_HOME`: the harness writes that file, as the launcher stages one,
 * into a home directory of the process's own. The environment holds its
 * service account, the graph database's password under the name its settings
 * give it, and PATH, which finds its command; nothing else from the
 * developer's shell.
 *
 * A Librarian's health port is a constant, so two cannot run at once: a
 * Librarian is not started while anything answers there.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectLines } from './gateway';
import { call } from './http';

/** How one implementation of the Librarian is started and reached. */
export interface LibrarianService {
  command: readonly string[];
  /** The port its health answers on. */
  healthPort: number;
  /** How its settings reach it: `semiontconfig` is a `.semiontconfig` in its home directory, with the state volume named by `XDG_STATE_HOME`. */
  configuredBy: 'semiontconfig';
}

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
  /** The knowledge base's name, by which it finds the views under the state volume. */
  kbName?: string;
  /** The state volume the Archivist writes the views and the people projection into. */
  stateHome?: string;
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
  service: LibrarianService;
  settings: LibrarianSettings;
  env: LibrarianEnvironment;
  /** The Librarian's home directory. */
  home: string;
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

// ── The settings, as the `.semiontconfig` a TypeScript Librarian reads ─────

/** The environment the file declares and selects. */
const ENVIRONMENT = 'conformance';

/** One table of the file: its header, and a line for each member that states something. */
function table(name: string, members: Record<string, string | number | undefined>): string {
  const lines = Object.entries(members).flatMap(([key, value]) => (value === undefined ? [] : [`${key} = ${JSON.stringify(value)}`]));
  return [`[${name}]`, ...lines].join('\n');
}

const model = (settings: ModelSettings) => ({ type: settings.type, model: settings.model, baseURL: settings.baseUrl });

/**
 * The settings as a `.semiontconfig`, as the launcher stages one for a
 * Librarian: the knowledge base's name at the top level, and under the
 * selected environment the sections a Librarian reads. A setting a case left
 * out is a key or a section left out. Three things here are what the file's
 * reader demands of any section it is given and are no setting of a
 * Librarian's: a `platform` for the gateway and for the graph, and the
 * identity provider's `type` and `subjectClaim`.
 *
 * The graph's password is written as a reference to its variable, never as
 * its value. Each actor's binding names its provider's address itself, so the
 * file needs no `[inference]` table and the two actors can be served at two
 * addresses.
 */
function semiontconfig(settings: LibrarianSettings): string {
  const at = `environments.${ENVIRONMENT}`;
  const { graph, vectors } = settings;
  const tables: string[] = [
    table('defaults', { environment: ENVIRONMENT }),
    ...(settings.kbName === undefined ? [] : [table('kb', { name: settings.kbName })]),
    table(at, {}),
    ...(settings.gatewayUrl === undefined ? [] : [table(`${at}.gateway`, { platform: 'external', publicURL: settings.gatewayUrl })]),
    table(`${at}.identity`, { type: 'oidc', issuer: settings.issuer, subjectClaim: 'sub' }),
    ...(settings.archivist === undefined ? [] : [table(`${at}.archivist`, settings.archivist)]),
    ...(graph === undefined
      ? []
      : [
          graph.type === 'memory'
            ? table(`${at}.graph`, { platform: 'external', type: 'memory' })
            : table(`${at}.graph`, { platform: 'external', type: 'neo4j', uri: graph.uri, username: graph.username, password: `\${${graph.passwordEnv}}`, database: graph.database }),
        ]),
    ...(vectors === undefined ? [] : [vectors.type === 'memory' ? table(`${at}.vectors`, { type: 'memory' }) : table(`${at}.vectors`, { type: 'qdrant', host: vectors.host, port: vectors.port })]),
    ...(settings.embedding === undefined ? [] : [table(`${at}.embedding`, model(settings.embedding))]),
    ...(settings.settleTimeoutMs === undefined ? [] : [table(`${at}.make-meaning.gather`, { settleTimeoutMs: settings.settleTimeoutMs })]),
    ...(settings.semanticFloor === undefined ? [] : [table(`${at}.make-meaning.search`, { semanticFloor: settings.semanticFloor })]),
    ...(settings.matcher === undefined ? [] : [table(`${at}.actors.matcher.inference`, model(settings.matcher))]),
    ...(settings.gatherer === undefined ? [] : [table(`${at}.actors.gatherer.inference`, model(settings.gatherer))]),
  ];
  return `${tables.join('\n\n')}\n`;
}

// ── The process ────────────────────────────────────────────────────────────

const originOf = (service: LibrarianService) => `http://127.0.0.1:${service.healthPort}`;

async function healthOf(origin: string): Promise<LibrarianHealth | undefined> {
  try {
    const reply = await call(origin, 'GET', '/health');
    return reply.status === 200 ? (reply.json as LibrarianHealth) : undefined;
  } catch {
    return undefined; // not listening
  }
}

async function launch({ service, settings, env, home }: LibrarianLaunch): Promise<{ child: ChildProcess; output: string[]; exited: Promise<number | null> }> {
  const origin = originOf(service);
  if (await healthOf(origin)) {
    throw new Error(`something already answers at ${origin}/health: a Librarian's health port is a constant, so the one that is running is stopped before another is started`);
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.semiontconfig'), semiontconfig(settings));
  const childEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home };
  if (settings.stateHome !== undefined) childEnv['XDG_STATE_HOME'] = settings.stateHome;
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  const [program, ...args] = service.command;
  const child = spawn(program!, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const origin = originOf(options.service);
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
  const origin = originOf(options.service);
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
