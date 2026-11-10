import type { Readable, Writable } from 'node:stream';
import { isObject } from '@semiont/core';
import { ControlSchemas, describeFaults, isLauncherNotification } from './control-schemas';
import {
  CONTROL_API_VERSION,
  CONTROL_ERROR_DATA_SCHEMA,
  CONTROL_METHOD_SCHEMAS,
  CONTROL_NOTIFICATION_SCHEMAS,
  type ControlCancelled,
  type ControlClientNotifications,
  type ControlErrorData,
  type ControlFieldFault,
  type ControlMethod,
  type ControlMethods,
} from './control-types.gen';
import type { ControlFailure, ControlNotice, ControlRequestParams } from '../src/lib/launcher-bridge';

// Desktop's client of the launcher's control API: one long-lived `semiont control` child,
// JSON-RPC 2.0 a line at a time on its stdin and stdout (protocol/contract/LAUNCHER-CONTROL.md).
// Its stderr is the launcher's diagnostics, handed to Desktop's log as they are.

/** How long a closing client waits for the launcher to answer what it cancelled and exit
 *  before killing it: a cancelled operation is answered at once, so a launcher still running
 *  past this is stuck, and quitting must not hang on it. */
export const SHUTDOWN_GRACE_MS = 5_000;

/** JSON-RPC's code for refused params, which the launcher refuses them with. */
const INVALID_PARAMS = -32602;

const CANCELLED: keyof ControlClientNotifications = 'notifications/cancelled';

/** `semiont control` as the client drives it: a child process with its stdio piped. */
export interface LauncherChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** A control request sent to the launcher. */
export interface ControlCall<M extends ControlMethod> {
  /** Its result. Rejects with a ControlRequestError. */
  readonly answer: Promise<ControlMethods[M]['result']>;
  /** Give up on it: the launcher answers it with control.cancelled, unless it has answered
   *  it already. */
  cancel(reason: string): void;
}

/** Why a control request has no result. */
export class ControlRequestError extends Error {
  constructor(readonly failure: ControlFailure) {
    super(failure.message);
    this.name = 'ControlRequestError';
  }
}

/** A line of the launcher's stdout, read as a JSON-RPC message. */
type Incoming =
  | { kind: 'unreadable'; why: string }
  | { kind: 'result'; id: number; result: unknown }
  /** `data` is undefined when the error states none. */
  | { kind: 'error'; id: number; code: number; message: string; data: unknown }
  /** An error under a null id: the launcher could not read a line Desktop sent it. */
  | { kind: 'refusedLine'; message: string }
  | { kind: 'notification'; method: string; params: unknown };

type Answer = Extract<Incoming, { kind: 'result' | 'error' }>;

/** A request the launcher has not answered. */
interface InFlight {
  readonly notified: (notice: ControlNotice) => void;
  readonly answered: (answer: Answer) => void;
  readonly failed: (failure: ControlFailure) => void;
  /** Whether its answer is settled: by the launcher's answer, or by the client giving it up
   *  ahead of that answer, which is then dropped. */
  settled: boolean;
  cancelSent: boolean;
}

/** One `semiont control` child, and what the client knows of its stream. */
interface Connection {
  readonly child: LauncherChild;
  readonly inFlight: Map<number, InFlight>;
  /** stdout read past its last complete line. */
  unreadOutput: string;
  unreadDiagnostics: string;
  /** Whether its stdout is read: not once it broke the protocol. */
  reading: boolean;
  /** Set once its stdin is ended: it exits, or is killed. */
  retiring: Promise<void> | null;
  gone: boolean;
  readonly exit: PromiseWithResolvers<void>;
}

const RESPONSE_MEMBERS = new Set(['jsonrpc', 'id', 'result', 'error']);
const NOTIFICATION_MEMBERS = new Set(['jsonrpc', 'method', 'params']);
const ERROR_MEMBERS = new Set(['code', 'message', 'data']);

export class ControlClient {
  private readonly schemas: ControlSchemas = new ControlSchemas();
  private connection: Connection | null = null;
  private nextId = 1;
  private closing: Promise<void> | null = null;

  /** `spawnLauncher` starts `semiont control`, when the first request needs it and after it
   *  exits; `log` takes each line the launcher writes to its stderr, and what the client has
   *  to say of the launcher. */
  constructor(
    private readonly spawnLauncher: () => LauncherChild,
    private readonly log: (line: string) => void,
  ) {}

  /** Send `method` with `params` and this client's apiVersion, once they hold to the
   *  method's params schema; refused, nothing is sent. `notified` hears each notification
   *  the launcher sends about the request before its answer. */
  request<M extends ControlMethod>(
    method: M,
    params: ControlRequestParams<M>,
    notified: (notice: ControlNotice) => void,
  ): ControlCall<M> {
    if (this.closing !== null) {
      return givenUp({ kind: 'closed', message: `Desktop's launcher client is closed, and did not send ${method}` });
    }
    const stamped = { ...params, apiVersion: CONTROL_API_VERSION };
    const refusal = this.schemas.refuseParams(method, stamped);
    if (refusal !== null) {
      return givenUp({ kind: 'refused', code: INVALID_PARAMS, message: refusal.message, data: refusal.data });
    }
    const connection = this.connected();
    const id = this.nextId++;
    const answer = Promise.withResolvers<ControlMethods[M]['result']>();
    connection.inFlight.set(id, {
      notified,
      settled: false,
      cancelSent: false,
      answered: (reply) => {
        if (reply.kind === 'error') {
          answer.reject(new ControlRequestError(this.answeredFailure(reply)));
          return;
        }
        const schema = CONTROL_METHOD_SCHEMAS[method].result;
        const checked = this.schemas.check<ControlMethods[M]['result']>(schema, reply.result);
        if (checked.holds) answer.resolve(checked.value);
        else answer.reject(new ControlRequestError(mismatch(`${method}'s result`, schema, checked.faults)));
      },
      failed: (failure) => answer.reject(new ControlRequestError(failure)),
    });
    this.send(connection, { jsonrpc: '2.0', id, method, params: stamped });
    return { answer: answer.promise, cancel: (reason) => this.cancel(connection, id, reason) };
  }

  /** Cancel every request in flight, end the launcher's stdin, and wait for it to exit; past
   *  SHUTDOWN_GRACE_MS it is killed. Nothing is sent after. */
  close(): Promise<void> {
    if (this.closing === null) this.closing = this.shutDown();
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    const connection = this.connection;
    if (connection === null) return;
    for (const id of connection.inFlight.keys()) this.cancel(connection, id, 'Desktop is quitting');
    await this.retire(connection);
  }

  private connected(): Connection {
    if (this.connection !== null) return this.connection;
    const child = this.spawnLauncher();
    const connection: Connection = {
      child,
      inFlight: new Map(),
      unreadOutput: '',
      unreadDiagnostics: '',
      reading: true,
      retiring: null,
      gone: false,
      exit: Promise.withResolvers<void>(),
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(connection, chunk));
    child.stderr.on('data', (chunk: string) => this.diagnose(connection, chunk));
    child.stdout.on('error', (error: Error) => this.abandon(connection, `its output could not be read: ${error.message}`));
    child.stderr.on('error', (error: Error) => this.log(`control: the launcher's diagnostics could not be read: ${error.message}`));
    child.stdin.on('error', (error: Error) => this.log(`control: writing to the launcher failed: ${error.message}`));
    child.on('close', (code, signal) => this.gone(connection, exitDescription(code, signal)));
    child.on('error', (error) => this.gone(connection, `the launcher could not be run: ${error.message}`));
    this.connection = connection;
    return connection;
  }

  private send(connection: Connection, message: object): void {
    connection.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private cancel(connection: Connection, id: number, reason: string): void {
    const request = connection.inFlight.get(id);
    if (request === undefined || request.settled) return;
    this.sendCancel(connection, id, request, reason);
  }

  private sendCancel(connection: Connection, id: number, request: InFlight, reason: string): void {
    if (request.cancelSent || connection.retiring !== null || connection.gone) return;
    request.cancelSent = true;
    const cancelled: ControlCancelled = { requestId: id, reason };
    this.send(connection, { jsonrpc: '2.0', method: CANCELLED, params: cancelled });
  }

  private read(connection: Connection, chunk: string): void {
    const { lines, rest } = completeLines(connection.unreadOutput + chunk);
    connection.unreadOutput = rest;
    for (const line of lines) {
      if (!connection.reading) return;
      this.receive(connection, line);
    }
  }

  private diagnose(connection: Connection, chunk: string): void {
    const { lines, rest } = completeLines(connection.unreadDiagnostics + chunk);
    connection.unreadDiagnostics = rest;
    for (const line of lines) this.log(line);
  }

  private receive(connection: Connection, line: string): void {
    const message = readMessage(line);
    switch (message.kind) {
      case 'unreadable':
        this.abandon(connection, message.why);
        return;
      case 'refusedLine':
        this.abandon(connection, `the launcher could not read a line Desktop sent it: ${message.message}`);
        return;
      case 'result':
      case 'error':
        this.answered(connection, message);
        return;
      case 'notification':
        this.notified(connection, message);
        return;
    }
  }

  private answered(connection: Connection, answer: Answer): void {
    const request = connection.inFlight.get(answer.id);
    if (request === undefined) {
      this.abandon(connection, `the launcher answered request ${answer.id}, which is not in flight`);
      return;
    }
    connection.inFlight.delete(answer.id);
    if (request.settled) return;
    request.settled = true;
    request.answered(answer);
  }

  private notified(connection: Connection, { method, params }: Extract<Incoming, { kind: 'notification' }>): void {
    if (!isLauncherNotification(method)) {
      this.abandon(connection, `the launcher sent ${method}, which is no notification it sends in this API`);
      return;
    }
    const requestId = isObject(params) ? params['requestId'] : undefined;
    if (typeof requestId !== 'number' || !this.issued(requestId)) {
      this.abandon(connection, `a ${method} names no request Desktop sent`);
      return;
    }
    const request = connection.inFlight.get(requestId);
    // The launcher may still narrate a request it has just answered: control.go's notify reads
    // `answered` before it writes.
    if (request === undefined || request.settled) return;
    const notice = this.schemas.notice(method, params);
    if (notice.holds) {
      request.notified(notice.value);
      return;
    }
    request.settled = true;
    request.failed(mismatch(`a ${method}`, CONTROL_NOTIFICATION_SCHEMAS[method], notice.faults));
    this.sendCancel(connection, requestId, request, `its ${method} does not hold to its schema`);
  }

  private issued(id: number): boolean {
    return Number.isInteger(id) && id >= 1 && id < this.nextId;
  }

  private answeredFailure(answer: Extract<Answer, { kind: 'error' }>): ControlFailure {
    if (answer.data === undefined) return { kind: 'answered', code: answer.code, message: answer.message };
    const checked = this.schemas.check<ControlErrorData>(CONTROL_ERROR_DATA_SCHEMA, answer.data);
    if (!checked.holds) return mismatch(`the error data of "${answer.message}"`, CONTROL_ERROR_DATA_SCHEMA, checked.faults);
    return { kind: 'answered', code: answer.code, message: answer.message, data: checked.value };
  }

  /** The stream broke the protocol, and nothing more on it can be trusted: every request in
   *  flight is given up and the launcher let go. The next request starts another. */
  private abandon(connection: Connection, why: string): void {
    if (!connection.reading) return;
    connection.reading = false;
    const message = `the launcher's control stream broke the protocol: ${why}`;
    this.log(`control: ${message}`);
    this.settleAll(connection, { kind: 'protocol', message });
    this.detach(connection);
    void this.retire(connection);
  }

  private gone(connection: Connection, why: string): void {
    if (connection.gone) return;
    connection.gone = true;
    if (connection.unreadDiagnostics !== '') this.log(connection.unreadDiagnostics);
    if (connection.reading && connection.unreadOutput !== '') this.log("control: the launcher's output ended inside a message");
    if (connection.retiring === null) this.log(`control: ${why}`);
    this.settleAll(connection, { kind: 'exited', message: why });
    this.detach(connection);
    connection.exit.resolve();
  }

  private detach(connection: Connection): void {
    if (this.connection === connection) this.connection = null;
  }

  private settleAll(connection: Connection, failure: ControlFailure): void {
    for (const request of connection.inFlight.values()) {
      if (request.settled) continue;
      request.settled = true;
      request.failed(failure);
    }
    connection.inFlight.clear();
  }

  /** End the launcher's stdin, which it takes as the end of its requests; past
   *  SHUTDOWN_GRACE_MS, kill it. */
  private retire(connection: Connection): Promise<void> {
    if (connection.retiring !== null) return connection.retiring;
    connection.child.stdin.end();
    connection.retiring = new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        if (!connection.gone) {
          this.settleAll(connection, {
            kind: 'closed',
            message: `the launcher did not exit within ${SHUTDOWN_GRACE_MS} ms of Desktop ending its requests, and was killed`,
          });
          connection.child.kill('SIGKILL');
        }
        resolve();
      }, SHUTDOWN_GRACE_MS);
      void connection.exit.promise.then(() => {
        clearTimeout(kill);
        resolve();
      });
    });
    return connection.retiring;
  }
}

/** A request given up before it was sent. */
function givenUp<M extends ControlMethod>(failure: ControlFailure): ControlCall<M> {
  return {
    answer: Promise.reject(new ControlRequestError(failure)),
    cancel: () => {},
  };
}

function mismatch(what: string, schema: string, faults: ControlFieldFault[]): ControlFailure {
  return { kind: 'mismatch', schema, faults, message: `${what} does not hold to ${schema}: ${describeFaults(faults)}` };
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `the launcher was stopped by ${signal}`;
  if (code !== null) return `the launcher exited with code ${code}`;
  return 'the launcher exited';
}

function completeLines(text: string): { lines: string[]; rest: string } {
  const end = text.lastIndexOf('\n');
  if (end < 0) return { lines: [], rest: text };
  return { lines: text.slice(0, end).split('\n'), rest: text.slice(end + 1) };
}

/** A line of the launcher's stdout as a JSON-RPC 2.0 message. What is unreadable is described,
 *  never quoted: a line may carry a sign-in code, which goes nowhere but to the person. */
function readMessage(line: string): Incoming {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: 'unreadable', why: 'a line is not JSON' };
  }
  if (!isObject(value) || value['jsonrpc'] !== '2.0') {
    return { kind: 'unreadable', why: 'a line is not a JSON-RPC 2.0 message' };
  }
  const members = Object.keys(value);
  if ('method' in value) {
    const method = value['method'];
    if (typeof method !== 'string' || members.some((member) => !NOTIFICATION_MEMBERS.has(member))) {
      return { kind: 'unreadable', why: 'a message with a method is no notification' };
    }
    return { kind: 'notification', method, params: value['params'] };
  }
  const id = value['id'];
  const hasResult = 'result' in value;
  if (members.some((member) => !RESPONSE_MEMBERS.has(member)) || hasResult === ('error' in value)) {
    return { kind: 'unreadable', why: 'an answer carries other than one of result and error' };
  }
  if (hasResult) {
    if (typeof id !== 'number' || !Number.isInteger(id)) return { kind: 'unreadable', why: "a result's id is no integer" };
    return { kind: 'result', id, result: value['result'] };
  }
  if (id !== null && (typeof id !== 'number' || !Number.isInteger(id))) {
    return { kind: 'unreadable', why: "an error's id is neither an integer nor null" };
  }
  const error = value['error'];
  if (!isObject(error) || Object.keys(error).some((member) => !ERROR_MEMBERS.has(member))) {
    return { kind: 'unreadable', why: 'an error is no JSON-RPC error object' };
  }
  const code = error['code'];
  const message = error['message'];
  if (typeof code !== 'number' || !Number.isInteger(code) || typeof message !== 'string') {
    return { kind: 'unreadable', why: 'an error states no integer code and message' };
  }
  if (id === null) return { kind: 'refusedLine', message };
  return { kind: 'error', id, code, message, data: error['data'] };
}
