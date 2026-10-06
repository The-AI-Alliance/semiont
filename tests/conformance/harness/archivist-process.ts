/**
 * Starting and stopping Archivist processes.
 *
 * An Archivist is `ARCHIVIST_COMMAND`, `--config <document>` and an
 * environment. The document is the spec's `ArchivistConfig`, written as the
 * settings say; a case that needs a broken document writes `verbatim`, never a
 * hand-edited rendering. The environment holds its service account and PATH,
 * which finds its command and git, and nothing else from the developer's
 * shell.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { components } from '@semiont/core';
import { inject } from 'vitest';
import { call, type CallOptions, type Reply } from './http';

export type ArchivistSettings = components['schemas']['ArchivistConfig'];

export interface ArchivistEnvironment {
  SEMIONT_OIDC_CLIENT_ID?: string;
  SEMIONT_OIDC_CLIENT_SECRET?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_METRIC_EXPORT_INTERVAL?: string;
}

export interface ArchivistLaunch {
  settings: ArchivistSettings;
  env: ArchivistEnvironment;
  /** Written as the document instead of the settings: for the cases that check what is refused. */
  verbatim?: unknown;
  /** The arguments after the command, when a case means to get them wrong. Default: `--config <document>`. */
  args?: (document: string) => string[];
  /** A directory searched before the rest of PATH: where a case puts a command of its own in a real one's way. */
  pathFirst?: string;
  /** Start the other implementation of the Archivist, not the one the suite is judging. */
  peer?: boolean;
}

export interface ArchivistProcess {
  readonly settings: ArchivistSettings;
  readonly origin: string;
  /** Every complete line it wrote, stdout and stderr interleaved. */
  readonly output: string[];
  readonly exited: Promise<number | null>;
  /** A request of its HTTP surface. */
  http(method: string, path: string, options?: CallOptions): Promise<Reply>;
  /** SIGTERM, and wait for it to exit. */
  stop(): Promise<number | null>;
  /** SIGKILL: nothing it would settle on the way out is settled. */
  crash(): Promise<void>;
}

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

function launch({ settings, env, verbatim, args, pathFirst, peer }: ArchivistLaunch): { child: ChildProcess; output: string[]; exited: Promise<number | null>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-archivist-'));
  const document = join(dir, 'archivist.json');
  writeFileSync(document, (typeof verbatim === 'string' ? verbatim : JSON.stringify(verbatim ?? settings, null, 2)) + '\n');
  const childEnv: Record<string, string> = { PATH: [pathFirst, process.env['PATH']].filter((p) => p).join(':') };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  const [command, ...prefix] = inject(peer ? 'archivistPeerCommand' : 'archivistCommand');
  const child = spawn(command!, [...prefix, ...(args ? args(document) : ['--config', document])], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  collectLines(child.stdout!, output);
  collectLines(child.stderr!, output);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output, exited, dir };
}

const originOf = (settings: ArchivistSettings) => `http://127.0.0.1:${settings.port}`;

/** Start an Archivist and wait until its health answers. Fails with its output when it exits instead. */
export async function startArchivistProcess(options: ArchivistLaunch, bootMs = 60_000): Promise<ArchivistProcess> {
  const { child, output, exited, dir } = launch(options);
  const origin = originOf(options.settings);
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + bootMs;
  for (;;) {
    if (gone) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`the Archivist exited before serving (code ${child.exitCode}):\n${output.join('\n')}`);
    }
    try {
      if ((await call(origin, 'GET', '/health')).status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the Archivist did not serve in time:\n${output.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const running = () => child.exitCode === null && child.signalCode === null;
  return {
    settings: options.settings,
    origin,
    output,
    exited,
    http: (method, path, callOptions) => call(origin, method, path, callOptions),
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
 * Start an Archivist that must refuse: it exits, non-zero, without its health
 * ever answering. Returns its exit code, its output and how long it took.
 */
export async function refusedArchivistBoot(options: ArchivistLaunch, timeoutMs = 60_000): Promise<{ code: number | null; output: string; afterMs: number }> {
  const started = Date.now();
  const { child, output, exited, dir } = launch(options);
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
  rmSync(dir, { recursive: true, force: true });
  if (served) throw new Error(`the Archivist served although it should have refused to start:\n${output.join('\n')}`);
  return { code, output: output.join('\n'), afterMs: Date.now() - started };
}
