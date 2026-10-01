/**
 * The suite's end of the driver protocol (README.md § The driver protocol): it
 * starts an SDK's driver, sends it operations, and keeps what the driver says
 * it did and saw — each operation's outcome, the states its transport passed
 * through, the frames it delivered, the failures its error stream carried and
 * the progress its uploads reported.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** A frame the SDK delivered to its caller. */
export interface DeliveredFrame {
  payload: unknown;
  correlationId?: string;
  scope?: string;
}

/** A failure as an SDK reports it: its code, and the status when a server stated one. */
export interface ReportedFailure {
  code?: string;
  status?: number;
}

/** How much of an upload a client says it has sent. */
export interface ReportedProgress {
  bytesUploaded: number;
  totalBytes: number;
}

/** A state a live query's observer was in, as the protocol carries it. */
export type ObservedState =
  | { status: 'pending' }
  | { status: 'ready'; value: unknown }
  | { status: 'failed'; error: ReportedFailure; detail: string };

export type Outcome = { ok: unknown } | { error: ReportedFailure; detail: string } | { abandoned: true } | { unsupported: true } | { misuse: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function failureOf(v: unknown): { failure: ReportedFailure; detail: string } | undefined {
  if (!isObject(v) || typeof v['detail'] !== 'string') return undefined;
  const { code, status, detail, ...rest } = v;
  if (Object.keys(rest).length > 0) return undefined;
  if (code !== undefined && typeof code !== 'string') return undefined;
  if (status !== undefined && typeof status !== 'number') return undefined;
  return { failure: { ...(code === undefined ? {} : { code }), ...(status === undefined ? {} : { status }) }, detail };
}

function stateOf(v: unknown): ObservedState | undefined {
  if (!isObject(v)) return undefined;
  const keys = Object.keys(v);
  if (v['status'] === 'pending' && keys.length === 1) return { status: 'pending' };
  if (v['status'] === 'ready' && keys.length === 2 && 'value' in v) return { status: 'ready', value: v['value'] };
  const failed = failureOf(v['error']);
  if (v['status'] === 'failed' && keys.length === 2 && failed) return { status: 'failed', error: failed.failure, detail: failed.detail };
  return undefined;
}

export class Driver {
  /** Every state the transport reported, in order. */
  readonly states: string[] = [];
  /** The frames delivered on each channel the case listens to, in order. */
  readonly frames = new Map<string, DeliveredFrame[]>();
  /** What the error stream carried, in order, each with the SDK's own words for it. */
  readonly failures: Array<{ failure: ReportedFailure; detail: string }> = [];
  /** The states each observer of a live query reported, in order. */
  readonly emissions = new Map<string, ObservedState[]>();
  /** The observers whose live query completed. */
  readonly completed = new Set<string>();
  /** The progress each upload reported, by the id of its operation, in order. */
  readonly progress = new Map<number, ReportedProgress[]>();
  /** Lines the driver wrote that the protocol does not allow. */
  readonly violations: string[] = [];
  /** What it wrote to stderr: shown when a case fails. */
  readonly stderr: string[] = [];
  private readonly outcomes = new Map<number, Outcome>();
  private waiters: Array<() => void> = [];
  private nextId = 1;
  private exit: number | null | undefined;

  private constructor(private readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      this.read(line);
      this.wake();
    });
    createInterface({ input: child.stderr! }).on('line', (line) => this.stderr.push(line));
    child.once('exit', (code) => {
      this.exit = code;
      this.wake();
    });
  }

  /** Start `command`, with `env` beside the PATH that finds it, and wait for it to say it is ready. */
  static async start(command: readonly string[], env: Record<string, string> = {}): Promise<Driver> {
    const [program, ...args] = command;
    const child = spawn(program!, args, { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const driver = new Driver(child);
    await driver.until('the driver to be ready', () => (driver.ready ? true : undefined), 30_000);
    return driver;
  }

  private ready = false;

  private read(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.violations.push(`a line that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (!isObject(message)) {
      this.violations.push(`a line that is not an object: ${line.slice(0, 200)}`);
      return;
    }
    const keys = Object.keys(message);
    if (keys.length === 1 && message['ready'] === true) {
      this.ready = true;
    } else if (keys.length === 1 && typeof message['state'] === 'string') {
      this.states.push(message['state']);
    } else if (keys.length === 1 && isObject(message['frame']) && typeof message['frame']['channel'] === 'string') {
      const { channel, payload, correlationId, scope, ...rest } = message['frame'];
      if (Object.keys(rest).length > 0 || (correlationId !== undefined && typeof correlationId !== 'string') || (scope !== undefined && typeof scope !== 'string')) {
        this.violations.push(`a frame the protocol does not allow: ${line.slice(0, 200)}`);
        return;
      }
      const delivered = this.frames.get(channel) ?? [];
      this.frames.set(channel, delivered);
      delivered.push({ payload, ...(correlationId === undefined ? {} : { correlationId }), ...(scope === undefined ? {} : { scope }) });
    } else if (keys.length === 1 && failureOf(message['error'])) {
      this.failures.push(failureOf(message['error'])!);
    } else if (keys.length === 1 && isObject(message['progress']) && typeof message['progress']['upload'] === 'number') {
      const { upload, bytesUploaded, totalBytes, ...rest } = message['progress'];
      if (Object.keys(rest).length > 0 || typeof bytesUploaded !== 'number' || typeof totalBytes !== 'number') {
        this.violations.push(`a progress report the protocol does not allow: ${line.slice(0, 200)}`);
        return;
      }
      this.progress.set(upload, [...(this.progress.get(upload) ?? []), { bytesUploaded, totalBytes }]);
    } else if (keys.length === 1 && typeof message['completed'] === 'string') {
      this.completed.add(message['completed']);
    } else if (keys.length === 1 && isObject(message['emission']) && typeof message['emission']['observer'] === 'string') {
      const state = stateOf(message['emission']['state']);
      if (!state || Object.keys(message['emission']).length !== 2) {
        this.violations.push(`an emission the protocol does not allow: ${line.slice(0, 200)}`);
        return;
      }
      const observer = message['emission']['observer'];
      this.emissions.set(observer, [...(this.emissions.get(observer) ?? []), state]);
    } else if (keys.length === 2 && typeof message['id'] === 'number') {
      const outcome = Driver.outcomeOf(message);
      if (!outcome) this.violations.push(`a line the protocol does not allow: ${line.slice(0, 200)}`);
      else if (this.outcomes.has(message['id'])) this.violations.push(`operation ${message['id']} settled twice: ${line.slice(0, 200)}`);
      else this.outcomes.set(message['id'], outcome);
    } else {
      this.violations.push(`a line the protocol does not allow: ${line.slice(0, 200)}`);
    }
  }

  private static outcomeOf(message: Record<string, unknown>): Outcome | undefined {
    if ('ok' in message) return { ok: message['ok'] };
    const failed = failureOf(message['error']);
    if (failed) return { error: failed.failure, detail: failed.detail };
    if (message['abandoned'] === true) return { abandoned: true };
    if (message['unsupported'] === true) return { unsupported: true };
    if (typeof message['misuse'] === 'string') return { misuse: message['misuse'] };
    return undefined;
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }

  /** Send an operation; its outcome arrives later, under the id returned. */
  send(op: string, args: Record<string, unknown>): number {
    const id = this.nextId++;
    this.child.stdin!.write(`${JSON.stringify({ id, op, ...args })}\n`);
    return id;
  }

  /** How an operation settled, if it has. */
  settled(id: number): Outcome | undefined {
    return this.outcomes.get(id);
  }

  outcome(id: number, what: string, timeoutMs: number): Promise<Outcome> {
    return this.until(what, () => this.outcomes.get(id), timeoutMs);
  }

  /** Resolves with what `probe` returns once that is not undefined; asked again whenever the driver says anything. Fails if the driver exits first. */
  async until<T>(what: string, probe: () => T | undefined, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = probe();
      if (found !== undefined) return found;
      if (this.exit !== undefined) throw new Error(`the driver exited (code ${this.exit}) before ${what}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** End the driver's input, which is its instruction to dispose and exit, and wait until it has. */
  async stop(): Promise<number | null> {
    if (this.exit === undefined) {
      this.child.stdin!.end();
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
      while (this.exit === undefined) {
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
      }
      clearTimeout(timer);
    }
    return this.exit;
  }
}
