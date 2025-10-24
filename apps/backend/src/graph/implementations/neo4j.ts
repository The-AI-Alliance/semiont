// Neo4j implementation of GraphDatabase interface
// Uses Cypher query language

import neo4j, { Driver, Session } from 'neo4j-driver';
import { GraphDatabase } from '../interface';
import {
  Document,
  Annotation,
  AnnotationCategory,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  DocumentFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateAnnotationInternal,
  getExactText,
} from '@semiont/core';
import { v4 as uuidv4 } from 'uuid';
import { getBodySource, getTargetSource, getTargetSelector } from '../../lib/annotation-utils';
import { extractEntityTypes } from '../annotation-body-utils';

export class Neo4jGraphDatabase implements GraphDatabase {
  private driver: Driver | null = null;
  private connected: boolean = false;
  private config: {
    uri?: string;
    username?: string;
    password?: string;
    database?: string;
  };

  // Tag Collections - cached in memory for performance
  private entityTypesCollection: Set<string> | null = null;

  constructor(config: {
    uri?: string;
    username?: string;
    password?: string;
    database?: string;
  } = {}) {
    this.config = config;
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

      console.log(`Connecting to Neo4j at ${uri}...`);

      this.driver = neo4j.driver(
        uri,
        neo4j.auth.basic(username, password),
        {
          maxConnectionPoolSize: 50,
          connectionAcquisitionTimeout: 60000,
        }
      );

      // Test connection
      const session = this.driver.session({ database });

      await session.run('RETURN 1 as test');
      await session.close();

      // Create constraints and indexes if they don't exist
      await this.ensureSchemaExists();

      console.log('Successfully connected to Neo4j');
      this.connected = true;
    } catch (error) {
      console.error('Failed to connect to Neo4j:', error);
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

  private async ensureSchemaExists(): Promise<void> {
    const session = this.getSession();
    try {
      // Create constraints for unique IDs
      const constraints = [
        'CREATE CONSTRAINT doc_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE',
        'CREATE CONSTRAINT sel_id IF NOT EXISTS FOR (s:Annotation) REQUIRE s.id IS UNIQUE',
        'CREATE CONSTRAINT tag_id IF NOT EXISTS FOR (t:TagCollection) REQUIRE t.type IS UNIQUE'
      ];

      for (const constraint of constraints) {
        try {
          await session.run(constraint);
        } catch (error: any) {
          // Ignore if constraint already exists
          if (!error.message?.includes('already exists')) {
            console.warn(`Schema creation warning: ${error.message}`);
          }
        }
      }

      // Create indexes for common queries
      const indexes = [
        'CREATE INDEX doc_name IF NOT EXISTS FOR (d:Document) ON (d.name)',
        'CREATE INDEX doc_entity_types IF NOT EXISTS FOR (d:Document) ON (d.entityTypes)',
        'CREATE INDEX sel_doc_id IF NOT EXISTS FOR (s:Annotation) ON (s.documentId)',
        'CREATE INDEX sel_resolved_id IF NOT EXISTS FOR (s:Annotation) ON (s.resolvedDocumentId)'
      ];

      for (const index of indexes) {
        try {
          await session.run(index);
        } catch (error: any) {
          // Ignore if index already exists
          if (!error.message?.includes('already exists')) {
            console.warn(`Index creation warning: ${error.message}`);
          }
        }
      }
    } finally {
      await session.close();
    }
  }

  async createDocument(input: CreateDocumentInput & { id: string }): Promise<Document> {
    const session = this.getSession();
    try {
      const id = input.id;
      const now = new Date().toISOString();

      const document: Document = {
        id,
        name: input.name,
        entityTypes: input.entityTypes,
        format: input.format,
        archived: false,
        created: now,
        creator: input.creator,
        creationMethod: input.creationMethod,
        contentChecksum: input.contentChecksum,
      };

      if (input.sourceAnnotationId) document.sourceAnnotationId = input.sourceAnnotationId;
      if (input.sourceDocumentId) document.sourceDocumentId = input.sourceDocumentId;

      const result = await session.run(
        `CREATE (d:Document {
          id: $id,
          name: $name,
          entityTypes: $entityTypes,
          format: $contentType,
          metadata: $metadata,
          archived: $archived,
          created: datetime($created),
          creator: $creator,
          creationMethod: $creationMethod,
          contentChecksum: $contentChecksum,
          sourceAnnotationId: $sourceAnnotationId,
          sourceDocumentId: $sourceDocumentId
        }) RETURN d`,
        {
          id,
          name: document.name,
          entityTypes: document.entityTypes,
          format: document.format,
          archived: document.archived,
          created: now,
          creator: document.creator,
          creationMethod: document.creationMethod,
          contentChecksum: document.contentChecksum,
          sourceAnnotationId: document.sourceAnnotationId ?? null,
          sourceDocumentId: document.sourceDocumentId ?? null,
        }
      );

      return this.parseDocumentNode(result.records[0]!.get('d'));
    } finally {
      await session.close();
    }
  }

  async getDocument(id: string): Promise<Document | null> {
    const session = this.getSession();
    try {
      const result = await session.run(
        'MATCH (d:Document {id: $id}) RETURN d',
        { id }
      );

      if (result.records.length === 0) return null;
      return this.parseDocumentNode(result.records[0]!.get('d'));
    } finally {
      await session.close();
    }
  }

  async updateDocument(id: string, input: UpdateDocumentInput): Promise<Document> {
    // Documents are immutable - only archiving is allowed
    if (Object.keys(input).length !== 1 || input.archived === undefined) {
      throw new Error('Documents are immutable. Only archiving is allowed.');
    }

    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (d:Document {id: $id})
         SET d.archived = $archived
         RETURN d`,
        { id, archived: input.archived }
      );

      if (result.records.length === 0) {
        throw new Error('Document not found');
      }

      return this.parseDocumentNode(result.records[0]!.get('d'));
    } finally {
      await session.close();
    }
  }

  async deleteDocument(id: string): Promise<void> {
    const session = this.getSession();
    try {
      // Delete document and all its annotations
      await session.run(
        `MATCH (d:Document {id: $id})
         OPTIONAL MATCH (a:Annotation)-[:BELONGS_TO|:REFERENCES]->(d)
         DETACH DELETE d, a`,
        { id }
      );
    } finally {
      await session.close();
    }
  }

  async listDocuments(filter: DocumentFilter): Promise<{ documents: Document[]; total: number }> {
    const session = this.getSession();
    try {
      let whereClause = '';
      const params: any = {};
      const conditions: string[] = [];

      if (filter.entityTypes && filter.entityTypes.length > 0) {
        conditions.push('ANY(type IN $entityTypes WHERE type IN d.entityTypes)');
        params.entityTypes = filter.entityTypes;
      }

      if (filter.search) {
        conditions.push('toLower(d.name) CONTAINS toLower($search)');
        params.search = filter.search;
      }

      if (conditions.length > 0) {
        whereClause = 'WHERE ' + conditions.join(' AND ');
      }

      // Get total count
      const countResult = await session.run(
        `MATCH (d:Document) ${whereClause} RETURN count(d) as total`,
        params
      );
      const total = countResult.records[0]!.get('total').toNumber();

      // Get paginated results - ensure integers for Neo4j
      params.skip = neo4j.int(filter.offset || 0);
      params.limit = neo4j.int(filter.limit || 20);

      const result = await session.run(
        `MATCH (d:Document) ${whereClause}
         RETURN d
         ORDER BY d.updatedAt DESC
         SKIP $skip LIMIT $limit`,
        params
      );

      const documents = result.records.map(record => this.parseDocumentNode(record.get('d')));

      return { documents, total };
    } finally {
      await session.close();
    }
  }

  async searchDocuments(query: string, limit: number = 20): Promise<Document[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (d:Document)
         WHERE toLower(d.name) CONTAINS toLower($query)
         RETURN d
         ORDER BY d.updatedAt DESC
         LIMIT $limit`,
        { query, limit: neo4j.int(limit) }
      );

      return result.records.map(record => this.parseDocumentNode(record.get('d')));
    } finally {
      await session.close();
    }
  }

  async createAnnotation(input: CreateAnnotationInternal): Promise<Annotation> {
    const session = this.getSession();
    try {
      const id = input.id;

      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id,
        motivation: input.motivation,
        target: input.target,
        body: input.body,
        creator: input.creator,
        created: new Date().toISOString(),
      };

      // Extract values for Cypher query
      const targetSource = getTargetSource(input.target);
      const targetSelector = getTargetSelector(input.target);
      const bodySource = getBodySource(input.body);

      // Extract entity types from TextualBody bodies with purpose: "tagging"
      const entityTypes = extractEntityTypes(input.body);

      // Create the annotation node and relationships
      let cypher: string;
      if (bodySource) {
        // Resolved reference with target document
        cypher = `MATCH (from:Document {id: $fromId})
           MATCH (to:Document {id: $toId})
           CREATE (a:Annotation {
             id: $id,
             documentId: $documentId,
             exact: $exact,
             selector: $selector,
             type: $type,
             motivation: $motivation,
             creator: $creator,
             created: datetime($created),
             source: $source
           })
           CREATE (a)-[:BELONGS_TO]->(from)
           CREATE (a)-[:REFERENCES]->(to)
           FOREACH (entityType IN $entityTypes |
             MERGE (et:EntityType {name: entityType})
             CREATE (a)-[:TAGGED_AS]->(et)
           )
           RETURN a`;
      } else {
        // Stub reference (unresolved)
        cypher = `MATCH (d:Document {id: $documentId})
           CREATE (a:Annotation {
             id: $id,
             documentId: $documentId,
             exact: $exact,
             selector: $selector,
             type: $type,
             motivation: $motivation,
             creator: $creator,
             created: datetime($created)
           })
           CREATE (a)-[:BELONGS_TO]->(d)
           FOREACH (entityType IN $entityTypes |
             MERGE (et:EntityType {name: entityType})
             CREATE (a)-[:TAGGED_AS]->(et)
           )
           RETURN a`;
      }

      const params: any = {
        id,
        documentId: targetSource,
        fromId: targetSource,
        toId: bodySource || null,
        exact: targetSelector ? getExactText(targetSelector) : '',
        selector: JSON.stringify(targetSelector || {}),
        type: 'SpecificResource',
        motivation: annotation.motivation,
        creator: JSON.stringify(annotation.creator),
        created: annotation.created,
        entityTypes,
        source: bodySource || null,
      };

      const result = await session.run(cypher, params);

      if (result.records.length === 0) {
        throw new Error(`Failed to create annotation: Document ${targetSource} not found in graph database`);
      }

      return this.parseAnnotationNode(result.records[0]!.get('a'), entityTypes);
    } finally {
      await session.close();
    }
  }

  async getAnnotation(id: string): Promise<Annotation | null> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (a:Annotation {id: $id})
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes`,
        { id }
      );

      if (result.records.length === 0) return null;
      return this.parseAnnotationNode(
        result.records[0]!.get('a'),
        result.records[0]!.get('entityTypes')
      );
    } finally {
      await session.close();
    }
  }

  async updateAnnotation(id: string, updates: Partial<Annotation>): Promise<Annotation> {
    const session = this.getSession();
    try {
      const setClauses: string[] = ['a.updatedAt = datetime()'];
      const params: any = { id };

      // Build SET clauses dynamically
      Object.entries(updates).forEach(([key, value]) => {
        if (key !== 'id' && key !== 'updatedAt') {
          setClauses.push(`a.${key} = $${key}`);
          if (key === 'selector' || key === 'metadata') {
            params[key] = JSON.stringify(value);
          } else if (key === 'created' || key === 'resolvedAt') {
            params[key] = value ? new Date(value as any).toISOString() : null;
          } else {
            params[key] = value;
          }
        }
      });

      const result = await session.run(
        `MATCH (a:Annotation {id: $id})
         SET ${setClauses.join(', ')}
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes`,
        params
      );

      if (result.records.length === 0) {
        throw new Error('Annotation not found');
      }

      return this.parseAnnotationNode(
        result.records[0]!.get('a'),
        result.records[0]!.get('entityTypes')
      );
    } finally {
      await session.close();
    }
  }

  async deleteAnnotation(id: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(
        'MATCH (a:Annotation {id: $id}) DETACH DELETE s',
        { id }
      );
    } finally {
      await session.close();
    }
  }

  async listAnnotations(filter: { documentId?: string; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }> {
    const session = this.getSession();
    try {
      const conditions: string[] = [];
      const params: any = {};

      if (filter.documentId) {
        conditions.push('a.documentId = $documentId');
        params.documentId = filter.documentId;
      }

      if (filter.type) {
        const w3cType = filter.type === 'highlight' ? 'TextualBody' : 'SpecificResource';
        conditions.push('a.type = $type');
        params.type = w3cType;
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      // Get all results (no pagination in new simplified interface)
      const result = await session.run(
        `MATCH (a:Annotation) ${whereClause}
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes`,
        params
      );

      const annotations = result.records.map(record =>
        this.parseAnnotationNode(record.get('a'), record.get('entityTypes'))
      );

      return { annotations, total: annotations.length };
    } finally {
      await session.close();
    }
  }

  async getHighlights(documentId: string): Promise<Annotation[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (a:Annotation {documentId: $documentId})
         WHERE a.annotationCategory = 'highlight'
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes
         ORDER BY a.created DESC`,
        { documentId }
      );

      return result.records.map(record =>
        this.parseAnnotationNode(record.get('a'), record.get('entityTypes'))
      );
    } finally {
      await session.close();
    }
  }

  async resolveReference(annotationId: string, source: string): Promise<Annotation> {
    const session = this.getSession();
    try {
      // Get the target document's name
      const docResult = await session.run(
        'MATCH (d:Document {id: $id}) RETURN d.name as name',
        { id: source }
      );
      const documentName = docResult.records[0]?.get('name');

      // Update annotation and create REFERENCES relationship
      const result = await session.run(
        `MATCH (a:Annotation {id: $annotationId})
         MATCH (to:Document {id: $source})
         SET a.source = $source,
             a.resolvedDocumentName = $documentName,
             a.resolvedAt = datetime()
         MERGE (a)-[:REFERENCES]->(to)
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes`,
        { annotationId, source, documentName }
      );

      if (result.records.length === 0) {
        throw new Error('Annotation not found');
      }

      return this.parseAnnotationNode(
        result.records[0]!.get('a'),
        result.records[0]!.get('entityTypes')
      );
    } finally {
      await session.close();
    }
  }

  async getReferences(documentId: string): Promise<Annotation[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (a:Annotation {documentId: $documentId})
         WHERE a.annotationCategory IN ['stub_reference', 'resolved_reference']
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes
         ORDER BY a.created DESC`,
        { documentId }
      );

      return result.records.map(record =>
        this.parseAnnotationNode(record.get('a'), record.get('entityTypes'))
      );
    } finally {
      await session.close();
    }
  }

  async getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Annotation[]> {
    const session = this.getSession();
    try {
      let cypher = `MATCH (a:Annotation {documentId: $documentId})
                    WHERE a.source IS NOT NULL`;

      const params: any = { documentId };

      if (entityTypes && entityTypes.length > 0) {
        cypher += `
          MATCH (a)-[:TAGGED_AS]->(et:EntityType)
          WHERE et.name IN $entityTypes`;
        params.entityTypes = entityTypes;
      }

      cypher += `
        OPTIONAL MATCH (a)-[:TAGGED_AS]->(et2:EntityType)
        RETURN a, collect(et2.name) as entityTypes
        ORDER BY a.created DESC`;

      const result = await session.run(cypher, params);

      return result.records.map(record =>
        this.parseAnnotationNode(record.get('a'), record.get('entityTypes'))
      );
    } finally {
      await session.close();
    }
  }

  async getDocumentAnnotations(documentId: string): Promise<Annotation[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (a:Annotation {documentId: $documentId})
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes
         ORDER BY a.created DESC`,
        { documentId }
      );

      return result.records.map(record =>
        this.parseAnnotationNode(record.get('a'), record.get('entityTypes'))
      );
    } finally {
      await session.close();
    }
  }

  async getDocumentReferencedBy(documentId: string): Promise<Annotation[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (a:Annotation)-[:REFERENCES]->(d:Document {id: $documentId})
         OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
         RETURN a, collect(et.name) as entityTypes
         ORDER BY a.created DESC`,
        { documentId }
      );

      return result.records.map(record =>
        this.parseAnnotationNode(record.get('a'), record.get('entityTypes'))
      );
    } finally {
      await session.close();
    }
  }

  async getDocumentConnections(documentId: string): Promise<GraphConnection[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (d:Document {id: $documentId})
         OPTIONAL MATCH (d)<-[:BELONGS_TO]-(a1:Annotation)-[:REFERENCES]->(other:Document)
         OPTIONAL MATCH (other)<-[:BELONGS_TO]-(a2:Annotation)-[:REFERENCES]->(d)
         WITH other, COLLECT(DISTINCT a1) as outgoing, COLLECT(DISTINCT a2) as incoming
         WHERE other IS NOT NULL
         RETURN other, outgoing, incoming`,
        { documentId }
      );

      const connections: GraphConnection[] = [];

      for (const record of result.records) {
        const targetDocument = this.parseDocumentNode(record.get('other'));

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
            outgoing.push(this.parseAnnotationNode(
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
            incoming.push(this.parseAnnotationNode(
              annResult.records[0]!.get('a'),
              annResult.records[0]!.get('entityTypes')
            ));
          }
        }

        connections.push({
          targetDocument,
          annotations: outgoing,
          bidirectional: incoming.length > 0
        });
      }

      return connections;
    } finally {
      await session.close();
    }
  }

  async findPath(fromDocumentId: string, toDocumentId: string, maxDepth: number = 5): Promise<GraphPath[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH path = shortestPath((from:Document {id: $fromId})-[:REFERENCES*..${maxDepth}]-(to:Document {id: $toId}))
         WITH path, nodes(path) as docs, relationships(path) as rels
         RETURN docs, rels
         LIMIT 10`,
        { fromId: fromDocumentId, toId: toDocumentId }
      );

      const paths: GraphPath[] = [];

      for (const record of result.records) {
        const docs = record.get('docs').map((node: any) => this.parseDocumentNode(node));
        const rels = record.get('rels');

        // Get annotation details for the relationships
        const annotationIds = rels.map((rel: any) => rel.properties.id).filter((id: any) => id);
        const annotations: Annotation[] = [];

        if (annotationIds.length > 0) {
          const selResult = await session.run(
            `MATCH (a:Annotation) WHERE a.id IN $ids
             OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
             RETURN a, collect(et.name) as entityTypes`,
            { ids: annotationIds }
          );
          selResult.records.forEach(rec => {
            annotations.push(this.parseAnnotationNode(
              rec.get('a'),
              rec.get('entityTypes')
            ));
          });
        }

        paths.push({
          documents: docs,
          annotations: annotations
        });
      }

      return paths;
    } finally {
      await session.close();
    }
  }

  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (d:Document)
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

  async getStats(): Promise<{
    documentCount: number;
    annotationCount: number;
    highlightCount: number;
    referenceCount: number;
    entityReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  }> {
    const session = this.getSession();
    try {
      // Get document count
      const docCountResult = await session.run('MATCH (d:Document) RETURN count(d) as count');
      const documentCount = docCountResult.records[0]!.get('count').toNumber();

      // Get annotation counts
      const selCountResult = await session.run('MATCH (a:Annotation) RETURN count(a) as count');
      const annotationCount = selCountResult.records[0]!.get('count').toNumber();

      const highlightCountResult = await session.run(
        'MATCH (a:Annotation) WHERE a.resolvedDocumentId IS NULL RETURN count(a) as count'
      );
      const highlightCount = highlightCountResult.records[0]!.get('count').toNumber();

      const referenceCountResult = await session.run(
        'MATCH (a:Annotation) WHERE a.resolvedDocumentId IS NOT NULL RETURN count(a) as count'
      );
      const referenceCount = referenceCountResult.records[0]!.get('count').toNumber();

      const entityRefCountResult = await session.run(
        'MATCH (a:Annotation) WHERE a.resolvedDocumentId IS NOT NULL AND size(a.entityTypes) > 0 RETURN count(a) as count'
      );
      const entityReferenceCount = entityRefCountResult.records[0]!.get('count').toNumber();

      // Get entity type stats
      const entityTypeResult = await session.run(
        `MATCH (d:Document)
         UNWIND d.entityTypes AS type
         RETURN type, count(*) AS count`
      );

      const entityTypes: Record<string, number> = {};
      entityTypeResult.records.forEach(record => {
        entityTypes[record.get('type')] = record.get('count').toNumber();
      });

      // Get content type stats
      const contentTypeResult = await session.run(
        `MATCH (d:Document)
         RETURN d.format as type, count(*) AS count`
      );

      const contentTypes: Record<string, number> = {};
      contentTypeResult.records.forEach(record => {
        contentTypes[record.get('type')] = record.get('count').toNumber();
      });

      return {
        documentCount,
        annotationCount,
        highlightCount,
        referenceCount,
        entityReferenceCount,
        entityTypes,
        contentTypes
      };
    } finally {
      await session.close();
    }
  }

  async createAnnotations(inputs: CreateAnnotationInternal[]): Promise<Annotation[]> {
    const results: Annotation[] = [];
    for (const input of inputs) {
      results.push(await this.createAnnotation(input));
    }
    return results;
  }

  async resolveReferences(inputs: { annotationId: string; source: string }[]): Promise<Annotation[]> {
    const results: Annotation[] = [];
    for (const input of inputs) {
      results.push(await this.resolveReference(input.annotationId, input.source));
    }
    return results;
  }

  async detectAnnotations(_documentId: string): Promise<Annotation[]> {
    // This would use AI/ML to detect annotations in a document
    // For now, return empty array as a placeholder
    return [];
  }

  // Tag Collections
  async getEntityTypes(): Promise<string[]> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    return Array.from(this.entityTypesCollection!).sort();
  }

  async addEntityType(tag: string): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    this.entityTypesCollection!.add(tag);
    await this.persistTagCollection('entity-types', this.entityTypesCollection!);
  }

  async addEntityTypes(tags: string[]): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.entityTypesCollection!.add(tag));
    await this.persistTagCollection('entity-types', this.entityTypesCollection!);
  }

  private async initializeTagCollections(): Promise<void> {
    const session = this.getSession();
    try {
      // Load existing collections from Neo4j
      const result = await session.run(
        'MATCH (t:TagCollection {type: "entity-types"}) RETURN t.tags as tags'
      );

      let entityTypesFromDb: string[] = [];

      if (result.records.length > 0) {
        const record = result.records[0];
        if (record) {
          const tags = record.get('tags');
          entityTypesFromDb = tags || [];
        }
      }

      // Load defaults
      const { DEFAULT_ENTITY_TYPES } = await import('../tag-collections');

      // Merge with defaults
      this.entityTypesCollection = new Set([...DEFAULT_ENTITY_TYPES, ...entityTypesFromDb]);

      // Persist merged collection back to Neo4j
      await this.persistTagCollection('entity-types', this.entityTypesCollection);
    } finally {
      await session.close();
    }
  }

  private async persistTagCollection(type: string, collection: Set<string>): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(
        'MERGE (t:TagCollection {type: $type}) SET t.tags = $tags',
        { type, tags: Array.from(collection) }
      );
    } finally {
      await session.close();
    }
  }

  generateId(): string {
    return uuidv4().replace(/-/g, '').substring(0, 12);
  }

  async clearDatabase(): Promise<void> {
    const session = this.getSession();
    try {
      // CAREFUL! This clears the entire database
      await session.run('MATCH (n) DETACH DELETE n');
      this.entityTypesCollection = null;
    } finally {
      await session.close();
    }
  }

  // Helper methods to parse Neo4j nodes
  private parseDocumentNode(node: any): Document {
    const props = node.properties;

    // Validate all required fields
    if (!props.id) throw new Error('Document missing required field: id');
    if (!props.name) throw new Error(`Document ${props.id} missing required field: name`);
    if (!props.entityTypes) throw new Error(`Document ${props.id} missing required field: entityTypes`);
    if (!props.format) throw new Error(`Document ${props.id} missing required field: contentType`);
    if (props.archived === undefined || props.archived === null) throw new Error(`Document ${props.id} missing required field: archived`);
    if (!props.created) throw new Error(`Document ${props.id} missing required field: created`);
    if (!props.creator) throw new Error(`Document ${props.id} missing required field: creator`);
    if (!props.creationMethod) throw new Error(`Document ${props.id} missing required field: creationMethod`);
    if (!props.contentChecksum) throw new Error(`Document ${props.id} missing required field: contentChecksum`);

    return {
      id: props.id,
      name: props.name,
      entityTypes: props.entityTypes,
      format: props.format,
      archived: props.archived,
      created: props.created.toString(), // ISO string from DB
      creator: props.creator,
      creationMethod: props.creationMethod,
      contentChecksum: props.contentChecksum,
      sourceAnnotationId: props.sourceAnnotationId,
      sourceDocumentId: props.sourceDocumentId,
    };
  }

  private parseAnnotationNode(node: any, entityTypes: string[] = []): Annotation {
    const props = node.properties;

    // Validate required fields
    if (!props.id) throw new Error('Annotation missing required field: id');
    if (!props.documentId) throw new Error(`Annotation ${props.id} missing required field: documentId`);
    if (!props.exact) throw new Error(`Annotation ${props.id} missing required field: text`);
    if (!props.type) throw new Error(`Annotation ${props.id} missing required field: type`);
    if (!props.selector) throw new Error(`Annotation ${props.id} missing required field: selector`);
    if (!props.creator) throw new Error(`Annotation ${props.id} missing required field: creator`);

    if (!props.motivation) throw new Error(`Annotation ${props.id} missing required field: motivation`);

    // Parse creator - always stored as JSON string in DB
    const creator = JSON.parse(props.creator);

    // Reconstruct body array from entity tags and linking body
    const bodyArray: Array<{type: 'TextualBody'; value: string; purpose: 'tagging'} | {type: 'SpecificResource'; source: string; purpose: 'linking'}> = [];

    // Add entity tag bodies (TextualBody with purpose: "tagging")
    for (const entityType of entityTypes) {
      if (entityType) {  // Filter out nulls
        bodyArray.push({
          type: 'TextualBody' as const,
          value: entityType,
          purpose: 'tagging' as const,
        });
      }
    }

    // Add linking body (SpecificResource) if annotation is resolved
    if (props.source) {
      bodyArray.push({
        type: 'SpecificResource' as const,
        source: props.source,
        purpose: 'linking' as const,
      });
    }

    const annotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id: props.id,
      motivation: props.motivation,
      target: {
        source: props.documentId,
        selector: JSON.parse(props.selector),
      },
      body: bodyArray as Annotation['body'],
      creator,
      created: props.created, // ISO string from DB
    };

    // W3C Web Annotation modification tracking
    if (props.modified) annotation.modified = props.modified.toString();
    if (props.generator) {
      try {
        annotation.generator = JSON.parse(props.generator);
      } catch (e) {
        // Ignore parse errors
      }
    }

    return annotation;
  }
}