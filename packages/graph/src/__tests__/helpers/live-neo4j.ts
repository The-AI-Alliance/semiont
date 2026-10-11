/**
 * A real neo4j for the `*.live.ts` suites.
 *
 * A fake driver is a claim about a database, and this package's fakes have
 * been wrong: one said a timestamp reads back as it was written, and the
 * in-memory store said an updated body reads back at all. These suites run a
 * store's own methods against the server the launcher starts for an operator
 * (`scripts/ci/neo4j-image.sh` prints its image) and read the rows themselves.
 *
 * The run is told where that server is, in `NEO4J_HOST` and `NEO4J_PASSWORD`.
 * With either missing it fails here and names what is missing. It is not
 * skipped: a suite that passes by not running holds nothing.
 *
 * The database may hold other rows. Nothing here clears it: every id a suite
 * writes starts with that suite's own prefix, and `close` deletes by prefix.
 */
import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';
import { annotationId, resourceId } from '@semiont/core';
import type { AnnotationId, ResourceDescriptor, ResourceId } from '@semiont/core';
import { Neo4jGraphDatabase } from '../../implementations/neo4j';

const BOLT_PORT = 7687;
const USERNAME = 'neo4j';
const DATABASE = 'neo4j';

function connection(): { uri: string; password: string } {
  const host = process.env.NEO4J_HOST;
  const password = process.env.NEO4J_PASSWORD;
  const missing = [
    ...(host ? [] : ['NEO4J_HOST']),
    ...(password ? [] : ['NEO4J_PASSWORD']),
  ];
  if (!host || !password) {
    throw new Error(
      `These suites run against a real neo4j and ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'Start one (`scripts/ci/neo4j-image.sh` prints the image; NEO4J_AUTH=neo4j/<password>) ' +
        'and set NEO4J_HOST to its address and NEO4J_PASSWORD to that password.',
    );
  }
  return { uri: `bolt://${host}:${BOLT_PORT}`, password };
}

/** A person as the record names one: by who they are. A name is the directory's, joined on at a read. */
export const CREATOR = { '@type': 'Person' as const, '@id': 'did:web:example.org:users:ada' };

/** The authoring moment, long past, so a store's own clock can never pass for it. */
export const AUTHORED = '2020-03-04T05:06:07.000Z';

export interface LiveNeo4j {
  readonly db: Neo4jGraphDatabase;
  /** An id of this run's own. */
  resource(name: string): ResourceId;
  annotation(name: string): AnnotationId;
  /** A name of this run's own, for an entity type (a node the stores merge by name). */
  tag(name: string): string;
  descriptor(id: ResourceId, overrides?: Partial<ResourceDescriptor>): ResourceDescriptor;
  /** The database's own answer, past the store's decoding. */
  rows(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export async function openLiveNeo4j(suite: string): Promise<LiveNeo4j> {
  const { uri, password } = connection();
  const prefix = `live-${suite}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-`;

  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(USERNAME, password));
  const db = new Neo4jGraphDatabase({ uri, username: USERNAME, password, database: DATABASE });
  await db.connect();

  const rows = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session({ database: DATABASE });
    try {
      const result = await session.run(cypher, params);
      return result.records.map((record) => record.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  };

  return {
    db,
    resource: (name) => resourceId(`${prefix}${name}`),
    annotation: (name) => annotationId(`${prefix}${name}`),
    tag: (name) => `${prefix}${name}`,
    descriptor: (id, overrides = {}) => ({
      '@context': 'https://schema.org/',
      '@id': id,
      name: String(id),
      entityTypes: [],
      representations: [{ mediaType: 'text/plain', checksum: 'sha256:live', rel: 'original' }],
      archived: false,
      dateCreated: AUTHORED,
      wasAttributedTo: CREATOR,
      ...overrides,
    }),
    rows,
    close: async () => {
      await rows(
        `MATCH (n) WHERE (n:Resource OR n:Annotation) AND n.id STARTS WITH $prefix DETACH DELETE n`,
        { prefix },
      );
      await rows(`MATCH (et:EntityType) WHERE et.name STARTS WITH $prefix DETACH DELETE et`, { prefix });
      await db.disconnect();
      await driver.close();
    },
  };
}
