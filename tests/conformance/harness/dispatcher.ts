/**
 * Starting and stopping dispatcher processes.
 *
 * A dispatcher is `DISPATCHER_COMMAND`, `--config <document>` and an
 * environment. The document is the spec's `DispatcherConfig`, written as the
 * settings say; a case that needs a broken document writes `verbatim`, never a
 * hand-edited rendering. The environment holds the dispatcher's service account
 * and the variables its document names, and nothing from the developer's shell
 * but PATH.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { components } from '@semiont/core';
import { inject } from 'vitest';
import { call, type Reply } from './http';

export type DispatcherSettings = components['schemas']['DispatcherConfig'];
export type DispatcherTiming = DispatcherSettings['timing'];

export interface DispatcherEnvironment {
  SEMIONT_OIDC_CLIENT_ID?: string;
  SEMIONT_OIDC_CLIENT_SECRET?: string;
  [name: string]: string | undefined;
}

export interface DispatcherLaunch {
  settings: DispatcherSettings;
  env: DispatcherEnvironment;
  /** Written as the document instead of the settings: for the cases that check what is refused. */
  verbatim?: unknown;
  /** The arguments after the command, when a case means to get them wrong. Default: `--config <document>`. */
  args?: (document: string) => string[];
}

export interface DispatcherProcess {
  readonly settings: DispatcherSettings;
  /** Every complete line it wrote, stdout and stderr interleaved. */
  readonly output: string[];
  readonly exited: Promise<number | null>;
  health(path?: string): Promise<Reply>;
  /** SIGTERM, and wait for it to exit. */
  stop(): Promise<number | null>;
  /** SIGKILL: nothing it would settle on the way out is settled. */
  crash(): Promise<void>;
}

/** The clocks a dispatcher runs with when a case says nothing else: long enough never to act inside a case. */
export const QUIET_TIMING: DispatcherTiming = {
  tickMs: 60_000,
  staleRunningMs: 30 * 60_000,
  ackWaitMs: 30_000,
  retentionMs: 24 * 60 * 60_000,
  retentionSweepMs: 60 * 60_000,
  progressWriteIntervalMs: 5_000,
  bootDeadlineMs: 20_000,
};

function collectLines(stream: NodeJS.ReadableStream, into: string[]): void {
  let partial = '';
  stream.on('data', (chunk: Buffer) => {
    const parts = (partial + chunk.toString('utf8')).split('\n');
    partial = parts.pop() ?? '';
    for (const line of parts) if (line) into.push(line);
  });
  stream.on('end', () => {
    if (partial) into.push(partial);
  });
}

function launch({ settings, env, verbatim, args }: DispatcherLaunch): { child: ChildProcess; output: string[]; exited: Promise<number | null>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-dispatcher-'));
  const document = join(dir, 'dispatcher.json');
  writeFileSync(document, (typeof verbatim === 'string' ? verbatim : JSON.stringify(verbatim ?? settings, null, 2)) + '\n');
  const childEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  const [command, ...prefix] = inject('dispatcherCommand');
  const child = spawn(command!, [...prefix, ...(args ? args(document) : ['--config', document])], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  collectLines(child.stdout!, output);
  collectLines(child.stderr!, output);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output, exited, dir };
}

const healthOf = (port: number) => (path = '/health') => call(`http://127.0.0.1:${port}`, 'GET', path);

/** Start a dispatcher and wait until its health answers. Fails with its output when it exits instead. */
export async function startDispatcher(options: DispatcherLaunch): Promise<DispatcherProcess> {
  const { child, output, exited, dir } = launch(options);
  const health = healthOf(options.settings.port);
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + options.settings.timing.bootDeadlineMs + 30_000;
  for (;;) {
    if (gone) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`the dispatcher exited before serving (code ${child.exitCode}):\n${output.join('\n')}`);
    }
    try {
      if ((await health()).status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the dispatcher did not serve in time:\n${output.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const running = () => child.exitCode === null && child.signalCode === null;
  return {
    settings: options.settings,
    output,
    exited,
    health,
    async stop() {
      if (running()) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        await exited;
        clearTimeout(timer);
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
 * Start a dispatcher that must refuse: it exits, non-zero, without its health
 * ever answering. Returns its exit code, its output and how long it took.
 */
export async function refusedDispatcherBoot(options: DispatcherLaunch, timeoutMs = 60_000): Promise<{ code: number | null; output: string; afterMs: number }> {
  const started = Date.now();
  const { child, output, exited, dir } = launch(options);
  const health = healthOf(options.settings.port);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  let done = false;
  let served = false;
  void exited.then(() => {
    done = true;
  });
  while (!done) {
    try {
      await health();
      served = true;
      child.kill('SIGKILL');
    } catch {
      // not listening, as it should be
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  clearTimeout(timer);
  const code = await exited;
  rmSync(dir, { recursive: true, force: true });
  if (served) throw new Error(`the dispatcher served although it should have refused to start:\n${output.join('\n')}`);
  return { code, output: output.join('\n'), afterMs: Date.now() - started };
}
