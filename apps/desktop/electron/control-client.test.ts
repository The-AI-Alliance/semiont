import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isObject } from '@semiont/core';
import {
  ControlClient,
  ControlRequestError,
  SHUTDOWN_GRACE_MS,
  type LauncherChild,
} from './control-client';
import { CONTROL_API_VERSION, type ControlAboutResult } from './control-types.gen';
import type { ControlFailure, ControlNotice } from '../src/lib/launcher-bridge';

/** `semiont control` as the client meets it: stdio streams, and an exit the test decides. */
class FakeLauncher extends EventEmitter implements LauncherChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Each message the client wrote, as it reads. */
  readonly received: Record<string, unknown>[] = [];
  readonly killedWith: NodeJS.Signals[] = [];
  private unread = '';

  /** `exitsWhenStdinEnds`: whether it exits once the client ends its requests, as the
   *  launcher does, or must be killed. */
  constructor(exitsWhenStdinEnds: boolean) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => this.take(chunk));
    this.stdin.on('end', () => {
      if (exitsWhenStdinEnds) this.exit(0, null);
    });
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killedWith.push(signal);
    this.exit(null, signal);
    return true;
  }

  /** Write `message` as one line of its stdout. */
  say(message: object): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('close', code, signal);
  }

  private take(chunk: string): void {
    const text = this.unread + chunk;
    const end = text.lastIndexOf('\n');
    if (end < 0) {
      this.unread = text;
      return;
    }
    for (const line of text.slice(0, end).split('\n')) {
      const message: unknown = JSON.parse(line);
      if (!isObject(message)) throw new Error('the client wrote a line that is not a JSON object');
      this.received.push(message);
    }
    this.unread = text.slice(end + 1);
  }
}

const ABOUT: ControlAboutResult = {
  development: true,
  apiVersions: [CONTROL_API_VERSION],
  imageRegistry: 'ghcr.io/the-ai-alliance',
  runtimes: [{ name: 'docker', found: true }],
};

/** How a fake launcher meets the end of its stdin: it exits, as the launcher does, or it
 *  lingers until it is killed. */
type Ending = 'exits' | 'lingers';

function setUp(ending: Ending) {
  const launchers: FakeLauncher[] = [];
  const logged: string[] = [];
  const client = new ControlClient(
    () => {
      const launcher = new FakeLauncher(ending === 'exits');
      launchers.push(launcher);
      return launcher;
    },
    (line) => logged.push(line),
  );
  return { client, launchers, logged };
}

function only(launchers: FakeLauncher[]): FakeLauncher {
  expect(launchers).toHaveLength(1);
  const [launcher] = launchers;
  if (launcher === undefined) throw new Error('no launcher was started');
  return launcher;
}

/** The `index`th message the client wrote to `launcher`, once it has. */
async function written(launcher: FakeLauncher, index: number): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(launcher.received.length).toBeGreaterThan(index));
  const message = launcher.received[index];
  if (message === undefined) throw new Error(`the client wrote no message ${index}`);
  return message;
}

async function requestId(launcher: FakeLauncher, index: number): Promise<number> {
  const id = (await written(launcher, index))['id'];
  if (typeof id !== 'number') throw new Error(`message ${index} is no request`);
  return id;
}

/** Why `answer` rejects. Called as soon as the request is made, so the rejection is never
 *  unhandled while the test waits for it. */
async function failureOf(answer: Promise<unknown>): Promise<ControlFailure> {
  const error = await answer.then(
    () => {
      throw new Error('the request was answered with a result');
    },
    (rejected: unknown) => rejected,
  );
  if (!(error instanceof ControlRequestError)) throw error;
  return error.failure;
}

const ignore = (_notice: ControlNotice): void => {};

afterEach(() => {
  vi.useRealTimers();
});

describe('ControlClient', () => {
  it('sends a request with its apiVersion and a fresh integer id', async () => {
    const { client, launchers } = setUp('exits');
    const failed = failureOf(client.request('launcher.about', {}, ignore).answer);
    const launcher = only(launchers);
    expect(await written(launcher, 0)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'launcher.about',
      params: { apiVersion: CONTROL_API_VERSION },
    });
    await client.close();
    expect((await failed).kind).toBe('exited');
  });

  it('reads a message split across chunks', async () => {
    const { client, launchers } = setUp('exits');
    const call = client.request('launcher.about', {}, ignore);
    const launcher = only(launchers);
    const line = JSON.stringify({ jsonrpc: '2.0', id: await requestId(launcher, 0), result: ABOUT });
    launcher.stdout.write(line.slice(0, 12));
    launcher.stdout.write(line.slice(12, 40));
    launcher.stdout.write(`${line.slice(40)}\n`);
    await expect(call.answer).resolves.toEqual(ABOUT);
    await client.close();
  });

  it('reads two messages in one chunk', async () => {
    const { client, launchers } = setUp('exits');
    const first = client.request('launcher.about', {}, ignore);
    const second = client.request('roots.list', {}, ignore);
    const launcher = only(launchers);
    const firstId = await requestId(launcher, 0);
    const secondId = await requestId(launcher, 1);
    launcher.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: firstId, result: ABOUT })}\n`
      + `${JSON.stringify({ jsonrpc: '2.0', id: secondId, result: { roots: [] } })}\n`,
    );
    await expect(first.answer).resolves.toEqual(ABOUT);
    await expect(second.answer).resolves.toEqual({ roots: [] });
    await client.close();
  });

  it('gives each answer to the request of its id, whatever order they come in', async () => {
    const { client, launchers } = setUp('exits');
    const about = client.request('launcher.about', {}, ignore);
    const roots = client.request('roots.list', {}, ignore);
    const launcher = only(launchers);
    const aboutId = await requestId(launcher, 0);
    const rootsId = await requestId(launcher, 1);
    expect(aboutId).not.toBe(rootsId);
    launcher.say({ jsonrpc: '2.0', id: rootsId, result: { roots: [] } });
    launcher.say({ jsonrpc: '2.0', id: aboutId, result: ABOUT });
    await expect(roots.answer).resolves.toEqual({ roots: [] });
    await expect(about.answer).resolves.toEqual(ABOUT);
    await client.close();
  });

  it('routes each progress notification to the request it names', async () => {
    const { client, launchers } = setUp('exits');
    const heardByStart: ControlNotice[] = [];
    const heardByStop: ControlNotice[] = [];
    const start = client.request('stack.start', { dryRun: true }, (notice) => heardByStart.push(notice));
    const stop = client.request('stack.stop', {}, (notice) => heardByStop.push(notice));
    const startFailed = failureOf(start.answer);
    const stopFailed = failureOf(stop.answer);
    const launcher = only(launchers);
    const startId = await requestId(launcher, 0);
    const stopId = await requestId(launcher, 1);
    launcher.say({ jsonrpc: '2.0', method: 'notifications/progress', params: { requestId: stopId, kind: 'log', text: 'stopping' } });
    launcher.say({ jsonrpc: '2.0', method: 'notifications/progress', params: { requestId: startId, kind: 'command', text: 'docker run' } });
    await vi.waitFor(() => expect(heardByStart).toHaveLength(1));
    await vi.waitFor(() => expect(heardByStop).toHaveLength(1));
    expect(heardByStart).toEqual([
      { method: 'notifications/progress', params: { requestId: startId, kind: 'command', text: 'docker run' } },
    ]);
    expect(heardByStop).toEqual([
      { method: 'notifications/progress', params: { requestId: stopId, kind: 'log', text: 'stopping' } },
    ]);
    await client.close();
    expect((await startFailed).kind).toBe('exited');
    expect((await stopFailed).kind).toBe('exited');
  });

  it('sends notifications/cancelled for a request it gives up, and hands on the answer', async () => {
    const { client, launchers } = setUp('exits');
    const call = client.request('logs.follow', { service: 'gateway' }, ignore);
    const failed = failureOf(call.answer);
    const launcher = only(launchers);
    const id = await requestId(launcher, 0);
    call.cancel('the person closed the log');
    expect(await written(launcher, 1)).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: id, reason: 'the person closed the log' },
    });
    launcher.say({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: 'cancelled', data: { code: 'control.cancelled', retryable: false } },
    });
    expect(await failed).toEqual({
      kind: 'answered',
      code: -32000,
      message: 'cancelled',
      data: { code: 'control.cancelled', retryable: false },
    });
    await client.close();
  });

  it('rejects a result that does not hold to its schema', async () => {
    const { client, launchers } = setUp('exits');
    const failed = failureOf(client.request('launcher.about', {}, ignore).answer);
    const launcher = only(launchers);
    launcher.say({ jsonrpc: '2.0', id: await requestId(launcher, 0), result: { ...ABOUT, development: 'yes' } });
    const failure = await failed;
    expect(failure.kind).toBe('mismatch');
    if (failure.kind !== 'mismatch') return;
    expect(failure.faults.map(({ field }) => field)).toEqual(['/development']);
    await client.close();
  });

  it('refuses params that do not hold to their schema, and sends nothing', async () => {
    const { client, launchers } = setUp('exits');
    const failure = await failureOf(client.request('settings.set', { name: 'runtime', value: '' }, ignore).answer);
    expect(failure.kind).toBe('refused');
    if (failure.kind !== 'refused') return;
    expect(failure.code).toBe(-32602);
    expect(failure.data.code).toBe('control.invalid-params');
    expect(failure.data.fields?.map(({ field }) => field)).toEqual(['/value']);
    expect(launchers).toHaveLength(0);
  });

  it('rejects every request in flight when the launcher exits, and starts another for the next', async () => {
    const { client, launchers, logged } = setUp('exits');
    const first = failureOf(client.request('launcher.about', {}, ignore).answer);
    const second = failureOf(client.request('roots.list', {}, ignore).answer);
    const launcher = only(launchers);
    await requestId(launcher, 1);
    launcher.exit(2, null);
    expect(await first).toEqual({ kind: 'exited', message: 'the launcher exited with code 2' });
    expect(await second).toEqual({ kind: 'exited', message: 'the launcher exited with code 2' });
    expect(logged).toContain('control: the launcher exited with code 2');

    const third = client.request('launcher.about', {}, ignore);
    expect(launchers).toHaveLength(2);
    const [, next] = launchers;
    if (next === undefined) throw new Error('no second launcher was started');
    next.say({ jsonrpc: '2.0', id: await requestId(next, 0), result: ABOUT });
    await expect(third.answer).resolves.toEqual(ABOUT);
    await client.close();
  });

  it('gives up every request in flight when the stream breaks the protocol', async () => {
    const { client, launchers } = setUp('exits');
    const failed = failureOf(client.request('launcher.about', {}, ignore).answer);
    const launcher = only(launchers);
    await requestId(launcher, 0);
    launcher.stdout.write('this is not JSON\n');
    expect((await failed).kind).toBe('protocol');
    expect(launcher.stdin.writableEnded).toBe(true);
  });

  it('hands each line the launcher writes to its stderr to the log', async () => {
    const { client, launchers, logged } = setUp('exits');
    const failed = failureOf(client.request('launcher.about', {}, ignore).answer);
    const launcher = only(launchers);
    launcher.stderr.write('reading the ');
    launcher.stderr.write('catalog\nstarting\n');
    await vi.waitFor(() => expect(logged).toEqual(['reading the catalog', 'starting']));
    await client.close();
    expect((await failed).kind).toBe('exited');
  });

  it('close() cancels what is in flight, then ends the launcher\'s stdin', async () => {
    const { client, launchers } = setUp('exits');
    const failed = failureOf(client.request('stack.start', {}, ignore).answer);
    const launcher = only(launchers);
    const id = await requestId(launcher, 0);
    const closed = client.close();
    expect(launcher.stdin.writableEnded).toBe(true);
    expect(await written(launcher, 1)).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: id, reason: 'Desktop is quitting' },
    });
    await closed;
    expect(launcher.killedWith).toEqual([]);
    expect((await failed).kind).toBe('exited');
  });

  it('close() kills a launcher that does not exit within the grace period', async () => {
    const { client, launchers } = setUp('lingers');
    const call = client.request('launcher.about', {}, ignore);
    const launcher = only(launchers);
    launcher.say({ jsonrpc: '2.0', id: await requestId(launcher, 0), result: ABOUT });
    await expect(call.answer).resolves.toEqual(ABOUT);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closed = client.close();
    expect(launcher.stdin.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1);
    expect(launcher.killedWith).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await closed;
    expect(launcher.killedWith).toEqual(['SIGKILL']);
  });

  it('sends nothing once closed', async () => {
    const { client, launchers } = setUp('exits');
    await client.close();
    expect((await failureOf(client.request('launcher.about', {}, ignore).answer)).kind).toBe('closed');
    expect(launchers).toHaveLength(0);
  });
});
