/**
 * Starting and stopping gateway processes.
 *
 * A gateway is `GATEWAY_COMMAND`, a configuration document and an
 * environment. What the configuration says is modelled here once
 * (`GatewaySettings`); `writeConfiguration` renders it into the file the
 * gateway reads, and a case that needs a broken configuration edits the
 * settings, never the rendering.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATEWAY_COMMAND } from './paths';
import { freePort } from './net';

export type Plane = 'in-process' | 'nats';

/** Everything a gateway is configured with. */
export interface GatewaySettings {
  kb: { name?: string; domain?: string };
  port: number;
  publicUrl: string;
  identity: { issuer?: string; subjectClaim?: string };
  archivist: { host?: string; port?: number };
  signal: { type: 'in-process' } | { type: 'nats'; servers?: string; userEnv?: string; passwordEnv?: string };
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  /** Fields the document does not declare, for the case that checks they are refused. */
  undeclared?: Record<string, unknown>;
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
  const document = {
    kb: { ...s.kb },
    port: s.port,
    publicUrl: s.publicUrl,
    identity: { ...s.identity },
    archivist: { ...s.archivist },
    signal: s.signal,
    logLevel: s.logLevel,
    ...s.undeclared,
  };
  writeFileSync(join(dir, '.semiontconfig'), JSON.stringify(document, null, 2) + '\n');
}

export interface GatewayProcess {
  readonly origin: string;
  readonly port: number;
  readonly settings: GatewaySettings;
  readonly output: string[];
  /** Resolves with the exit code once the process has exited. */
  readonly exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  settings: GatewaySettings;
  env: GatewayEnvironment;
}

function launch({ settings, env }: LaunchOptions): { child: ChildProcess; output: string[]; exited: Promise<number | null>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-conformance-home-'));
  writeConfiguration(dir, settings);
  const childEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: dir };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  const [command, ...args] = GATEWAY_COMMAND;
  const child = spawn(command!, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  const collect = (chunk: Buffer) => output.push(...chunk.toString('utf8').split('\n').filter(Boolean));
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output, exited, dir };
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
  };
}

/** Start a gateway and wait until it answers. Fails with its output when it exits instead. */
export async function startGateway(options: LaunchOptions): Promise<GatewayProcess> {
  const { child, output, exited, dir } = launch(options);
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
  return {
    origin,
    port: options.settings.port,
    settings: options.settings,
    output,
    exited,
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
