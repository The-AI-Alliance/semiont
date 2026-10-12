/**
 * Starting and stopping Smelter processes.
 *
 * A Smelter is one of `SMELTER_SERVICES`, its settings and an environment.
 * The settings are what SMELTER.md § Settings says a Smelter is told, stated
 * here once for every implementation. How an implementation is given them is
 * its own, and its line of `SMELTER_SERVICES` says which way that is: the
 * harness writes them that way, into a home directory of the process's own.
 * The environment holds its service account, the directory of the
 * anchored-text store, and PATH, which finds its command; nothing else from
 * the developer's shell.
 *
 * A Smelter's health port is a constant, so two cannot run at once: a Smelter
 * is not started while anything answers there.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectLines } from './gateway';
import { call } from './http';

/** The port a Smelter's health answers on (SMELTER.md § Health). */
export const SMELTER_HEALTH_PORT = 24101;

/** How one implementation of the Smelter is started, and how it is given its settings. */
export interface SmelterService {
  command: readonly string[];
  /**
   * How it is given its settings. `semiontconfig`: it reads them from the file
   * `.semiontconfig` of its home directory, the knowledge base's
   * configuration file, in TOML.
   */
  settings: 'semiontconfig';
}

/**
 * What a Smelter is told (SMELTER.md § Settings). Every member the page says
 * a Smelter refuses to start without may be left out, for the case that
 * holds the refusal.
 */
export interface SmelterSettings {
  gatewayUrl?: string;
  /** The issuer its service account signs in at. */
  issuer?: string;
  /** Where the Archivist is, for a resource's bytes. */
  archivist?: { host: string; port: number };
  /** The vector database: its kind, and its host and port. */
  vectors: { type: 'qdrant'; host?: string; port?: number };
  /** The embedding provider: its kind, its model and its address. */
  embedding: { type?: 'ollama'; model?: string; baseURL?: string };
  /** The two numbers a text is cut by: a chunk's size, and how far one chunk overlaps the next. */
  chunking?: { chunkSize: number; overlap: number };
}

export interface SmelterEnvironment {
  SEMIONT_OIDC_CLIENT_ID?: string;
  SEMIONT_OIDC_CLIENT_SECRET?: string;
  SEMIONT_ANCHORED_TEXT_DIR?: string;
  [name: string]: string | undefined;
}

/** What a reconcile came to, as its health reports it (SMELTER.md § Reconcile). */
export interface ReconcileSummary {
  resourcesEmbedded: number;
  /** How many were skipped, by reason. */
  resourcesSkipped: Record<string, number>;
  resourcesUnavailable: number;
  resourcesFailed: number;
  resourcesRestamped: number;
  resourcesReanchored: number;
  resourceVectorsDeleted: number;
  annotationsEmbedded: number;
  annotationVectorsDeleted: number;
  resourcesEligible: number;
  resourcesIndexed: number;
}

export interface SmelterHealth {
  status: string;
  /** The number of events it has applied since it started. */
  eventsProcessed: number;
  reconcile: { phase: 'pending' | 'running' | 'done' | 'failed'; summary?: ReconcileSummary; error?: string };
}

export interface SmelterLaunch {
  service: SmelterService;
  settings: SmelterSettings;
  env: SmelterEnvironment;
  /** The Smelter's home directory. */
  home: string;
}

export interface SmelterProcess {
  readonly origin: string;
  /** Every complete line it wrote, stdout and stderr interleaved. */
  readonly output: string[];
  readonly exited: Promise<number | null>;
  health(): Promise<SmelterHealth>;
  /** SIGTERM, and wait for it to exit: its exit code. */
  stop(): Promise<number | null>;
  /** SIGKILL: nothing it would settle on the way out is settled. */
  crash(): Promise<void>;
}

// ── Each way of giving a Smelter its settings ──────────────────────────────

/** The one environment a configuration file the harness writes declares, and selects. */
const ENVIRONMENT = 'conformance';

/**
 * The settings as a knowledge base's configuration file states them: a
 * section of the selected environment for each thing a Smelter is told of,
 * holding what the settings state of it. The file's reader asks of three
 * sections what no Smelter is told, and the harness states it as a stack the
 * launcher starts does: that the gateway is reached and not run (`platform`),
 * and the kind of issuer and the claim people are named by.
 *
 * A Smelter told no gateway URL is given no gateway section: the file's
 * reader fills a section that states no URL with an address of its own.
 */
function semiontconfig(settings: SmelterSettings): string {
  const section = (name: string, members: Record<string, string | number | undefined>): string[] => [
    `[environments.${ENVIRONMENT}.${name}]`,
    ...Object.entries(members).flatMap(([key, value]) => (value === undefined ? [] : [`${key} = ${JSON.stringify(value)}`])),
    '',
  ];
  return [
    '[defaults]',
    `environment = ${JSON.stringify(ENVIRONMENT)}`,
    '',
    ...(settings.gatewayUrl === undefined ? [] : section('gateway', { platform: 'external', publicURL: settings.gatewayUrl })),
    ...section('identity', { type: 'oidc', subjectClaim: 'sub', issuer: settings.issuer }),
    ...(settings.archivist === undefined ? [] : section('archivist', { host: settings.archivist.host, port: settings.archivist.port })),
    ...section('vectors', { type: settings.vectors.type, host: settings.vectors.host, port: settings.vectors.port }),
    ...section('embedding', { type: settings.embedding.type, model: settings.embedding.model, baseURL: settings.embedding.baseURL }),
    ...(settings.chunking === undefined ? [] : section('embedding.chunking', { chunkSize: settings.chunking.chunkSize, overlap: settings.chunking.overlap })),
  ].join('\n');
}

/** Each way a Smelter is given its settings: what the harness writes into its home directory. */
const GIVEN: Readonly<Record<SmelterService['settings'], (settings: SmelterSettings, home: string) => void>> = {
  semiontconfig: (settings, home) => writeFileSync(join(home, '.semiontconfig'), semiontconfig(settings)),
};

// ── The process ────────────────────────────────────────────────────────────

const ORIGIN = `http://127.0.0.1:${SMELTER_HEALTH_PORT}`;

async function healthOf(): Promise<SmelterHealth | undefined> {
  try {
    const reply = await call(ORIGIN, 'GET', '/health');
    return reply.status === 200 ? (reply.json as SmelterHealth) : undefined;
  } catch {
    return undefined; // not listening
  }
}

async function launch({ service, settings, env, home }: SmelterLaunch): Promise<{ child: ChildProcess; output: string[]; exited: Promise<number | null> }> {
  if (await healthOf()) {
    throw new Error(`something already answers at ${ORIGIN}/health: a Smelter's health port is a constant, so the one that is running is stopped before another is started`);
  }
  mkdirSync(home, { recursive: true });
  GIVEN[service.settings](settings, home);
  const childEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home };
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  const [program, ...args] = service.command;
  const child = spawn(program!, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  collectLines(child.stdout!, [output]);
  collectLines(child.stderr!, [output]);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output, exited };
}

/** Whether a health says its reconcile has ended. One that reports no reconcile says no such thing, and its Smelter is waited out. */
const ended = (health: SmelterHealth) => health.reconcile?.phase === 'done' || health.reconcile?.phase === 'failed';

/**
 * Start a Smelter and wait until its health answers and, unless `until` is
 * `serving`, its reconcile has ended, however it ended: a case reads how.
 * Fails with its output when it exits instead.
 */
export async function startSmelter(options: SmelterLaunch, until: 'serving' | 'reconciled' = 'reconciled', bootMs = 120_000): Promise<SmelterProcess> {
  const { child, output, exited } = await launch(options);
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + bootMs;
  for (;;) {
    if (gone) throw new Error(`the Smelter exited before serving (code ${child.exitCode}):\n${output.join('\n')}`);
    const health = await healthOf();
    if (health && (until === 'serving' || ended(health))) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the Smelter did not finish starting in time:\n${output.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const running = () => child.exitCode === null && child.signalCode === null;
  return {
    origin: ORIGIN,
    output,
    exited,
    async health() {
      const health = await healthOf();
      if (!health) throw new Error(`the Smelter's health did not answer:\n${output.slice(-20).join('\n')}`);
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
 * Start a Smelter that must refuse: it exits without its health ever
 * answering. Returns its exit code and its output. One that serves, and one
 * that has neither served nor exited by `timeoutMs`, is a failure.
 */
export async function refusedSmelterBoot(options: SmelterLaunch, timeoutMs = 60_000): Promise<{ code: number | null; output: string }> {
  const { child, output, exited } = await launch(options);
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
    if (await healthOf()) {
      served = true;
      child.kill('SIGKILL');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  clearTimeout(timer);
  const code = await exited;
  if (served) throw new Error(`the Smelter served although it should have refused to start:\n${output.join('\n')}`);
  if (waitedOut) throw new Error(`the Smelter had neither refused to start nor served after ${timeoutMs} ms:\n${output.join('\n')}`);
  return { code, output: output.join('\n') };
}
