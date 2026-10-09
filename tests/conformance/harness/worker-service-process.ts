/**
 * Starting and stopping Worker service processes.
 *
 * A Worker service is one of `WORKER_SERVICES`, `--config <document>` and an
 * environment. The document is the spec's `WorkerConfig`, written as the
 * settings say; a case that needs a broken document writes `verbatim`, never a
 * hand-edited rendering. The environment holds what
 * docs/protocol/WORKER-SERVICE.md § Environment says a Worker service reads,
 * and PATH, which finds its command; nothing else from the developer's shell.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { components } from '@semiont/core';
import { collectLines } from './gateway';
import { call, type Reply } from './http';

export type WorkerSettings = components['schemas']['WorkerConfig'];

export interface WorkerEnvironment {
  SEMIONT_OIDC_CLIENT_ID?: string;
  SEMIONT_OIDC_CLIENT_SECRET?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  [name: string]: string | undefined;
}

/**
 * The variables a Worker service reads beside its document and the provider
 * keys the document names (WORKER-SERVICE.md § Environment, which
 * worker-service/environment.test.ts holds this list to). The last is read by
 * the OpenTelemetry SDK a service exports with.
 */
export const READ_FROM_THE_ENVIRONMENT = [
  'SEMIONT_OIDC_CLIENT_ID',
  'SEMIONT_OIDC_CLIENT_SECRET',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'OTEL_SDK_DISABLED',
  'OTEL_CONSOLE_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'SEMIONT_BUS_LOG',
  'SUPERVISE_EVENTS',
  'SUPERVISE_NAME',
  'OTEL_BSP_SCHEDULE_DELAY',
] as const;

export interface WorkerLaunch {
  /** How this implementation is started: one of `WORKER_SERVICES`. */
  command: readonly string[];
  settings: WorkerSettings;
  env: WorkerEnvironment;
  /** Written as the document instead of the settings: for the cases that check what is refused. */
  verbatim?: unknown;
  /** The arguments after the command, when a case means to get them wrong. Default: `--config <document>`. */
  args?: (document: string) => string[];
  /** Variables a Worker service does not read, set only by a case showing that they change nothing. */
  unlisted?: Record<string, string>;
}

export interface WorkerProcess {
  readonly settings: WorkerSettings;
  readonly origin: string;
  /** Every complete line it wrote, stdout and stderr interleaved. */
  readonly output: string[];
  readonly stdout: string[];
  readonly stderr: string[];
  /** Resolves with the exit code once the process has exited. */
  readonly exited: Promise<number | null>;
  /** A request of its health port. */
  http(method: string, path: string): Promise<Reply>;
  /** SIGTERM, and wait for it to exit: its exit code. */
  stop(): Promise<number | null>;
  /** SIGKILL: nothing it would say on the way out is said. */
  crash(): Promise<void>;
}

/**
 * The suite sets nothing a worker does not read: every variable it passes is
 * one of `READ_FROM_THE_ENVIRONMENT` or a provider key the document names,
 * except PATH, and what a case passes as unlisted, which must be none of
 * them.
 */
function checkEnvironment(env: WorkerEnvironment, settings: WorkerSettings, unlisted: Record<string, string>): void {
  const named = settings.agents.flatMap((agent) => (agent.apiKeyEnv === undefined ? [] : [agent.apiKeyEnv]));
  const read = new Set<string>([...READ_FROM_THE_ENVIRONMENT, ...named, 'PATH']);
  const strays = Object.keys(env).filter((name) => env[name] !== undefined && !read.has(name));
  if (strays.length > 0) throw new Error(`the suite set ${strays.join(', ')}, which docs/protocol/WORKER-SERVICE.md § Environment does not say a worker reads and its document does not name`);
  const listed = Object.keys(unlisted).filter((name) => read.has(name));
  if (listed.length > 0) throw new Error(`the suite passed ${listed.join(', ')} as unlisted, and a worker reads it`);
}

function launch({ command, settings, env, verbatim, args, unlisted = {} }: WorkerLaunch): { child: ChildProcess; output: string[]; stdout: string[]; stderr: string[]; exited: Promise<number | null>; dir: string } {
  checkEnvironment(env, settings, unlisted);
  const dir = mkdtempSync(join(tmpdir(), 'conformance-worker-'));
  const document = join(dir, 'worker.json');
  writeFileSync(document, (typeof verbatim === 'string' ? verbatim : JSON.stringify(verbatim ?? settings, null, 2)) + '\n');
  const childEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '', ...unlisted };
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  const [program, ...prefix] = command;
  const child = spawn(program!, [...prefix, ...(args ? args(document) : ['--config', document])], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  collectLines(child.stdout!, [output, stdout]);
  collectLines(child.stderr!, [output, stderr]);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output, stdout, stderr, exited, dir };
}

const originOf = (settings: WorkerSettings) => `http://127.0.0.1:${settings.port}`;

/** The pipes can trail the exit: both are read to their end before what the process wrote is judged. */
async function drained(child: ChildProcess): Promise<void> {
  await Promise.all([child.stdout, child.stderr].map((pipe) => (pipe && !pipe.readableEnded ? new Promise((resolve) => pipe.once('end', resolve)) : undefined)));
}

/** Start a Worker service and wait until its health answers. Fails with its output when it exits instead. */
export async function startWorkerService(options: WorkerLaunch, bootMs = 30_000): Promise<WorkerProcess> {
  const { child, output, stdout, stderr, exited, dir } = launch(options);
  const origin = originOf(options.settings);
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + bootMs;
  for (;;) {
    if (gone) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`the worker exited before its health answered (code ${child.exitCode}):\n${output.join('\n')}`);
    }
    try {
      if ((await call(origin, 'GET', '/health')).status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the worker's health did not answer within ${bootMs} ms:\n${output.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const running = () => child.exitCode === null && child.signalCode === null;
  return {
    settings: options.settings,
    origin,
    output,
    stdout,
    stderr,
    exited,
    http: (method, path) => call(origin, method, path),
    async stop() {
      if (running()) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        await exited;
        clearTimeout(timer);
        await drained(child);
      }
      rmSync(dir, { recursive: true, force: true });
      return child.exitCode;
    },
    async crash() {
      if (running()) {
        child.kill('SIGKILL');
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Start a Worker service that must refuse: it exits without its health ever
 * answering. Returns its exit code and what it wrote, with what it wrote to
 * stderr apart.
 */
export async function refusedWorkerBoot(options: WorkerLaunch, timeoutMs = 30_000): Promise<{ code: number | null; output: string; stderr: string }> {
  const { child, output, stderr, exited, dir } = launch(options);
  const origin = originOf(options.settings);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  let done = false;
  let served = false;
  void exited.then(() => {
    done = true;
  });
  while (!done) {
    try {
      await call(origin, 'GET', '/health');
      served = true;
      child.kill('SIGKILL');
    } catch {
      // not listening, as it should be
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  clearTimeout(timer);
  const code = await exited;
  await drained(child);
  rmSync(dir, { recursive: true, force: true });
  if (served) throw new Error(`the worker served although it should have refused to start:\n${output.join('\n')}`);
  return { code, output: output.join('\n'), stderr: stderr.join('\n') };
}
