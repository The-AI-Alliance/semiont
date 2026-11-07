import { Observable } from 'rxjs';
import { CACHE_REFRESH, CACHE_REFRESH_CHANNELS, FrameRefusal, INVALIDATION_WINDOW_MS, faultOf, isAnnotationId, isObject, isResourceId } from '@semiont/core';
import type {
  Annotation,
  AnnotationId,
  CacheQuery,
  CacheRefresh,
  CacheRefreshChannel,
  CacheRefreshTrigger,
  CacheRefreshWay,
  CacheRefreshWhen,
  EventBus,
  ITransport,
  ResourceId,
} from '@semiont/core';

/**
 * B19 — per key, the first invalidation runs at once and opens a window; any
 * more inside it are owed, and run as one when it closes, which opens the next.
 */
class InvalidationWindows {
  private readonly open = new Map<string, { owed: (() => void) | null; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly windowMs: number) {}

  run(key: string, invalidate: () => void): void {
    const window = this.open.get(key);
    if (window) {
      window.owed = invalidate;
      return;
    }
    invalidate();
    const timer = setTimeout(() => {
      const owed = this.open.get(key)?.owed;
      this.open.delete(key);
      if (owed) this.run(key, owed);
    }, this.windowMs);
    this.open.set(key, { owed: null, timer });
  }

  /** B16: an owed invalidation dies with its namespace. */
  dispose(): void {
    for (const { timer } of this.open.values()) clearTimeout(timer);
    this.open.clear();
  }
}

/** What a trigger names: which of a split channel's rows it is, the keys a `subject` reach acts on, and the value an enriched event carries. */
export interface RefreshSubject {
  when?: CacheRefreshWhen;
  resource?: ResourceId;
  annotation?: AnnotationId;
  written?: Annotation;
}

/** An event a member of which a row names is present and is not what it names. */
class Unreadable extends Error {}

/**
 * The member `way` ends at in `event`, as `is` reads it: none where the way
 * is absent or a member on it is absent or null. A member on it that is
 * present and is no object, or the one it ends at that is not what `is`
 * reads, makes the event `Unreadable`.
 */
function memberAt<T>(event: unknown, way: CacheRefreshWay | undefined, is: (value: unknown) => value is T): T | undefined {
  if (way === undefined) return undefined;
  let member = event;
  for (const name of way) {
    if (member === null || member === undefined) return undefined;
    if (!isObject(member)) throw new Unreadable();
    member = member[name];
  }
  if (member === null || member === undefined) return undefined;
  if (!is(member)) throw new Unreadable();
  return member;
}

const isResource = (value: unknown): value is ResourceId => typeof value === 'string' && isResourceId(value);
const isAnnotationIdentifier = (value: unknown): value is AnnotationId => typeof value === 'string' && isAnnotationId(value);
const isAnnotation = (value: unknown): value is Annotation => faultOf('Annotation', value) === undefined;

/**
 * What an event on `channel` names, read by the ways of its row
 * (protocol/specs/src/client/refresh.json); none, when the event is
 * unreadable. A split channel's event is enriched when the member its
 * enriched row carries is present: read there as what it carries, so one
 * present and not an Annotation is unreadable either way.
 */
function subjectOf(channel: CacheRefreshChannel, event: unknown): RefreshSubject | undefined {
  const rows: readonly CacheRefresh[] = CACHE_REFRESH[channel];
  const enriched = rows.find((row) => row.when === 'enriched');
  try {
    const row = enriched === undefined ? rows[0] : memberAt(event, enriched.carries, isAnnotation) === undefined ? rows.find((other) => other.when === 'unenriched') : enriched;
    if (!row) throw new Error(`The refresh table has no row for ${channel}`);
    const resource = memberAt(event, row.names.resource, isResource);
    const annotation = memberAt(event, row.names.annotation, isAnnotationIdentifier);
    const written = memberAt(event, row.carries, isAnnotation);
    return {
      ...(row.when === undefined ? {} : { when: row.when }),
      ...(resource === undefined ? {} : { resource }),
      ...(annotation === undefined ? {} : { annotation }),
      ...(written === undefined ? {} : { written }),
    };
  } catch (error) {
    if (error instanceof Unreadable) return undefined;
    throw error;
  }
}

/** What a namespace does to one of its live queries when the table says to. */
export interface QueryActs {
  /** B7: ask again, for the keys the row reaches, keeping what is shown meanwhile. */
  refetch(subject: RefreshSubject, reach: CacheRefresh['reach']): void;
  /** B13b: the event carries the value. Absent where no event does. */
  write?(subject: RefreshSubject): void;
  /** B13a: the event says the entity is gone. Absent where no event does. */
  remove?(subject: RefreshSubject): void;
}

/**
 * Applies protocol/specs/src/client/refresh.json to the live queries one namespace
 * holds: what each event on the bus, and the reopening of a dropped stream,
 * does to them.
 *
 * A namespace builds one over the queries `Q` it answers. A row's other
 * queries are another namespace's, and that namespace's own refresher acts
 * on them; `client.ts` holds the namespaces to answering every query of the
 * table between them.
 */
export class CacheRefresher<Q extends CacheQuery> {
  private readonly subs: Array<{ unsubscribe(): void }> = [];
  private readonly windows: InvalidationWindows;

  constructor(
    transport: Pick<ITransport, 'state$'>,
    private readonly bus: EventBus,
    private readonly acts: Record<Q, QueryActs>,
    /** B19's window; absent, `invalidationWindowMs` of protocol/specs/src/client/timing.json. */
    windowMs: number = INVALIDATION_WINDOW_MS,
  ) {
    this.windows = new InvalidationWindows(windowMs);

    for (const channel of CACHE_REFRESH_CHANNELS) this.refreshOn(channel);

    // B13: `reopened`. The stream is `open` again having left it, which only
    // a drop does: a subscription that changes is handed over, and the state
    // stays `open` across it. Events with a position are replayed from where
    // the client left off, or `bus:resume-gap` says they could not be; the
    // rest were lost while the stream was down, and the row asks again for
    // what they feed.
    let opened = false;
    let left = false;
    this.subs.push(
      transport.state$.subscribe((state) => {
        if (state !== 'open') {
          left = opened;
          return;
        }
        if (left) this.refresh('reopened');
        opened = true;
        left = false;
      }),
    );
  }

  /**
   * Run `invalidate` through `window` (B19), and only for a key the cache
   * knows (B20): an event about a key nothing has asked for has nothing to
   * refresh, and refreshing it anyway costs every viewer a request per
   * resource another principal imports.
   */
  held<K>(cache: { known(key: K): boolean }, key: K, window: string, invalidate: () => void): void {
    if (cache.known(key)) this.windows.run(window, invalidate);
  }

  /** Run `invalidate` through `window` (B19), whatever the cache holds. */
  windowed(window: string, invalidate: () => void): void {
    this.windows.run(window, invalidate);
  }

  /** B16: detach from the bus, and drop what is owed. Idempotent. */
  dispose(): void {
    for (const sub of this.subs) sub.unsubscribe();
    this.subs.length = 0;
    this.windows.dispose();
  }

  private answers(query: CacheQuery): query is Q {
    return Object.hasOwn(this.acts, query);
  }

  /** Apply the table's row for `trigger` to what `subject` names. */
  private refresh(trigger: CacheRefreshTrigger, subject: RefreshSubject = {}): void {
    const rows: readonly CacheRefresh[] = CACHE_REFRESH[trigger];
    const row = rows.find((candidate) => candidate.when === subject.when);
    if (!row) throw new Error(`The refresh table has no row for ${trigger}${subject.when ? ` (${subject.when})` : ''}`);
    for (const query of row.writes) {
      if (!this.answers(query)) continue;
      const write = this.acts[query].write;
      if (!write) throw new Error(`The refresh table writes ${query}, which no event carries a value for`);
      write(subject);
    }
    for (const query of row.removes) {
      if (!this.answers(query)) continue;
      const remove = this.acts[query].remove;
      if (!remove) throw new Error(`The refresh table removes ${query}, which no event reports gone`);
      remove(subject);
    }
    for (const query of row.refetches) {
      if (this.answers(query)) this.acts[query].refetch(subject, row.reach);
    }
  }

  /** Subscribe `channel`'s rows of the refresh table to its events. */
  private refreshOn(channel: CacheRefreshChannel): void {
    this.subs.push(
      this.bus.on(channel).subscribe((event) => {
        const subject = event instanceof FrameRefusal ? undefined : subjectOf(channel, event);
        // An event that cannot be read: something changed and nothing says what.
        if (subject === undefined) this.refresh('unreadable');
        else this.refresh(channel, subject);
      }),
    );
  }
}

/**
 * Wraps a resource-scoped live query's source so that *subscribing* acquires
 * the resource's scope (the transport's ref-counted `subscribeToResource`)
 * and the last unsubscribe releases it. Freshness follows observation: a
 * `.subscribe()` keeps the resource's scoped events flowing, so the
 * invalidations they carry reach the cache, with no separate
 * `subscribeToResource` call from the consumer.
 *
 * A one-shot read does not come through here (it resolves through the
 * cache's `fetch`), so it acquires no scope.
 *
 * Memoized per source, so the wrapped observable is stable per key (B4/B11).
 * Each subscription calls `subscribeToResource`; the transport ref-counts
 * per resource, and DISTINCT resources COMPOSE onto the one stream's
 * subscription matrix. Acquisition cannot fail.
 */
export class ScopedSources {
  private readonly scoped = new WeakMap<Observable<unknown>, Observable<unknown>>();

  constructor(private readonly transport: Pick<ITransport, 'subscribeToResource'>) {}

  of<S>(resourceId: ResourceId, source: Observable<S>): Observable<S> {
    let scoped = this.scoped.get(source) as Observable<S> | undefined;
    if (!scoped) {
      scoped = new Observable<S>((subscriber) => {
        const release = this.transport.subscribeToResource(resourceId);
        const inner = source.subscribe(subscriber);
        return () => {
          inner.unsubscribe();
          release();
        };
      });
      this.scoped.set(source, scoped);
    }
    return scoped;
  }
}
