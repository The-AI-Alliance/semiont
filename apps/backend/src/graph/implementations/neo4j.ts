// Neo4j implementation of GraphDatabase interface
// Uses Cypher query language

import neo4j, { Driver, Session } from 'neo4j-driver';
import { GraphDatabase } from '../interface';
import {
  Document,
  Selection,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  DocumentFilter,
  SelectionFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateSelectionInput,
  ResolveSelectionInput,
} from '../types';
import { v4 as uuidv4 } from 'uuid';

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
  private referenceTypesCollection: Set<string> | null = null;

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
      const uri = this.config.uri || process.env.NEO4J_URI || 'bolt://localhost:7687';
      const username = this.config.username || process.env.NEO4J_USERNAME || 'neo4j';
      const password = this.config.password || process.env.NEO4J_PASSWORD || 'password';

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
      const session = this.driver.session({
        database: this.config.database || process.env.NEO4J_DATABASE || 'neo4j'
      });

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
    return this.driver.session({
      database: this.config.database || process.env.NEO4J_DATABASE || 'neo4j'
    });
  }

  private async ensureSchemaExists(): Promise<void> {
    const session = this.getSession();
    try {
      // Create constraints for unique IDs
      const constraints = [
        'CREATE CONSTRAINT doc_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE',
        'CREATE CONSTRAINT sel_id IF NOT EXISTS FOR (s:Selection) REQUIRE s.id IS UNIQUE',
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
        'CREATE INDEX sel_doc_id IF NOT EXISTS FOR (s:Selection) ON (s.documentId)',
        'CREATE INDEX sel_resolved_id IF NOT EXISTS FOR (s:Selection) ON (s.resolvedDocumentId)'
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

  async createDocument(input: CreateDocumentInput): Promise<Document> {
    const session = this.getSession();
    try {
      const id = this.generateId();
      const now = new Date().toISOString();

      const document: Document = {
        id,
        name: input.name,
        entityTypes: input.entityTypes,
        contentType: input.contentType,
        metadata: input.metadata,
        archived: false,
        createdAt: new Date(now),
        createdBy: input.createdBy,
        creationMethod: input.creationMethod,
        contentChecksum: input.contentChecksum,
      };

      if (input.sourceSelectionId) document.sourceSelectionId = input.sourceSelectionId;
      if (input.sourceDocumentId) document.sourceDocumentId = input.sourceDocumentId;

      const result = await session.run(
        `CREATE (d:Document {
          id: $id,
          name: $name,
          entityTypes: $entityTypes,
          contentType: $contentType,
          metadata: $metadata,
          archived: $archived,
          createdAt: datetime($createdAt),
          createdBy: $createdBy,
          creationMethod: $creationMethod,
          contentChecksum: $contentChecksum,
          sourceSelectionId: $sourceSelectionId,
          sourceDocumentId: $sourceDocumentId
        }) RETURN d`,
        {
          id,
          name: document.name,
          entityTypes: document.entityTypes,
          contentType: document.contentType,
          metadata: JSON.stringify(document.metadata),
          archived: document.archived,
          createdAt: now,
          createdBy: document.createdBy,
          creationMethod: document.creationMethod,
          contentChecksum: document.contentChecksum,
          sourceSelectionId: document.sourceSelectionId ?? null,
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
      // Delete document and all its selections
      await session.run(
        `MATCH (d:Document {id: $id})
         OPTIONAL MATCH (s:Selection)-[:BELONGS_TO|:REFERENCES]->(d)
         DETACH DELETE d, s`,
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

  async createSelection(input: CreateSelectionInput): Promise<Selection> {
    const session = this.getSession();
    try {
      const id = this.generateId();
      const now = new Date().toISOString();

      const selection: Selection = {
        id,
        documentId: input.documentId,
        selectionType: input.selectionType,
        selectionData: input.selectionData,
        provisional: input.provisional || false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };

      // Add optional fields
      if (input.createdBy) selection.createdBy = input.createdBy;

      // Set selectionCategory based on resolvedDocumentId presence and value
      let selectionCategory: string;
      if ('resolvedDocumentId' in input) {
        selection.resolvedDocumentId = input.resolvedDocumentId;
        if (input.resolvedDocumentId) {
          selection.resolvedAt = new Date(now);
          selectionCategory = 'resolved_reference';
        } else {
          selectionCategory = 'stub_reference';
        }
        if (input.resolvedBy) selection.resolvedBy = input.resolvedBy;
      } else {
        selectionCategory = 'highlight';
      }

      if (input.referenceTags) selection.referenceTags = input.referenceTags;
      if (input.entityTypes) selection.entityTypes = input.entityTypes;
      if (input.confidence !== undefined) selection.confidence = input.confidence;
      if (input.metadata) selection.metadata = input.metadata;

      // Create the selection node and relationships
      // Three cases: resolved reference (has target doc), stub reference (null), highlight (no field)
      let cypher: string;
      if (selectionCategory === 'resolved_reference') {
        // Resolved reference - has a target document
        cypher = `MATCH (from:Document {id: $fromId})
           MATCH (to:Document {id: $toId})
           CREATE (s:Selection {
             id: $id,
             documentId: $documentId,
             resolvedDocumentId: $resolvedDocumentId,
             selectionType: $selectionType,
             selectionCategory: $selectionCategory,
             selectionData: $selectionData,
             provisional: $provisional,
             referenceTags: $referenceTags,
             entityTypes: $entityTypes,
             confidence: $confidence,
             metadata: $metadata,
             createdAt: datetime($createdAt),
             updatedAt: datetime($updatedAt),
             resolvedAt: datetime($resolvedAt),
             createdBy: $createdBy,
             resolvedBy: $resolvedBy
           })
           CREATE (s)-[:BELONGS_TO]->(from)
           CREATE (s)-[:REFERENCES]->(to)
           RETURN s`;
      } else if (selectionCategory === 'stub_reference') {
        // Stub reference - has resolvedDocumentId but it's null
        cypher = `MATCH (d:Document {id: $documentId})
           CREATE (s:Selection {
             id: $id,
             documentId: $documentId,
             resolvedDocumentId: $resolvedDocumentId,
             selectionType: $selectionType,
             selectionCategory: $selectionCategory,
             selectionData: $selectionData,
             provisional: $provisional,
             referenceTags: $referenceTags,
             entityTypes: $entityTypes,
             metadata: $metadata,
             createdAt: datetime($createdAt),
             updatedAt: datetime($updatedAt),
             createdBy: $createdBy
           })
           CREATE (s)-[:BELONGS_TO]->(d)
           RETURN s`;
      } else {
        // Highlight - no resolvedDocumentId field at all
        cypher = `MATCH (d:Document {id: $documentId})
           CREATE (s:Selection {
             id: $id,
             documentId: $documentId,
             selectionType: $selectionType,
             selectionCategory: $selectionCategory,
             selectionData: $selectionData,
             provisional: $provisional,
             entityTypes: $entityTypes,
             metadata: $metadata,
             createdAt: datetime($createdAt),
             updatedAt: datetime($updatedAt),
             createdBy: $createdBy
           })
           CREATE (s)-[:BELONGS_TO]->(d)
           RETURN s`;
      }

      const params: any = {
        id,
        documentId: selection.documentId,
        fromId: selection.documentId,
        toId: selection.resolvedDocumentId ?? null,
        resolvedDocumentId: selection.resolvedDocumentId ?? null,
        selectionType: selection.selectionType,
        selectionCategory,
        selectionData: JSON.stringify(selection.selectionData),
        provisional: selection.provisional,
        referenceTags: selection.referenceTags || [],
        entityTypes: selection.entityTypes || [],
        confidence: selection.confidence ?? null,
        metadata: selection.metadata ? JSON.stringify(selection.metadata) : null,
        createdAt: now,
        updatedAt: now,
        resolvedAt: selection.resolvedAt?.toISOString() ?? null,
        createdBy: selection.createdBy ?? null,
        resolvedBy: selection.resolvedBy ?? null,
      };

      const result = await session.run(cypher, params);

      return this.parseSelectionNode(result.records[0]!.get('s'));
    } finally {
      await session.close();
    }
  }

  async getSelection(id: string): Promise<Selection | null> {
    const session = this.getSession();
    try {
      const result = await session.run(
        'MATCH (s:Selection {id: $id}) RETURN s',
        { id }
      );

      if (result.records.length === 0) return null;
      return this.parseSelectionNode(result.records[0]!.get('s'));
    } finally {
      await session.close();
    }
  }

  async updateSelection(id: string, updates: Partial<Selection>): Promise<Selection> {
    const session = this.getSession();
    try {
      const setClauses: string[] = ['s.updatedAt = datetime()'];
      const params: any = { id };

      // Build SET clauses dynamically
      Object.entries(updates).forEach(([key, value]) => {
        if (key !== 'id' && key !== 'updatedAt') {
          setClauses.push(`s.${key} = $${key}`);
          if (key === 'selectionData' || key === 'metadata') {
            params[key] = JSON.stringify(value);
          } else if (key === 'createdAt' || key === 'resolvedAt') {
            params[key] = value ? new Date(value as any).toISOString() : null;
          } else {
            params[key] = value;
          }
        }
      });

      const result = await session.run(
        `MATCH (s:Selection {id: $id})
         SET ${setClauses.join(', ')}
         RETURN s`,
        params
      );

      if (result.records.length === 0) {
        throw new Error('Selection not found');
      }

      return this.parseSelectionNode(result.records[0]!.get('s'));
    } finally {
      await session.close();
    }
  }

  async deleteSelection(id: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(
        'MATCH (s:Selection {id: $id}) DETACH DELETE s',
        { id }
      );
    } finally {
      await session.close();
    }
  }

  async listSelections(filter: SelectionFilter): Promise<{ selections: Selection[]; total: number }> {
    const session = this.getSession();
    try {
      const conditions: string[] = [];
      const params: any = {};

      if (filter.documentId) {
        conditions.push('s.documentId = $documentId');
        params.documentId = filter.documentId;
      }

      if (filter.resolvedDocumentId) {
        conditions.push('s.resolvedDocumentId = $resolvedDocumentId');
        params.resolvedDocumentId = filter.resolvedDocumentId;
      }

      if (filter.provisional !== undefined) {
        conditions.push('s.provisional = $provisional');
        params.provisional = filter.provisional;
      }

      if (filter.resolved !== undefined) {
        if (filter.resolved) {
          conditions.push('s.resolvedDocumentId IS NOT NULL');
        } else {
          conditions.push('s.resolvedDocumentId IS NULL');
        }
      }

      if (filter.hasEntityTypes !== undefined) {
        if (filter.hasEntityTypes) {
          conditions.push('size(s.entityTypes) > 0');
        } else {
          conditions.push('size(s.entityTypes) = 0');
        }
      }

      if (filter.referenceTags && filter.referenceTags.length > 0) {
        conditions.push('ANY(tag IN $referenceTags WHERE tag IN s.referenceTags)');
        params.referenceTags = filter.referenceTags;
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      // Get total count
      const countResult = await session.run(
        `MATCH (s:Selection) ${whereClause} RETURN count(s) as total`,
        params
      );
      const total = countResult.records[0]!.get('total').toNumber();

      // Get paginated results - ensure integers for Neo4j
      params.skip = neo4j.int(filter.offset || 0);
      params.limit = neo4j.int(filter.limit || 20);

      const result = await session.run(
        `MATCH (s:Selection) ${whereClause}
         RETURN s
         ORDER BY s.updatedAt DESC
         SKIP $skip LIMIT $limit`,
        params
      );

      const selections = result.records.map(record => this.parseSelectionNode(record.get('s')));

      return { selections, total };
    } finally {
      await session.close();
    }
  }

  async getHighlights(documentId: string): Promise<Selection[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (s:Selection {documentId: $documentId})
         WHERE s.selectionCategory = 'highlight'
         RETURN s
         ORDER BY s.createdAt DESC`,
        { documentId }
      );

      return result.records.map(record => this.parseSelectionNode(record.get('s')));
    } finally {
      await session.close();
    }
  }

  async resolveSelection(input: ResolveSelectionInput): Promise<Selection> {
    const session = this.getSession();
    try {
      const now = new Date().toISOString();
      const params: any = {
        selectionId: input.selectionId,
        documentId: input.documentId,
        provisional: input.provisional || false,
        resolvedAt: now,
        updatedAt: now,
      };

      const setClauses = [
        's.resolvedDocumentId = $documentId',
        's.provisional = $provisional',
        's.resolvedAt = datetime($resolvedAt)',
        's.updatedAt = datetime($updatedAt)'
      ];

      if (input.referenceTags) {
        setClauses.push('s.referenceTags = $referenceTags');
        params.referenceTags = input.referenceTags;
      }
      if (input.entityTypes) {
        setClauses.push('s.entityTypes = $entityTypes');
        params.entityTypes = input.entityTypes;
      }
      if (input.confidence !== undefined) {
        setClauses.push('s.confidence = $confidence');
        params.confidence = input.confidence;
      }
      if (input.resolvedBy) {
        setClauses.push('s.resolvedBy = $resolvedBy');
        params.resolvedBy = input.resolvedBy;
      }
      if (input.metadata) {
        setClauses.push('s.metadata = $metadata');
        params.metadata = JSON.stringify(input.metadata);
      }

      // Update selection and create REFERENCES relationship
      const result = await session.run(
        `MATCH (s:Selection {id: $selectionId})
         MATCH (to:Document {id: $documentId})
         SET ${setClauses.join(', ')}
         MERGE (s)-[:REFERENCES]->(to)
         RETURN s`,
        params
      );

      if (result.records.length === 0) {
        throw new Error('Selection not found');
      }

      return this.parseSelectionNode(result.records[0]!.get('s'));
    } finally {
      await session.close();
    }
  }

  async getReferences(documentId: string): Promise<Selection[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (s:Selection {documentId: $documentId})
         WHERE s.selectionCategory IN ['stub_reference', 'resolved_reference']
         RETURN s
         ORDER BY s.createdAt DESC`,
        { documentId }
      );

      return result.records.map(record => this.parseSelectionNode(record.get('s')));
    } finally {
      await session.close();
    }
  }

  async getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Selection[]> {
    const session = this.getSession();
    try {
      let cypher = `MATCH (s:Selection {documentId: $documentId})
                    WHERE s.resolvedDocumentId IS NOT NULL
                    AND size(s.entityTypes) > 0`;

      const params: any = { documentId };

      if (entityTypes && entityTypes.length > 0) {
        cypher += ' AND ANY(type IN $entityTypes WHERE type IN s.entityTypes)';
        params.entityTypes = entityTypes;
      }

      cypher += ' RETURN s ORDER BY s.createdAt DESC';

      const result = await session.run(cypher, params);

      return result.records.map(record => this.parseSelectionNode(record.get('s')));
    } finally {
      await session.close();
    }
  }

  async getDocumentSelections(documentId: string): Promise<Selection[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (s:Selection {documentId: $documentId})
         RETURN s
         ORDER BY s.createdAt DESC`,
        { documentId }
      );

      return result.records.map(record => this.parseSelectionNode(record.get('s')));
    } finally {
      await session.close();
    }
  }

  async getDocumentReferencedBy(documentId: string): Promise<Selection[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (s:Selection {resolvedDocumentId: $documentId})
         RETURN s
         ORDER BY s.createdAt DESC`,
        { documentId }
      );

      return result.records.map(record => this.parseSelectionNode(record.get('s')));
    } finally {
      await session.close();
    }
  }

  async getDocumentConnections(documentId: string): Promise<GraphConnection[]> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (d:Document {id: $documentId})
         OPTIONAL MATCH (d)<-[:BELONGS_TO]-(s1:Selection)-[:REFERENCES]->(other:Document)
         OPTIONAL MATCH (other)<-[:BELONGS_TO]-(s2:Selection)-[:REFERENCES]->(d)
         WITH other, COLLECT(DISTINCT s1) as outgoing, COLLECT(DISTINCT s2) as incoming
         WHERE other IS NOT NULL
         RETURN other, outgoing, incoming`,
        { documentId }
      );

      const connections: GraphConnection[] = [];

      for (const record of result.records) {
        const targetDocument = this.parseDocumentNode(record.get('other'));
        const outgoing = record.get('outgoing').map((s: any) => this.parseSelectionNode(s));
        const incoming = record.get('incoming').map((s: any) => this.parseSelectionNode(s));

        connections.push({
          targetDocument,
          selections: outgoing,
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

        // Get selection details for the relationships
        const selectionIds = rels.map((rel: any) => rel.properties.id).filter((id: any) => id);
        const selections: Selection[] = [];

        if (selectionIds.length > 0) {
          const selResult = await session.run(
            'MATCH (s:Selection) WHERE s.id IN $ids RETURN s',
            { ids: selectionIds }
          );
          selResult.records.forEach(rec => {
            selections.push(this.parseSelectionNode(rec.get('s')));
          });
        }

        paths.push({
          documents: docs,
          selections: selections
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
    selectionCount: number;
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

      // Get selection counts
      const selCountResult = await session.run('MATCH (s:Selection) RETURN count(s) as count');
      const selectionCount = selCountResult.records[0]!.get('count').toNumber();

      const highlightCountResult = await session.run(
        'MATCH (s:Selection) WHERE s.resolvedDocumentId IS NULL RETURN count(s) as count'
      );
      const highlightCount = highlightCountResult.records[0]!.get('count').toNumber();

      const referenceCountResult = await session.run(
        'MATCH (s:Selection) WHERE s.resolvedDocumentId IS NOT NULL RETURN count(s) as count'
      );
      const referenceCount = referenceCountResult.records[0]!.get('count').toNumber();

      const entityRefCountResult = await session.run(
        'MATCH (s:Selection) WHERE s.resolvedDocumentId IS NOT NULL AND size(s.entityTypes) > 0 RETURN count(s) as count'
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
         RETURN d.contentType as type, count(*) AS count`
      );

      const contentTypes: Record<string, number> = {};
      contentTypeResult.records.forEach(record => {
        contentTypes[record.get('type')] = record.get('count').toNumber();
      });

      return {
        documentCount,
        selectionCount,
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

  async createSelections(inputs: CreateSelectionInput[]): Promise<Selection[]> {
    const results: Selection[] = [];
    for (const input of inputs) {
      results.push(await this.createSelection(input));
    }
    return results;
  }

  async resolveSelections(inputs: ResolveSelectionInput[]): Promise<Selection[]> {
    const results: Selection[] = [];
    for (const input of inputs) {
      results.push(await this.resolveSelection(input));
    }
    return results;
  }

  async detectSelections(_documentId: string): Promise<Selection[]> {
    // This would use AI/ML to detect selections in a document
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

  async getReferenceTypes(): Promise<string[]> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    return Array.from(this.referenceTypesCollection!).sort();
  }

  async addEntityType(tag: string): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    this.entityTypesCollection!.add(tag);
    await this.persistTagCollection('entity-types', this.entityTypesCollection!);
  }

  async addReferenceType(tag: string): Promise<void> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    this.referenceTypesCollection!.add(tag);
    await this.persistTagCollection('reference-types', this.referenceTypesCollection!);
  }

  async addEntityTypes(tags: string[]): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.entityTypesCollection!.add(tag));
    await this.persistTagCollection('entity-types', this.entityTypesCollection!);
  }

  async addReferenceTypes(tags: string[]): Promise<void> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.referenceTypesCollection!.add(tag));
    await this.persistTagCollection('reference-types', this.referenceTypesCollection!);
  }

  private async initializeTagCollections(): Promise<void> {
    const session = this.getSession();
    try {
      // Load existing collections from Neo4j
      const result = await session.run(
        'MATCH (t:TagCollection) RETURN t.type as type, t.tags as tags'
      );

      let entityTypesFromDb: string[] = [];
      let referenceTypesFromDb: string[] = [];

      result.records.forEach(record => {
        const type = record.get('type');
        const tags = record.get('tags') || [];

        if (type === 'entity-types') {
          entityTypesFromDb = tags;
        } else if (type === 'reference-types') {
          referenceTypesFromDb = tags;
        }
      });

      // Load defaults
      const { DEFAULT_ENTITY_TYPES, DEFAULT_REFERENCE_TYPES } = await import('../tag-collections');

      // Merge with defaults
      this.entityTypesCollection = new Set([...DEFAULT_ENTITY_TYPES, ...entityTypesFromDb]);
      this.referenceTypesCollection = new Set([...DEFAULT_REFERENCE_TYPES, ...referenceTypesFromDb]);

      // Persist merged collections back to Neo4j
      await this.persistTagCollection('entity-types', this.entityTypesCollection);
      await this.persistTagCollection('reference-types', this.referenceTypesCollection);
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
      this.referenceTypesCollection = null;
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
    if (!props.contentType) throw new Error(`Document ${props.id} missing required field: contentType`);
    if (!props.metadata) throw new Error(`Document ${props.id} missing required field: metadata`);
    if (props.archived === undefined || props.archived === null) throw new Error(`Document ${props.id} missing required field: archived`);
    if (!props.createdAt) throw new Error(`Document ${props.id} missing required field: createdAt`);
    if (!props.createdBy) throw new Error(`Document ${props.id} missing required field: createdBy`);
    if (!props.creationMethod) throw new Error(`Document ${props.id} missing required field: creationMethod`);
    if (!props.contentChecksum) throw new Error(`Document ${props.id} missing required field: contentChecksum`);

    return {
      id: props.id,
      name: props.name,
      entityTypes: props.entityTypes,
      contentType: props.contentType,
      metadata: JSON.parse(props.metadata),
      archived: props.archived,
      createdAt: new Date(props.createdAt.toString()),
      createdBy: props.createdBy,
      creationMethod: props.creationMethod,
      contentChecksum: props.contentChecksum,
      sourceSelectionId: props.sourceSelectionId,
      sourceDocumentId: props.sourceDocumentId,
    };
  }

  private parseSelectionNode(node: any): Selection {
    const props = node.properties;

    // Validate required fields
    if (!props.id) throw new Error('Selection missing required field: id');
    if (!props.documentId) throw new Error(`Selection ${props.id} missing required field: documentId`);
    if (!props.selectionType) throw new Error(`Selection ${props.id} missing required field: selectionType`);
    if (!props.selectionData) throw new Error(`Selection ${props.id} missing required field: selectionData`);
    if (props.provisional === undefined || props.provisional === null) throw new Error(`Selection ${props.id} missing required field: provisional`);
    if (!props.createdAt) throw new Error(`Selection ${props.id} missing required field: createdAt`);
    if (!props.updatedAt) throw new Error(`Selection ${props.id} missing required field: updatedAt`);

    const selection: Selection = {
      id: props.id,
      documentId: props.documentId,
      selectionType: props.selectionType,
      selectionData: JSON.parse(props.selectionData),
      provisional: props.provisional,
      createdAt: new Date(props.createdAt.toString()),
      updatedAt: new Date(props.updatedAt.toString()),
    };

    if (props.resolvedDocumentId) selection.resolvedDocumentId = props.resolvedDocumentId;
    if (props.resolvedAt) selection.resolvedAt = new Date(props.resolvedAt.toString());
    if (props.referenceTags?.length > 0) selection.referenceTags = props.referenceTags;
    if (props.entityTypes?.length > 0) selection.entityTypes = props.entityTypes;
    if (props.confidence !== null) selection.confidence = props.confidence;
    if (props.metadata) selection.metadata = JSON.parse(props.metadata);
    if (props.createdBy) selection.createdBy = props.createdBy;
    if (props.resolvedBy) selection.resolvedBy = props.resolvedBy;

    return selection;
  }
}