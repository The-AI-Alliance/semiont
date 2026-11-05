/**
 * The vector index, read and changed by the suite's own calls: Qdrant, over
 * its REST interface, by plain `fetch`. The index's writer is what the suite
 * judges, so nothing here is a Smelter's code, or the code a Smelter shares
 * with the index's readers.
 *
 * What the index is, protocol/specs/src/vectors/payload-cases.json states: for
 * each knowledge base, two collections that are searched, one of resources'
 * chunks and one of annotations, and the declined beside them, with what a
 * point's payload holds. The collections' words are read from that table, and
 * so is every payload member a point is found by here; a rename there fails
 * here. A knowledge base's collection is named as the table says, by the
 * SHA-256 of its DID, a hyphen and the collection's word, and kb-index.test.ts
 * holds the names made here to the table's `collectionsNamed` cases. A
 * point's id is never worked out: a chunk's point is found by the resource its
 * payload names, and an annotation's by the annotation.
 *
 * A collection that is not there holds no point: an index that was cleared,
 * and that no Smelter has connected to since, reads as empty.
 *
 * The Qdrant is run with an API key and its JWT access control on, as the
 * launcher runs one. Every request the suite makes presents the key, and
 * each service the suite starts is handed a token, minted here from the key,
 * whose claims are what protocol/specs/src/vectors/token-cases.json states:
 * the Smelter's may do anything, and the Librarian's reads its knowledge
 * base's collections alone. kb-index.test.ts holds the tokens minted here to
 * the table's cases.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_SOURCE } from './paths';

/** The port Qdrant's REST interface answers on. */
export const QDRANT_PORT = 6333;

/** A Qdrant the suite is given: where it is, and the API key it was started with. */
export interface VectorDatabase {
  host: string;
  key: string;
}

/** The variable the settings of a Smelter and of a Librarian name for the token each presents to the index, as the launcher names it. */
export const VECTORS_TOKEN = 'QDRANT_TOKEN';

/** A knowledge base's collections, by their words: the two that are searched, and the declined. */
export type Collection = 'resources' | 'annotations' | 'declined';

/** A point of the index: its id, its payload whole, and its vector where one was asked for. */
export interface Point {
  id: string | number;
  payload: Record<string, unknown>;
  vector?: number[];
}

/** One knowledge base's index in a Qdrant. */
export interface VectorIndex {
  /** Every point of a collection, with its payload, and with its vector when asked. */
  points(collection: Collection, vectors?: boolean): Promise<Point[]>;
  /**
   * The points of one resource in a collection: of the resources, its chunks
   * in the chunks' order; of the annotations, the annotations on it.
   */
  pointsOf(collection: Collection, resourceId: string, vectors?: boolean): Promise<Point[]>;
  /** The point of one annotation; undefined when it has none. */
  annotationPoint(annotationId: string, vectors?: boolean): Promise<Point | undefined>;
  /** How many points a collection holds. */
  count(collection: Collection): Promise<number>;
  /** Take one point out of a collection, by its id. */
  deletePoint(collection: Collection, id: Point['id']): Promise<void>;
  /** Take a resource's points out of a collection. */
  deletePointsOf(collection: Collection, resourceId: string): Promise<void>;
  /** Make a collection that is not there, `size` numbers wide and compared as the table states, as a store makes one. */
  make(collection: Collection, size: number): Promise<void>;
  /** Put points into a collection, each with its vector. */
  put(collection: Collection, points: readonly Point[]): Promise<void>;
  /** Clear the database: every collection of every knowledge base gone, as a wiped volume leaves it. */
  clear(): Promise<void>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ── What the table states ──────────────────────────────────────────────────

const TABLE = 'vectors/payload-cases.json';
const table: unknown = JSON.parse(readFileSync(join(SPEC_SOURCE, TABLE), 'utf8'));

/** What the table states of a collection, under its word. */
function stated(collection: Collection): Record<string, unknown> {
  const one = isObject(table) && isObject(table['collections']) ? table['collections'][collection] : undefined;
  if (!isObject(one)) throw new Error(`protocol/specs/src/${TABLE} states no collection of ${collection}`);
  return one;
}

/** What a collection's vectors are compared by, in Qdrant's word for it, as the table states. */
function distanceOf(collection: Collection): string {
  const distance = stated(collection)['distance'];
  if (typeof distance !== 'string') throw new Error(`protocol/specs/src/${TABLE} states no distance of the ${collection}`);
  return distance;
}

/** The words of every collection the table states a knowledge base's index has. */
function words(): string[] {
  const all = isObject(table) && isObject(table['collections']) ? Object.keys(table['collections']) : [];
  if (all.length === 0) throw new Error(`protocol/specs/src/${TABLE} states no collections of an index`);
  return all;
}

/**
 * The names of the collections of the knowledge base whose DID is `kb`, by
 * their words: the SHA-256 of the DID's UTF-8 bytes in lower-case hex, a
 * hyphen and the word.
 */
export function collectionNames(kb: string): Record<string, string> {
  const hashed = createHash('sha256').update(kb, 'utf8').digest('hex');
  return Object.fromEntries(words().map((word) => [word, `${hashed}-${word}`]));
}

// ── The tokens ─────────────────────────────────────────────────────────────

/** The services that present a token to the index, by the token table's names for them. */
export type Holder = 'smelter' | 'librarian';

/** What a token says its holder may do: global manage, or a read of each collection it names. */
export interface Claims {
  access: 'm' | Array<{ collection: string; access: 'r' }>;
}

/**
 * The claims of each service's token for the knowledge base whose DID is
 * `kb`: the Smelter's, global manage, since Qdrant makes and deletes a
 * collection for nothing less; and the Librarian's, a read of each of that
 * knowledge base's collections, in the payload table's order.
 */
export function claimsFor(kb: string): Record<Holder, Claims> {
  return {
    smelter: { access: 'm' },
    librarian: { access: Object.values(collectionNames(kb)).map((collection) => ({ collection, access: 'r' })) },
  };
}

/** A token for the Qdrant whose API key is `key`: a JSON Web Token of `claims` and no others, signed by HS256 with the key's UTF-8 bytes. */
export function minted(key: string, claims: Claims): string {
  const signed = [{ alg: 'HS256', typ: 'JWT' }, claims].map((part) => Buffer.from(JSON.stringify(part), 'utf8').toString('base64url')).join('.');
  return `${signed}.${createHmac('sha256', Buffer.from(key, 'utf8')).update(signed).digest('base64url')}`;
}

/** The payloads the table states for the points of a collection. */
function statedPayloads(collection: Collection): Record<string, unknown>[] {
  const cases = isObject(table) && Array.isArray(table['cases']) ? table['cases'] : [];
  return cases.flatMap((one): unknown[] => {
    if (!isObject(one)) return [];
    if (collection === 'declined') {
      const stored = one['declineStored'];
      return isObject(stored) && isObject(stored['point']) ? [stored['point']['payload']] : [];
    }
    if (collection === 'annotations') {
      const stored = one['annotationStored'];
      return isObject(stored) && isObject(stored['point']) ? [stored['point']['payload']] : [];
    }
    const stored = one['resourceStored'];
    const points = isObject(stored) && Array.isArray(stored['points']) ? stored['points'] : [];
    return points.map((point: unknown) => (isObject(point) ? point['payload'] : undefined));
  }).filter(isObject);
}

/** A payload member the table states for every point of a collection: its name, or a failure when the table no longer states it. */
function member(collection: Collection, name: string): string {
  const payloads = statedPayloads(collection);
  if (payloads.length === 0 || !payloads.every((payload) => name in payload)) {
    throw new Error(`protocol/specs/src/${TABLE} does not state ${name} in the payload of every point of the ${collection}`);
  }
  return name;
}

/** The member that names a point's resource, in each collection. */
const RESOURCE: Readonly<Record<Collection, string>> = {
  resources: member('resources', 'resourceId'),
  annotations: member('annotations', 'resourceId'),
  declined: member('declined', 'resourceId'),
};
/** The member that names an annotation's point. */
const ANNOTATION = member('annotations', 'annotationId');
/** The member that says which of its resource's chunks a point is. */
const CHUNK = member('resources', 'chunkIndex');

// ── The database ───────────────────────────────────────────────────────────

interface Answer {
  status: number;
  /** The `result` of Qdrant's answer, when it has one. */
  result: unknown;
  text: string;
}

const originOf = (host: string) => `http://${host}:${QDRANT_PORT}`;

/** Ask the Qdrant of `database`, presenting its key. */
async function ask(database: VectorDatabase, method: string, path: string, body?: unknown): Promise<Answer> {
  const url = `${originOf(database.host)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'api-key': database.key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Error(`Qdrant did not answer ${method} ${url}: ${String(error)}`);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, result: isObject(parsed) ? parsed['result'] : undefined, text };
}

/** The result of an answer that must be 200. */
function answered(what: string, answer: Answer): unknown {
  if (answer.status !== 200) throw new Error(`Qdrant answered ${answer.status} when asked to ${what}: ${answer.text.slice(0, 300)}`);
  return answer.result;
}

/** The names of every collection the Qdrant of `database` holds now, of whichever knowledge base. */
export async function collectionsAt(database: VectorDatabase): Promise<string[]> {
  const result = answered('list its collections', await ask(database, 'GET', '/collections'));
  const listed = isObject(result) && Array.isArray(result['collections']) ? result['collections'] : [];
  return listed.flatMap((one: unknown) => (isObject(one) && typeof one['name'] === 'string' ? [one['name']] : []));
}

/**
 * Fail unless the Qdrant of `database` is there, answers its key, and
 * refuses a request that presents nothing. One started without a key
 * answers every token as it answers the key, and so holds no refusal.
 */
export async function guarded(database: VectorDatabase): Promise<void> {
  await collectionsAt(database);
  const url = `${originOf(database.host)}/collections`;
  const bare = await fetch(url);
  if (bare.status !== 401) {
    throw new Error(`Qdrant answered ${bare.status} to GET ${url}, which presented no key: it is to be started with an API key and its JWT access control on`);
  }
}

/** The index of the knowledge base whose DID is `kb`, in the Qdrant of `database`. */
export function vectorIndex(database: VectorDatabase, kb: string): VectorIndex {
  const names = collectionNames(kb);
  const at = (method: string, path: string, body?: unknown) => ask(database, method, path, body);

  /** The name of the knowledge base's collection of a word. */
  function named(collection: Collection): string {
    const name = names[collection];
    if (name === undefined) throw new Error(`protocol/specs/src/${TABLE} states no collection of ${collection}`);
    return name;
  }

  const where = (key: string, value: string) => ({ must: [{ key, match: { value } }] });

  function pointOf(found: unknown): Point {
    const id = isObject(found) ? found['id'] : undefined;
    if (!isObject(found) || (typeof id !== 'string' && typeof id !== 'number')) {
      throw new Error(`Qdrant answered a point with no id: ${String(JSON.stringify(found)).slice(0, 300)}`);
    }
    const payload = found['payload'];
    const vector = found['vector'];
    return {
      id,
      payload: isObject(payload) ? payload : {},
      ...(Array.isArray(vector) && vector.every((n) => typeof n === 'number') ? { vector } : {}),
    };
  }

  /** Every point of a collection that a filter takes, a page at a time. */
  async function scroll(collection: Collection, filter: unknown, vectors: boolean): Promise<Point[]> {
    const name = named(collection);
    const points: Point[] = [];
    let offset: unknown;
    do {
      const answer = await at('POST', `/collections/${name}/points/scroll`, {
        limit: 256,
        with_payload: true,
        with_vector: vectors,
        ...(filter === undefined ? {} : { filter }),
        ...(offset === undefined ? {} : { offset }),
      });
      if (answer.status === 404) return [];
      const page = answered(`list the points of ${name}`, answer);
      if (!isObject(page) || !Array.isArray(page['points'])) throw new Error(`Qdrant listed no points of ${name}: ${answer.text.slice(0, 300)}`);
      points.push(...page['points'].map(pointOf));
      offset = page['next_page_offset'] ?? undefined;
    } while (offset !== undefined);
    return points;
  }

  async function remove(collection: Collection, what: string, selection: Record<string, unknown>): Promise<void> {
    const name = named(collection);
    answered(`take ${what} out of ${name}`, await at('POST', `/collections/${name}/points/delete?wait=true`, selection));
  }

  return {
    points: (collection, vectors = false) => scroll(collection, undefined, vectors),
    async pointsOf(collection, resourceId, vectors = false) {
      const points = await scroll(collection, where(RESOURCE[collection], resourceId), vectors);
      return collection === 'resources' ? points.sort((a, b) => Number(a.payload[CHUNK]) - Number(b.payload[CHUNK])) : points;
    },
    async annotationPoint(annotationId, vectors = false) {
      const points = await scroll('annotations', where(ANNOTATION, annotationId), vectors);
      if (points.length > 1) throw new Error(`the index holds ${points.length} points of the annotation ${annotationId}`);
      return points[0];
    },
    async count(collection) {
      const name = named(collection);
      const answer = await at('POST', `/collections/${name}/points/count`, { exact: true });
      if (answer.status === 404) return 0;
      const result = answered(`count the points of ${name}`, answer);
      if (!isObject(result) || typeof result['count'] !== 'number') throw new Error(`Qdrant counted no points of ${name}: ${answer.text.slice(0, 300)}`);
      return result['count'];
    },
    deletePoint: (collection, id) => remove(collection, `the point ${id}`, { points: [id] }),
    deletePointsOf: (collection, resourceId) => remove(collection, `the points of ${resourceId}`, { filter: where(RESOURCE[collection], resourceId) }),
    async make(collection, size) {
      const name = named(collection);
      const made = answered(`make the collection ${name}`, await at('PUT', `/collections/${name}`, { vectors: { size, distance: distanceOf(collection) } }));
      if (made !== true) throw new Error(`Qdrant did not make the collection ${name}: it answered ${JSON.stringify(made)}`);
    },
    async put(collection, points) {
      const name = named(collection);
      const given = points.map(({ id, payload, vector }) => {
        if (vector === undefined) throw new Error(`the point ${id} has no vector to put into ${name}`);
        return { id, vector, payload };
      });
      answered(`put ${given.length} point(s) into ${name}`, await at('PUT', `/collections/${name}/points?wait=true`, { points: given }));
    },
    async clear() {
      for (const name of await collectionsAt(database)) answered(`delete the collection ${name}`, await at('DELETE', `/collections/${name}`));
    },
  };
}
