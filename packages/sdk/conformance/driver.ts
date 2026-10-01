/**
 * The TypeScript live driver for the SDK conformance suite
 * (tests/conformance/sdk): the client, its live queries and their cache,
 * driven one operation per line on stdin, reporting each observer's states on
 * stdout. tests/conformance/sdk/README.md is the protocol.
 *
 * It reaches the SDK only as an application does, through what `@semiont/sdk`
 * and `@semiont/core` export. Node runs this file as it is (types stripped);
 * `npm run typecheck:conformance` is its type check.
 */
import { createInterface } from 'node:readline';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { SemiontError, accessToken, annotationId, baseUrl, resourceId, type AccessToken } from '@semiont/core';
import {
  HttpContentTransport,
  HttpTransport,
  InMemorySessionStorage,
  SemiontClient,
  type CacheObservable,
  type CacheState,
} from '@semiont/sdk';

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

/** A failure as the protocol carries it: the SDK's code, and the status when a server stated one. */
function failure(error: unknown): { code?: string; status?: number; detail: string } {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (!(error instanceof SemiontError)) return { detail };
  const status = (error as { status?: unknown }).status;
  return { code: error.code, ...(typeof status === 'number' && status > 0 ? { status } : {}), detail };
}

/** What a cache persists to, kept across `close` and the next `open`: a reload, to the client. */
const storage = new InMemorySessionStorage();
/** The client, kept once closed: what a closed client does is part of what the suite asks. */
let client: SemiontClient | undefined;
let closed = false;
/** Each observer's subscription, by the name the suite gave it. */
const observers = new Map<string, Subscription>();

function opened(): SemiontClient {
  if (!client) throw new Misuse('no client is open');
  return client;
}

/** The live query a case names. */
function live(query: Arguments): CacheObservable<unknown> {
  const { browse } = opened();
  const resource = () => resourceId(text(query, 'resource'));
  switch (text(query, 'query')) {
    case 'resource':
      return browse.resource(resource());
    case 'annotations':
      return browse.annotations(resource());
    case 'annotation':
      return browse.annotation(resource(), annotationId(text(query, 'annotation')));
    case 'events':
      return browse.events(resource());
    case 'referencedBy':
      return browse.referencedBy(resource());
    case 'resources':
      return browse.resources(query['filters'] === undefined ? undefined : object(query, 'filters'));
    case 'entityTypes':
      return browse.entityTypes();
    case 'tagSchemas':
      return browse.tagSchemas();
    default:
      throw new Misuse(`no live query ${String(query['query'])}`);
  }
}

const state = (s: CacheState<unknown>): Record<string, unknown> =>
  s.status === 'failed' ? { status: 'failed', error: failure(s.error) } : s;

const operations: Record<string, (args: Arguments) => Promise<unknown> | unknown> = {
  open(args) {
    if (client && !closed) throw new Misuse('a client is already open');
    const timing = args['timing'] === undefined ? {} : object(args, 'timing');
    const known = ['busRequestTimeoutMs', 'invalidationWindowMs', 'reconnectMs', 'lazyRemoveMs', 'lingerMs'];
    for (const name of Object.keys(timing)) if (!known.includes(name)) throw new Misuse(`this driver cannot override ${name}`);
    const override = (name: string) => (timing[name] === undefined ? undefined : count(timing, name));
    const reconnectMs = override('reconnectMs');
    const lazyRemoveMs = override('lazyRemoveMs');
    const lingerMs = override('lingerMs');
    const busTimeoutMs = override('busRequestTimeoutMs');
    const invalidationWindowMs = override('invalidationWindowMs');

    const transport = new HttpTransport({
      baseUrl: baseUrl(text(args, 'baseUrl')),
      token$: new BehaviorSubject<AccessToken | null>(accessToken(text(args, 'token'))),
      ...(reconnectMs === undefined ? {} : { reconnectMs }),
      ...(lazyRemoveMs === undefined ? {} : { lazyRemoveMs }),
      ...(lingerMs === undefined ? {} : { lingerMs }),
    });
    client = new SemiontClient(transport, new HttpContentTransport(transport), transport, {
      ...(busTimeoutMs === undefined ? {} : { busTimeoutMs }),
      ...(invalidationWindowMs === undefined ? {} : { invalidationWindowMs }),
      ...(args['persist'] === true ? { cachePersistence: { storage, keyPrefix: 'conformance' } } : {}),
    });
    closed = false;
    observers.clear();
    client.state$.subscribe((s) => say({ state: s }));
    transport.errors$.subscribe((error) => say({ error: failure(error) }));
  },

  close() {
    opened().dispose();
    closed = true;
  },

  observe(args) {
    const observer = text(args, 'observer');
    if (observers.has(observer)) throw new Misuse(`${observer} is already observing`);
    observers.set(
      observer,
      live(object(args, 'query')).subscribe({
        next: (s) => say({ emission: { observer, state: state(s) } }),
        complete: () => say({ completed: observer }),
      }),
    );
  },

  unobserve(args) {
    const observer = text(args, 'observer');
    const subscription = observers.get(observer);
    if (!subscription) throw new Misuse(`${observer} is not observing`);
    subscription.unsubscribe();
    observers.delete(observer);
  },

  async fresh(args) {
    return { value: await live(object(args, 'query')).fresh() };
  },

  invalidate(args) {
    const { browse } = opened();
    const query = object(args, 'query');
    const resource = () => resourceId(text(query, 'resource'));
    switch (text(query, 'query')) {
      case 'resource':
        return browse.invalidateResourceDetail(resource());
      case 'annotations':
        return browse.invalidateAnnotationList(resource());
      case 'events':
        return browse.invalidateResourceEvents(resource());
      case 'referencedBy':
        return browse.invalidateReferencedBy(resource());
      case 'resources':
        return browse.invalidateResourceLists();
      case 'entityTypes':
        return browse.invalidateEntityTypes();
      case 'tagSchemas':
        return browse.invalidateTagSchemas();
      default:
        throw new Misuse(`${String(query['query'])} cannot be invalidated`);
    }
  },

  // Answers after everything the client reported before it: the suite's way
  // to know it has read every state an observer was in.
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
  client?.dispose();
  process.exit(0);
});
say({ ready: true });
