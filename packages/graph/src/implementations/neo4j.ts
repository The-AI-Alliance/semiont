// Neo4j implementation of GraphDatabase interface
// Uses Cypher query language

import type { Driver, Node as Neo4jNode, Session } from 'neo4j-driver';
import { GraphDatabase } from '../interface';
import { searchTerms } from '../resource-query';
import type { Logger } from '@semiont/core';
import type {
  GraphConnection,
  EntityTypeStats,
  ResourceFilter,
  ResourceId,
  AnnotationId,
} from '@semiont/core';
import {
  decodeAnnotation,
  type AnnotationProperties,
} from '../annotation-codec';
import { decodeResource } from '../resource-codec';

import type { ResourceDescriptor } from '@semiont/core';
import type { Annotation } from '@semiont/core';

/**
 * Convert motivation to a valid Neo4j label name
 *
 * Annotations get both a property (`motivation: "linking"`) and a label (`:Linking`)
 * for the same motivation value. This enables:
 * - Fast filtering: `MATCH (a:Annotation:Linking)` vs `MATCH (a:Annotation) WHERE a.motivation = 'linking'`
 * - Automatic indexing: Neo4j indexes labels by default
 * - Visual exploration: Graph visualization tools prominently display labels
 *
 * Example: "linking" -> "Linking", "commenting" -> "Commenting"
 *
 * W3C Motivation values:
 * assessing, bookmarking, classifying, commenting, describing, editing,
 * highlighting, identifying, linking, moderating, questioning, replying, tagging
 */
function motivationToLabel(motivation: string): string {
  return motivation.charAt(0).toUpperCase() + motivation.slice(1);
}

export class Neo4jGraphDatabase implements GraphDatabase {
  private driver: Driver | null = null;
  private neo4j!: typeof import('neo4j-driver');
  private connected: boolean = false;
  private logger?: Logger;
  private config: {
    uri?: string;
    username?: string;
    password?: string;
    database?: string;
  };

  constructor(config: {
    uri?: string;
    username?: string;
    password?: string;
    database?: string;
    logger?: Logger;
  } = {}) {
    this.config = config;
    this.logger = config.logger;
  }

  async connect(): Promise<void> {
    try {
      const uri = this.config.uri;
      const username = this.config.username;
      const password = this.config.password;
      const database = this.config.database;

      if (!uri) {
        throw new Error('Neo4j URI not configured! Pass uri in config.');
      }
      if (!username) {
        throw new Error('Neo4j username not configured! Pass username in config.');
      }
      if (!password) {
        throw new Error('Neo4j password not configured! Pass password in config.');
      }
      if (!database) {
        throw new Error('Neo4j database not configured! Pass database in config.');
      }

      this.logger?.info('Connecting to Neo4j', { uri });

      this.neo4j = await import('neo4j-driver');
      this.driver = this.neo4j.driver(
        uri,
        this.neo4j.auth.basic(username, password),
        {
          maxConnectionPoolSize: 50,
          connectionAcquisitionTimeout: 60000,
        }
      );

      // Test connection
      const session = this.driver.session({ database });

      await session.run('RETURN 1 as test');
      await session.close();

      // No constraint and no index is made here. The database's schema is its
      // writer's: the Weaver's store makes it when the Weaver connects.
      this.logger?.info('Successfully connected to Neo4j');
      this.connected = true;
    } catch (error) {
      this.logger?.error('Failed to connect to Neo4j', { error });
      throw new Error(`Neo4j connection failed: ${error}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private getSession(): Session {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }
    if (!this.config.database) {
      throw new Error('Neo4j database not configured! Pass database in config.');
    }
    return this.driver.session({
      database: this.config.database
    });
  }

  async getResource(id: ResourceId): Promise<ResourceDescriptor | null> {
    const session = this.getSession();
    try {
      // A stub is a link's target the graph has not been given yet: an id
      // and nothing else. It is not a resource the graph has.
      const result = await session.run(
        'MATCH (d:Resource {id: $id}) WHERE coalesce(d.stub, false) = false RETURN d',
        { id }
      );

      if (result.records.length === 0) return null;
      return this.parseResourceNode(result.records[0]!.get('d'));
    } finally {
      await session.close();
    }
  }

  async listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }> {
    const session = this.getSession();
    try {
      let whereClause = '';
      const params: any = {};
      // Stub nodes are id-only placeholders the Weaver makes when a
      // REFERENCES edge points at a resource whose `yield:created` event
      // hasn't landed yet. They carry no name, so they are not listable — and
      // `parseResourceNode` throws on the missing field rather than inventing one.
      const conditions: string[] = ['coalesce(d.stub, false) = false'];

      if (filter.archived !== undefined) {
        conditions.push('d.archived = $archived');
        params.archived = filter.archived;
      }

      if (filter.entityTypes && filter.entityTypes.length > 0) {
        conditions.push('ANY(type IN $entityTypes WHERE type IN d.entityTypes)');
        params.entityTypes = filter.entityTypes;
      }

      // Every term must appear, each satisfiable by the name or the path. A
      // whitespace-only query yields no terms and so is not a search at all.
      const terms = filter.search ? searchTerms(filter.search) : [];
      if (terms.length > 0) {
        conditions.push(
          `ALL(t IN $terms WHERE toLower(d.name) CONTAINS t
                             OR toLower(coalesce(d.storageUri, "")) CONTAINS t
                             OR ANY(e IN coalesce(d.entityTypes, []) WHERE toLower(e) CONTAINS t))`
        );
        params.terms = terms;
        params.search = filter.search!.trim().toLowerCase();
      }

      if (conditions.length > 0) {
        whereClause = 'WHERE ' + conditions.join(' AND ');
      }

      // Get total count
      const countResult = await session.run(
        `MATCH (d:Resource) ${whereClause} RETURN count(d) as total`,
        params
      );
      const total = countResult.records[0]!.get('total').toNumber();

      // Get paginated results - ensure integers for Neo4j
      params.skip = this.neo4j.int(filter.offset || 0);
      params.limit = this.neo4j.int(filter.limit || 20);

      // Rank only means something against a query; an unsearched listing orders
      // on recency alone. Ranking must happen here rather than over the returned
      // page, or it would sort one page instead of the match set.
      const rankClause = terms.length > 0
        ? `WITH d, CASE
             WHEN toLower(d.name) = $search THEN 0
             WHEN toLower(d.name) STARTS WITH $search THEN 1
             WHEN ALL(t IN $terms WHERE toLower(d.name) CONTAINS t) THEN 2
             ELSE 3
           END AS rank
         `
        : '';
      const orderClause = terms.length > 0
        ? 'ORDER BY rank, d.created DESC, d.id'
        : 'ORDER BY d.created DESC, d.id';

      const result = await session.run(
        `MATCH (d:Resource) ${whereClause}
         ${rankClause}RETURN d
         ${orderClause}
         SKIP $skip LIMIT $limit`,
        params
      );

      const resources = result.records.map(record => this.parseResourceNode(record.get('d')));

      return { resources, total };
    } finally {
      await session.close();
    }
  }

  async getAnnotation(id: AnnotationId): Promise<Annotation | null> {
    this.logger?.debug('Getting annotation', { id });
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (a:Annotation {id: $id})
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes`,
        { id }
      );

      if (result.records.length === 0) {
        this.logger?.debug('Annotation not found', { id });
        return null;
      }
      this.logger?.debug('Annotation found', { id });
      return parseAnnotationNode(
        result.records[0]!.get('a'),
        result.records[0]!.get('entityTypes')
      );
    } finally {
      await session.close();
    }
  }

  async getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (a:Annotation {resourceId: $resourceId})
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes
         ORDER BY a.created DESC`,
        { resourceId }
      );

      return result.records.map(record =>
        parseAnnotationNode(record.get('a'), record.get('entityTypes'))
      );
    } finally {
      await session.close();
    }
  }

  async getResourceReferencedBy(resourceId: ResourceId, motivation?: string): Promise<Annotation[]> {
    const session = this.getSession();
    try {
      this.logger?.debug('Searching for annotations referencing resource', { resourceId, motivation });

      // Build query with optional motivation label filter
      // If motivation is specified, use the label for efficient filtering
      const motivationLabel = motivation ? `:${motivationToLabel(motivation)}` : '';
      const cypher = `MATCH (a:Annotation${motivationLabel})-[:REFERENCES]->(d:Resource {id: $resourceId})
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes
         ORDER BY a.created DESC`;

      const result = await session.run(cypher, { resourceId });

      this.logger?.debug('Found annotations', { count: result.records.length });

      return result.records.map(record =>
        parseAnnotationNode(record.get('a'), record.get('entityTypes'))
      );
    } finally {
      await session.close();
    }
  }

  async getResourceConnections(resourceId: ResourceId): Promise<GraphConnection[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (d:Resource {id: $resourceId})
         OPTIONAL MATCH (d)<-[:BELONGS_TO]-(a1:Annotation)-[:REFERENCES]->(other:Resource)
         OPTIONAL MATCH (other)<-[:BELONGS_TO]-(a2:Annotation)-[:REFERENCES]->(d)
         WITH other, COLLECT(DISTINCT a1) as outgoing, COLLECT(DISTINCT a2) as incoming
         WHERE other IS NOT NULL AND coalesce(other.stub, false) = false
         RETURN other, outgoing, incoming`,
        { resourceId }
      );

      const connections: GraphConnection[] = [];

      for (const record of result.records) {
        const targetResource = this.parseResourceNode(record.get('other'));

        // Fetch entity types for outgoing annotations
        const outgoingNodes = record.get('outgoing');
        const outgoing: Annotation[] = [];
        for (const annNode of outgoingNodes) {
          const annId = annNode.properties.id;
          const annResult = await session.run(
            `MATCH (a:Annotation {id: $id})
             OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
             RETURN a, collect(et.name) as entityTypes`,
            { id: annId }
          );
          if (annResult.records.length > 0) {
            outgoing.push(parseAnnotationNode(
              annResult.records[0]!.get('a'),
              annResult.records[0]!.get('entityTypes')
            ));
          }
        }

        // Fetch entity types for incoming annotations
        const incomingNodes = record.get('incoming');
        const incoming: Annotation[] = [];
        for (const annNode of incomingNodes) {
          const annId = annNode.properties.id;
          const annResult = await session.run(
            `MATCH (a:Annotation {id: $id})
             OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
             RETURN a, collect(et.name) as entityTypes`,
            { id: annId }
          );
          if (annResult.records.length > 0) {
            incoming.push(parseAnnotationNode(
              annResult.records[0]!.get('a'),
              annResult.records[0]!.get('entityTypes')
            ));
          }
        }

        connections.push({
          targetResource,
          annotations: outgoing,
          bidirectional: incoming.length > 0
        });
      }

      return connections;
    } finally {
      await session.close();
    }
  }

  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (d:Resource)
         UNWIND d.entityTypes AS type
         RETURN type, count(*) AS count
         ORDER BY count DESC`
      );

      return result.records.map(record => ({
        type: record.get('type'),
        count: record.get('count').toNumber()
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * A node's properties, in the codec's names. What they mean, and which a
   * resource must have, is the codec's.
   */
  private parseResourceNode(node: Neo4jNode): ResourceDescriptor {
    const { id, name, entityTypes, format, archived, created, creator, contentChecksum, storageUri } = node.properties;
    return decodeResource({ id, name, entityTypes, format, archived, created, creator, contentChecksum, storageUri });
  }

}

/**
 * Project a neo4j annotation node to the wire `Annotation`.
 *
 * Module-level (not a method) so the projection is unit-testable without a
 * driver: `node` is untyped at this seam, so a native neo4j DateTime can
 * reach the wire as `created` unseen by tsc.
 */
export function parseAnnotationNode(node: any, entityTypes: string[] = []): Annotation {
  return decodeAnnotation(normalizeProperties(node.properties), entityTypes);
}

/**
 * Flatten a node's properties to the strings the codec reads.
 *
 * `created` is stored as the codec's own string, so it round-trips verbatim.
 * A stored row can hold a native temporal instead, and the driver hands that
 * back as an object whose `toString()` REFORMATS the value (a zero fraction
 * elided, any other padded to nanoseconds) — so such a row reads back with a
 * different string than the log carried, until a rebuild replaces it. This
 * is the coercion that has to happen before the codec sees a value it is
 * entitled to treat as a string. The seam is untyped, so only a test can see
 * it slip.
 */
function normalizeProperties(props: any): AnnotationProperties {
  const normalized: AnnotationProperties = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined) continue;
    normalized[key] = typeof value === 'string' ? value : String(value);
  }
  return normalized;
}
