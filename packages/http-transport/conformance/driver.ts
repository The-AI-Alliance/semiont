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
} from '@semiont/core';
import { HttpContentTransport, HttpTransport } from '@semiont/http-transport';

type Arguments = Record<string, unknown>;

/** The suite sent something this driver cannot act on: the suite's mistake, never the SDK's. */
class Misuse extends Error {}

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

function opened(): HttpTransport {
  if (!transport) throw new Misuse('no transport is open');
  return transport;
}

function contentTransport(): HttpContentTransport {
  content ??= new HttpContentTransport(opened());
  return content;
}

const operations: Record<string, (args: Arguments) => Promise<unknown> | unknown> = {
  open(args) {
    if (transport) throw new Misuse('a transport is already open');
    const timing = args['timing'] === undefined ? {} : object(args, 'timing');
    for (const name of Object.keys(timing)) {
      if (name !== 'reconnectMs' && name !== 'lazyRemoveMs') throw new Misuse(`this driver cannot override ${name}`);
    }
    token$ = new BehaviorSubject<AccessToken | null>(accessToken(text(args, 'token')));
    transport = new HttpTransport({
      baseUrl: baseUrl(text(args, 'baseUrl')),
      token$,
      channels: texts(args, 'channels') as (keyof EventMap)[],
      ...(timing['reconnectMs'] === undefined ? {} : { reconnectMs: count(timing, 'reconnectMs') }),
      ...(timing['lazyRemoveMs'] === undefined ? {} : { lazyRemoveMs: count(timing, 'lazyRemoveMs') }),
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
      { ...(correlationId === undefined ? {} : { correlationId }), ...(scope === undefined ? {} : { scope }) },
    );
    return subscribers === undefined ? {} : { subscribers };
  },

  async request(args) {
    const response: unknown = await busRequest(opened(), text(args, 'operation') as BusOperationKey, object(args, 'payload'), count(args, 'timeoutMs'));
    return response === undefined ? {} : { response };
  },

  async put(args) {
    const request: PutBinaryRequest = {
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
    return contentTransport().putBinary(request);
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
};

async function run(line: string): Promise<void> {
  const { id, op, ...args } = JSON.parse(line) as { id: number; op: string } & Arguments;
  const operation = operations[op];
  if (!operation) {
    say({ id, unsupported: true });
    return;
  }
  try {
    const value: unknown = await operation(args);
    say({ id, ok: value === undefined ? null : value });
  } catch (error) {
    if (error instanceof Misuse) say({ id, misuse: error.message });
    else say({ id, error: failure(error) });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => void run(line));
lines.on('close', () => {
  transport?.dispose();
  process.exit(0);
});
say({ ready: true });
