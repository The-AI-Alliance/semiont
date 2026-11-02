/**
 * Starting and stopping Weaver processes.
 *
 * A Weaver is one of `WEAVER_SERVICES`, its settings and an environment. Its
 * settings reach it as the protocol's configuration document (`WeaverConfig`),
 * at the path `--config` names, as every other service's do: the harness
 * writes that. The environment holds its service account, the graph
 * database's password under the name its document gives it, and PATH, which
 * finds its command; nothing else from the developer's shell.
 *
 * The home directory is the world's and outlives a process: a Weaver stopped
 * and started again finds what it kept there (its checkpoint, under the
 * temporary directory the harness names inside it), as a restarted container
 * does.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { components } from '@semiont/core';
import { collectLines } from './gateway';
import { call } from './http';
import { runEnvironment } from './paths';

/** How one implementation of the Weaver is started and reached. */
export interface WeaverService {
  command: readonly string[];
  /** The port its health answers on, which the harness writes into its document. */
  healthPort: number;
}

type WeaverDocument = components['schemas']['WeaverConfig'];

/** What a test chooses of a Weaver's document; the harness fills in the rest. */
export interface WeaverSettings {
  /** The knowledge base it serves, which its telemetry names. */
  kb: WeaverDocument['kb'];
  gatewayUrl: WeaverDocument['gatewayUrl'];
  issuer: WeaverDocument['identity']['issuer'];
  /** Where the Archivist listens: the Weaver reads the record by position there. */
  archivist: WeaverDocument['archivist'];
  /** The graph database. Its password is the environment's, under `passwordEnv`. */
  graph: WeaverDocument['graph'];
}

export interface WeaverEnvironment {
  SEMIONT_OIDC_CLIENT_ID?: string;
  SEMIONT_OIDC_CLIENT_SECRET?: string;
  [name: string]: string | undefined;
}

/** The pass a Weaver runs once its first sweep of the record is done, as its health reports it. */
export interface BootPass {
  phase: 'pending' | 'running' | 'done' | 'failed';
  summary?: Record<string, number>;
  error?: string;
}

/** How it follows the record, as its health reports it (WEAVER.md § Health). */
export interface Following {
  sweep: 'pending' | 'running' | 'done' | 'due';
  stopped: number;
  refused: number;
  streamDrops: number;
}

export interface WeaverHealth {
  status: string;
  following: Following;
  reconcile: BootPass;
}

export interface WeaverLaunch {
  service: WeaverService;
  settings: WeaverSettings;
  env: WeaverEnvironment;
  /** The Weaver's home directory, which the world keeps across its restarts. */
  home: string;
}

export interface WeaverProcess {
  readonly origin: string;
  /** Every complete line it wrote, stdout and stderr interleaved. */
  readonly output: string[];
  readonly exited: Promise<number | null>;
  health(): Promise<WeaverHealth>;
  /** SIGTERM, and wait for it to exit: its exit code. */
  stop(): Promise<number | null>;
  /** SIGKILL: nothing it would settle on the way out is settled. */
  crash(): Promise<void>;
}

/**
 * The settings as the protocol's configuration document states them
 * (`WeaverConfig`). The Weaver keeps its cursors in the temporary directory the
 * harness names, which outlives a process as the home directory does.
 */
function document(settings: WeaverSettings, service: WeaverService, temporary: string): string {
  const written: WeaverDocument = {
    kb: settings.kb,
    gatewayUrl: settings.gatewayUrl,
    identity: { issuer: settings.issuer },
    archivist: settings.archivist,
    graph: settings.graph,
    cursorsPath: join(temporary, 'weaver-cursors.json'),
    port: service.healthPort,
    logLevel: 'info',
    logFormat: 'simple',
  };
  return JSON.stringify(written);
}

function launch({ service, settings, env, home }: WeaverLaunch): { child: ChildProcess; output: string[]; exited: Promise<number | null> } {
  const temporary = join(home, 'tmp');
  mkdirSync(temporary, { recursive: true });
  const path = join(home, 'weaver.json');
  writeFileSync(path, document(settings, service, temporary));
  const childEnv: Record<string, string> = { ...runEnvironment(), HOME: home, TMPDIR: temporary };
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  const [program, ...args] = [...service.command, '--config', path];
  const child = spawn(program!, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  collectLines(child.stdout!, [output]);
  collectLines(child.stderr!, [output]);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output, exited };
}

const originOf = (service: WeaverService) => `http://127.0.0.1:${service.healthPort}`;

async function healthOf(origin: string): Promise<WeaverHealth | undefined> {
  try {
    const reply = await call(origin, 'GET', '/health');
    return reply.status === 200 ? (reply.json as WeaverHealth) : undefined;
  } catch {
    return undefined; // not listening
  }
}

const settled = (pass: BootPass | undefined) => pass?.phase === 'done' || pass?.phase === 'failed';

/**
 * Start a Weaver and wait until its health answers, its first sweep of the
 * record is done and its reconcile has ended, however it ended: a case reads
 * how. Fails with its output when it exits instead.
 */
export async function startWeaver(options: WeaverLaunch, bootMs = 120_000): Promise<WeaverProcess> {
  const { child, output, exited } = launch(options);
  const origin = originOf(options.service);
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + bootMs;
  for (;;) {
    if (gone) throw new Error(`the Weaver exited before serving (code ${child.exitCode}):\n${output.join('\n')}`);
    const health = await healthOf(origin);
    if (health && health.following.sweep === 'done' && settled(health.reconcile)) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the Weaver did not finish starting in time:\n${output.join('\n')}`);
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
      if (!health) throw new Error(`the Weaver's health did not answer:\n${output.slice(-20).join('\n')}`);
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
 * Start a Weaver that must refuse: it exits, non-zero, without its health ever
 * answering. Returns its exit code and its output.
 */
export async function refusedWeaverBoot(options: WeaverLaunch, timeoutMs = 60_000): Promise<{ code: number | null; output: string }> {
  const { child, output, exited } = launch(options);
  const origin = originOf(options.service);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  let done = false;
  let served = false;
  void exited.then(() => {
    done = true;
  });
  while (!done) {
    if (await healthOf(origin)) {
      served = true;
      child.kill('SIGKILL');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  clearTimeout(timer);
  const code = await exited;
  if (served) throw new Error(`the Weaver served although it should have refused to start:\n${output.join('\n')}`);
  return { code, output: output.join('\n') };
}
