/**
 * Starting and stopping gateway processes.
 *
 * A gateway is `GATEWAY_COMMAND`, a configuration document and an
 * environment. The document is `GatewaySettings`, the spec's own type with the
 * fields a case may delete made optional; `writeConfiguration` renders it into
 * the file the gateway reads, and a case that needs a broken configuration
 * edits the settings, never the rendering. The environment holds only what
 * specs/src/gateway-environment/variables.json lists.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { components } from '@semiont/core';
import { inject } from 'vitest';
import { freePort } from './net';
import { gatewayEnvironment } from './spec';

export type Plane = 'in-process' | 'nats';

type Document = components['schemas']['GatewayConfig'];

/** Everything a gateway is configured with: the document, with the fields a case may delete optional. */
export interface GatewaySettings extends Omit<Document, 'kb' | 'identity' | 'archivist'> {
  kb: Partial<Document['kb']>;
  identity: Partial<Document['identity']>;
  archivist: Partial<Document['archivist']>;
  /** Fields written into the document as given, over the settings: for the cases that check what is refused. */
  verbatim?: Record<string, unknown>;
}

export interface GatewayEnvironment {
  JWT_SECRET?: string;
  SEMIONT_OIDC_CLIENT_ID?: string;
  SEMIONT_OIDC_CLIENT_SECRET?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  [name: string]: string | undefined;
}

/**
 * Renders the settings as the gateway's configuration document
 * (`GatewayConfig` in the spec) at `~/.semiontconfig`. A setting a case
 * deleted is absent from the document.
 */
function writeConfiguration(dir: string, s: GatewaySettings): void {
  const { verbatim, ...fields } = s;
  writeFileSync(join(dir, '.semiontconfig'), JSON.stringify({ ...fields, ...verbatim }, null, 2) + '\n');
}

/**
 * The suite sets nothing a gateway does not read: every variable it passes is
 * listed in specs/src/gateway-environment/variables.json or named by the
 * document, except PATH, which finds the gateway's command.
 */
function checkEnvironment(env: GatewayEnvironment, settings: GatewaySettings): void {
  const named = [settings.signal.userEnv, settings.signal.passwordEnv].filter((n): n is string => n !== undefined);
  const listed = new Set([...gatewayEnvironment(), ...named, 'PATH']);
  const unlisted = Object.keys(env).filter((name) => env[name] !== undefined && !listed.has(name));
  if (unlisted.length > 0) {
    throw new Error(`the suite set ${unlisted.join(', ')}, which specs/src/gateway-environment/variables.json does not list and the document does not name`);
  }
}

export interface GatewayProcess {
  readonly origin: string;
  readonly port: number;
  readonly settings: GatewaySettings;
  /** Every complete line the gateway wrote, stdout and stderr interleaved. */
  readonly output: string[];
  /** The complete lines it wrote to stdout, where its logs go. */
  readonly stdout: string[];
  /** Resolves with the exit code once the process has exited. */
  readonly exited: Promise<number | null>;
  /** Milliseconds from spawning it to its first `/api/health` 200. */
  readonly servedAfterMs: number;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  settings: GatewaySettings;
  env: GatewayEnvironment;
}

/** Appends each complete line of a stream to every list in `into`; a line split across chunks is kept whole. */
function collectLines(stream: NodeJS.ReadableStream, into: string[][]): void {
  let partial = '';
  const push = (line: string) => {
    if (line) for (const list of into) list.push(line);
  };
  stream.on('data', (chunk: Buffer) => {
    const parts = (partial + chunk.toString('utf8')).split('\n');
    partial = parts.pop() ?? '';
    parts.forEach(push);
  });
  stream.on('end', () => push(partial));
}

function launch({ settings, env }: LaunchOptions): { child: ChildProcess; output: string[]; stdout: string[]; exited: Promise<number | null>; dir: string } {
  checkEnvironment(env, settings);
  const dir = mkdtempSync(join(tmpdir(), 'gateway-conformance-home-'));
  writeConfiguration(dir, settings);
  const childEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: dir };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  const [command, ...args] = inject('gatewayCommand');
  const child = spawn(command!, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  const stdout: string[] = [];
  collectLines(child.stdout!, [output, stdout]);
  collectLines(child.stderr!, [output]);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output, stdout, exited, dir };
}

/** The settings a gateway runs with when a case says nothing else. */
export async function defaultSettings(parts: {
  kb: { name: string; domain: string };
  issuer: string;
  archivist: { host: string; port: number };
  plane: Plane;
  natsUrl?: string;
}): Promise<GatewaySettings> {
  const port = await freePort();
  return {
    kb: { ...parts.kb },
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    identity: { issuer: parts.issuer, subjectClaim: 'sub' },
    archivist: { ...parts.archivist },
    signal: parts.plane === 'nats' ? { type: 'nats', servers: parts.natsUrl! } : { type: 'in-process' },
    logLevel: 'warn',
    logFormat: 'json',
  };
}

/** Start a gateway and wait until it answers. Fails with its output when it exits instead. */
export async function startGateway(options: LaunchOptions): Promise<GatewayProcess> {
  const spawned = Date.now();
  const { child, output, stdout, exited, dir } = launch(options);
  const origin = `http://127.0.0.1:${options.settings.port}`;
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (gone) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`the gateway exited before serving (code ${child.exitCode}):\n${output.join('\n')}`);
    }
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the gateway did not serve within 30 s:\n${output.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const servedAfterMs = Date.now() - spawned;
  return {
    origin,
    port: options.settings.port,
    settings: options.settings,
    output,
    stdout,
    exited,
    servedAfterMs,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        await exited;
        clearTimeout(timer);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Start a gateway that must refuse: it exits, non-zero, without ever
 * answering on its port. Returns its exit code and output.
 */
export async function refusedBoot(options: LaunchOptions, timeoutMs = 30_000): Promise<{ code: number | null; output: string }> {
  const { child, output, exited, dir } = launch(options);
  const origin = `http://127.0.0.1:${options.settings.port}`;
  let served = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  let done = false;
  void exited.then(() => {
    done = true;
  });
  while (!done) {
    try {
      await fetch(`${origin}/api/health`);
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
  if (served) throw new Error(`the gateway served although it should have refused to start:\n${output.join('\n')}`);
  return { code, output: output.join('\n') };
}
