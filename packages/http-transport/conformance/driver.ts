/**
 * The TypeScript wire driver for the SDK conformance suite
 * (tests/conformance/sdk). The suite starts it, sends it one operation per
 * line on stdin and reads what it did, and what it saw, one line at a time
 * from stdout; tests/conformance/sdk/README.md is the protocol.
 *
 * It reaches the transport only as an application does, through what
 * `@semiont/http-transport` and `@semiont/core` export, so what the suite
 * observes is what a caller of the SDK gets. Node runs this file as it is
 * (types stripped); `npm run typecheck:conformance` is its type check.
 */
import { createInterface } from 'node:readline';
import { BehaviorSubject } from 'rxjs';
import {
  SemiontError,
  accessToken,
  baseUrl,
  busRequest,
  resourceId,
  type AccessToken,
  type BusOperationKey,
  type ContentFormat,
  type EventMap,
  type PutBinaryRequest,
  type RetryPolicy,
} from '@semiont/core';
import { HttpContentTransport, HttpTransport } from '@semiont/http-transport';
import { initObservabilityNode, shutdownObservabilityNode } from '@semiont/observability/node';

type Arguments = Record<string, unknown>;

/** The suite sent something this driver cannot act on: the suite's mistake, never the SDK's. */
class Misuse extends Error {}

/** The request settled because the suite abandoned it, and the SDK reported nothing else. */
class Abandoned extends Error {}

const say = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

function text(args: Arguments, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') throw new Misuse(`${name} must be a string`);
  return value;
}

function optionalText(args: Arguments, name: string): string | undefined {
  return args[name] === undefined ? undefined : text(args, name);
}

function count(args: Arguments, name: string): number {
  const value = args[name];
  if (typeof value !== 'number') throw new Misuse(`${name} must be a number`);
  return value;
}

function object(args: Arguments, name: string): Arguments {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Misuse(`${name} must be an object`);
  return value as Arguments;
}

function texts(args: Arguments, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) throw new Misuse(`${name} must be a list of strings`);
  return value;
}

/** A failure as the protocol carries it: the SDK's code, and the status when a server stated one. */
function failure(error: unknown): { code?: string; status?: number; detail: string } {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (!(error instanceof SemiontError)) return { detail };
  const status = (error as { status?: unknown }).status;
  return { code: error.code, ...(typeof status === 'number' && status > 0 ? { status } : {}), detail };
}

let token$: BehaviorSubject<AccessToken | null> | undefined;
let transport: HttpTransport | undefined;
let content: HttpContentTransport | undefined;
/** The disposers `subscribe-resource` got, per resource, newest last. */
const held = new Map<string, Array<() => void>>();
/** What abandons each request or upload still unsettled, by the id of its operation. */
const callers = new Map<number, AbortController>();

function opened(): HttpTransport {
  if (!transport) throw new Misuse('no transport is open');
  return transport;
}

function contentTransport(): HttpContentTransport {
  content ??= new HttpContentTransport(opened());
  return content;
}

/** The upload `put` and `upload` are asked for. */
function uploadOf(args: Arguments): PutBinaryRequest {
  return {
    name: text(args, 'name'),
    format: text(args, 'format') as ContentFormat,
    storageUri: text(args, 'storageUri'),
    file: Buffer.from(text(args, 'bytes'), 'base64'),
    ...(args['entityTypes'] === undefined ? {} : { entityTypes: texts(args, 'entityTypes') }),
    ...(args['language'] === undefined ? {} : { language: text(args, 'language') }),
    ...(args['sourceResourceId'] === undefined ? {} : { sourceResourceId: text(args, 'sourceResourceId') }),
    ...(args['sourceAnnotationId'] === undefined ? {} : { sourceAnnotationId: text(args, 'sourceAnnotationId') }),
    ...(args['generationPrompt'] === undefined ? {} : { generationPrompt: text(args, 'generationPrompt') }),
    ...(args['jobId'] === undefined ? {} : { jobId: text(args, 'jobId') }),
    ...(args['isDraft'] === undefined ? {} : { isDraft: args['isDraft'] === true }),
  };
}

function budget(timing: Arguments): RetryPolicy {
  const stated = object(timing, 'emitRetry');
  return { attempts: count(stated, 'attempts'), initialDelayMs: count(stated, 'initialDelayMs'), maxDelayMs: count(stated, 'maxDelayMs') };
}

const operations: Record<string, (args: Arguments, id: number) => Promise<unknown> | unknown> = {
  open(args) {
    if (transport) throw new Misuse('a transport is already open');
    const timing = args['timing'] === undefined ? {} : object(args, 'timing');
    for (const name of Object.keys(timing)) {
      if (!['reconnectMs', 'lazyRemoveMs', 'lingerMs', 'emitRetry', 'seenEventIdsCount'].includes(name)) throw new Misuse(`this driver cannot override ${name}`);
    }
    token$ = new BehaviorSubject<AccessToken | null>(accessToken(text(args, 'token')));
    transport = new HttpTransport({
      baseUrl: baseUrl(text(args, 'baseUrl')),
      token$,
      channels: texts(args, 'channels') as (keyof EventMap)[],
      ...(timing['reconnectMs'] === undefined ? {} : { reconnectMs: count(timing, 'reconnectMs') }),
      ...(timing['lazyRemoveMs'] === undefined ? {} : { lazyRemoveMs: count(timing, 'lazyRemoveMs') }),
      ...(timing['lingerMs'] === undefined ? {} : { lingerMs: count(timing, 'lingerMs') }),
      ...(timing['emitRetry'] === undefined ? {} : { emitRetry: budget(timing) }),
      ...(timing['seenEventIdsCount'] === undefined ? {} : { seenEventIdsCount: count(timing, 'seenEventIdsCount') }),
    });
    transport.state$.subscribe((state) => say({ state }));
    transport.errors$.subscribe((error) => say({ error: failure(error) }));
  },

  close() {
    opened().dispose();
  },

  'set-token'(args) {
    opened();
    token$!.next(accessToken(text(args, 'token')));
  },

  listen(args) {
    const channel = text(args, 'channel');
    opened()
      .frames(channel as keyof EventMap)
      .subscribe((frame) =>
        say({
          frame: {
            channel,
            payload: frame.payload,
            ...(frame.correlationId === undefined ? {} : { correlationId: frame.correlationId }),
            ...(frame.scope === undefined ? {} : { scope: frame.scope }),
          },
        }),
      );
  },

  'subscribe-resource'(args) {
    const resource = text(args, 'resource');
    const release = opened().subscribeToResource(resourceId(resource));
    held.set(resource, [...(held.get(resource) ?? []), release]);
  },

  'release-resource'(args) {
    const resource = text(args, 'resource');
    const release = held.get(resource)?.pop();
    if (!release) throw new Misuse(`nothing holds ${resource}`);
    release();
  },

  async emit(args) {
    const correlationId = optionalText(args, 'correlationId');
    const scope = optionalText(args, 'scope');
    const subscribers = await opened().emit(
      text(args, 'channel') as keyof EventMap,
      object(args, 'payload') as EventMap[keyof EventMap],
      { ...(correlationId === undefined ? {} : { correlationId }), ...(scope === undefined ? {} : { scope: resourceId(scope) }) },
    );
    return subscribers === undefined ? {} : { subscribers };
  },

  async request(args, id) {
    const caller = new AbortController();
    callers.set(id, caller);
    try {
      const response: unknown = await busRequest(opened(), text(args, 'operation') as BusOperationKey, object(args, 'payload'), count(args, 'timeoutMs'), caller.signal);
      return response === undefined ? {} : { response };
    } catch (error) {
      if (caller.signal.aborted && error === caller.signal.reason) throw new Abandoned();
      throw error;
    } finally {
      callers.delete(id);
    }
  },

  abandon(args) {
    const caller = callers.get(count(args, 'request'));
    if (!caller) throw new Misuse('no such request is unsettled');
    caller.abort();
  },

  put(args) {
    return contentTransport().putBinary(uploadOf(args));
  },

  async upload(args, id) {
    const caller = new AbortController();
    callers.set(id, caller);
    try {
      return await contentTransport().putBinary(uploadOf(args), {
        signal: caller.signal,
        onProgress: ({ bytesUploaded, totalBytes }) => say({ progress: { upload: id, bytesUploaded, totalBytes } }),
      });
    } catch (error) {
      if (caller.signal.aborted && error === caller.signal.reason) throw new Abandoned();
      throw error;
    } finally {
      callers.delete(id);
    }
  },

  async get(args) {
    const { data, contentType } = await contentTransport().getBinary(resourceId(text(args, 'resource')));
    return { contentType, bytes: Buffer.from(data).toString('base64') };
  },

  async 'get-stream'(args) {
    const { stream, contentType } = await contentTransport().getBinaryStream(resourceId(text(args, 'resource')));
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return { contentType, bytes: Buffer.concat(chunks).toString('base64') };
  },

  graph(args) {
    return contentTransport().getResourceGraph(resourceId(text(args, 'resource')));
  },

  health() {
    return opened().healthCheck();
  },

  status() {
    return opened().getStatus();
  },

  'current-user'() {
    return opened().getCurrentUser();
  },

  'media-token'(args) {
    return opened().getMediaToken(resourceId(text(args, 'resource')));
  },

  'protected-resource-metadata'() {
    return opened().getProtectedResourceMetadata();
  },

  // Answers after everything the transport reported before it: the suite's
  // way to know it has read every state the connection was in.
  sync() {},
};

async function run(line: string): Promise<void> {
  const { id, op, ...args } = JSON.parse(line) as { id: number; op: string } & Arguments;
  const operation = operations[op];
  if (!operation) {
    say({ id, unsupported: true });
    return;
  }
  try {
    const value: unknown = await operation(args, id);
    say({ id, ok: value === undefined ? null : value });
  } catch (error) {
    if (error instanceof Misuse) say({ id, misuse: error.message });
    else if (error instanceof Abandoned) say({ id, abandoned: true });
    else say({ id, error: failure(error) });
  }
}

// Exports only when the suite names an OTLP endpoint in the environment.
initObservabilityNode({ serviceName: 'semiont-conformance-driver' });

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => void run(line));
lines.on('close', () => {
  transport?.dispose();
  // Whatever it had not exported yet goes out before it exits.
  void shutdownObservabilityNode().finally(() => process.exit(0));
});
say({ ready: true });
