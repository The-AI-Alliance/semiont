/**
 * The vector index, read and changed by the suite's own calls: Qdrant, over
 * its REST interface, by plain `fetch`. The index's writer is what the suite
 * judges, so nothing here is a Smelter's code, or the code a Smelter shares
 * with the index's readers.
 *
 * What the index is, specs/src/vectors/payload-cases.json states: two
 * collections, one of resources' chunks and one of annotations, and what a
 * point's payload holds. The collections' names are read from that table, and
 * so is every payload member a point is found by here; a rename there fails
 * here. A point's id is never worked out: a chunk's point is found by the
 * resource its payload names, and an annotation's by the annotation.
 *
 * A collection that is not there holds no point: an index that was cleared,
 * and that no Smelter has connected to since, reads as empty.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_SOURCE } from './paths';

/** The port Qdrant's REST interface answers on. */
export const QDRANT_PORT = 6333;

/** The two collections, by what each holds. */
export type Collection = 'resources' | 'annotations';
const COLLECTIONS: readonly Collection[] = ['resources', 'annotations'];

/** A point of the index: its id, its payload whole, and its vector where one was asked for. */
export interface Point {
  id: string | number;
  payload: Record<string, unknown>;
  vector?: number[];
}

export interface VectorIndex {
  /** The names of the collections the database holds now. */
  collections(): Promise<string[]>;
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
  /** Clear the index: both collections gone, as a wiped volume leaves it. */
  clear(): Promise<void>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ── What the table states ──────────────────────────────────────────────────

const TABLE = 'vectors/payload-cases.json';
const table: unknown = JSON.parse(readFileSync(join(SPEC_SOURCE, TABLE), 'utf8'));

/** The name the table gives a collection. */
function named(collection: Collection): string {
  const stated = isObject(table) && isObject(table['collections']) ? table['collections'][collection] : undefined;
  if (!isObject(stated) || typeof stated['name'] !== 'string') throw new Error(`specs/src/${TABLE} states no collection of ${collection}`);
  return stated['name'];
}

/** The payloads the table states for the points of a collection. */
function statedPayloads(collection: Collection): Record<string, unknown>[] {
  const cases = isObject(table) && Array.isArray(table['cases']) ? table['cases'] : [];
  return cases.flatMap((one): unknown[] => {
    if (!isObject(one)) return [];
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
    throw new Error(`specs/src/${TABLE} does not state ${name} in the payload of every point of the ${collection}`);
  }
  return name;
}

/** The member that names a point's resource, in each collection. */
const RESOURCE: Readonly<Record<Collection, string>> = { resources: member('resources', 'resourceId'), annotations: member('annotations', 'resourceId') };
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

/** The index of the Qdrant at `host`. */
export function vectorIndex(host: string): VectorIndex {
  const origin = `http://${host}:${QDRANT_PORT}`;

  async function ask(method: string, path: string, body?: unknown): Promise<Answer> {
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`Qdrant did not answer ${method} ${origin}${path}: ${String(error)}`);
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
      const answer = await ask('POST', `/collections/${name}/points/scroll`, {
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
    answered(`take ${what} out of ${name}`, await ask('POST', `/collections/${name}/points/delete?wait=true`, selection));
  }

  async function collections(): Promise<string[]> {
    const result = answered('list its collections', await ask('GET', '/collections'));
    const listed = isObject(result) && Array.isArray(result['collections']) ? result['collections'] : [];
    return listed.flatMap((one: unknown) => (isObject(one) && typeof one['name'] === 'string' ? [one['name']] : []));
  }

  return {
    collections,
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
      const answer = await ask('POST', `/collections/${name}/points/count`, { exact: true });
      if (answer.status === 404) return 0;
      const result = answered(`count the points of ${name}`, answer);
      if (!isObject(result) || typeof result['count'] !== 'number') throw new Error(`Qdrant counted no points of ${name}: ${answer.text.slice(0, 300)}`);
      return result['count'];
    },
    deletePoint: (collection, id) => remove(collection, `the point ${id}`, { points: [id] }),
    deletePointsOf: (collection, resourceId) => remove(collection, `the points of ${resourceId}`, { filter: where(RESOURCE[collection], resourceId) }),
    async clear() {
      const present = await collections();
      for (const name of COLLECTIONS.map(named)) {
        if (present.includes(name)) answered(`delete the collection ${name}`, await ask('DELETE', `/collections/${name}`));
      }
    },
  };
}
