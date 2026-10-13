/**
 * Starting and stopping Smelter processes.
 *
 * A Smelter is one of `SMELTER_SERVICES`, its settings and an environment.
 * The settings are what SMELTER.md § Settings says a Smelter is told. The
 * harness writes them as the protocol's configuration document
 * (`SmelterConfig`), into a home directory of the process's own, and starts
 * the Smelter with `--config <document>`. The environment holds its service
 * account and PATH, which finds its command and the `tesseract` it reads a
 * scan with; nothing else from the developer's shell.
 *
 * Every Smelter is told the same health port, so two cannot run at once: a
 * Smelter is not started while anything answers there.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectLines } from './gateway';
import { call } from './http';

/** The port every Smelter the harness starts is told to answer its health on (SMELTER.md § Health). */
export const SMELTER_HEALTH_PORT = 24101;

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
  embedding: { type?: 'ollama'; model?: string; baseUrl?: string };
  /** The two numbers a text is cut by: a chunk's size, and how far one chunk overlaps the next. */
  chunking?: { chunkSize: number; overlap: number };
  /** The directory of the anchored-text store. */
  anchoredTextDir?: string;
}

export interface SmelterEnvironment {
  SEMIONT_OIDC_CLIENT_ID?: string;
  SEMIONT_OIDC_CLIENT_SECRET?: string;
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
  annotationsRestamped: number;
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
  /** How the Smelter is started: its line of `SMELTER_SERVICES`. */
  command: readonly string[];
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

// ── The settings, as the document a Smelter reads ──────────────────────────

/** What is left of an object when the members that state nothing are taken out. */
const stated = (members: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(members).filter(([, value]) => value !== undefined));

/**
 * The settings as the protocol's configuration document states them
 * (`SmelterConfig`). A setting a case left out is a member left out, which
 * the document's reader refuses by name. No case changes the health port or
 * how the Smelter logs: the port is the harness's one, and the log is written
 * as a person reads it.
 */
function document(settings: SmelterSettings): string {
  return JSON.stringify(
    stated({
      gatewayUrl: settings.gatewayUrl,
      identity: stated({ issuer: settings.issuer }),
      archivist: settings.archivist,
      embedding: stated({ type: settings.embedding.type, model: settings.embedding.model, baseUrl: settings.embedding.baseUrl }),
      vectors: stated({ type: settings.vectors.type, host: settings.vectors.host, port: settings.vectors.port }),
      chunking: settings.chunking,
      anchoredTextDir: settings.anchoredTextDir,
      port: SMELTER_HEALTH_PORT,
      logLevel: 'info',
      logFormat: 'simple',
    }),
  );
}

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

async function launch({ command, settings, env, home }: SmelterLaunch): Promise<{ child: ChildProcess; output: string[]; exited: Promise<number | null> }> {
  if (await healthOf()) {
    throw new Error(`something already answers at ${ORIGIN}/health: every Smelter is told that port, so the one that is running is stopped before another is started`);
  }
  mkdirSync(home, { recursive: true });
  const config = join(home, 'smelter.json');
  writeFileSync(config, document(settings));
  const childEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home };
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  const [program, ...prefix] = command;
  const child = spawn(program!, [...prefix, '--config', config], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
