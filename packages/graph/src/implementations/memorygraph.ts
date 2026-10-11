// A graph held in memory, for a test of something that reads the graph.
//
// It is given what it holds when it is made, and nothing writes to it after:
// the one writer of the graph is the Weaver, and the Weaver is not in this
// package. An annotation is held as the codec says the graph holds one, so
// what a Map hands back is what Cypher and Gremlin hand back: a test that
// reads from here reads no field a database would not have.

import { GraphDatabase } from '../interface';
import { queryResources } from '../resource-query';
import type {
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  ResourceFilter,
  ResourceId,
  AnnotationId,
} from '@semiont/core';
import { getBodySource, getTargetSource, getResourceId, getPrimaryRepresentation, getResourceEntityTypes } from '@semiont/core';
import { getEntityTypes } from '@semiont/core';
import { intendedGraphAnnotation } from '../annotation-codec';
import type { ResourceDescriptor } from '@semiont/core';
import type { Annotation } from '@semiont/core';

export class MemoryGraphDatabase implements GraphDatabase {
  private connected: boolean = false;

  private resources: Map<string, ResourceDescriptor> = new Map();
  private annotations: Map<string, Annotation> = new Map();

  /**
   * `resources` are held as given: each is a resource as the Weaver gives one
   * to the graph. `annotations` are given as the record holds them, and held
   * as the graph does.
   */
  constructor(held: { resources: ResourceDescriptor[]; annotations: Annotation[] }) {
    for (const resource of held.resources) {
      const id = getResourceId(resource);
      if (!id) {
        throw new Error('Resource must have an id');
      }
      this.resources.set(id, resource);
    }
    for (const annotation of held.annotations) {
      this.annotations.set(annotation.id, intendedGraphAnnotation(annotation));
    }
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getResource(id: ResourceId): Promise<ResourceDescriptor | null> {
    return this.resources.get(String(id)) || null;
  }

  async listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }> {
    return queryResources(Array.from(this.resources.values()), filter);
  }

  async getAnnotation(id: AnnotationId): Promise<Annotation | null> {
    return this.annotations.get(id) || null;
  }

  private async getReferences(resourceId: ResourceId): Promise<Annotation[]> {
    const resourceIdStr = String(resourceId);
    return Array.from(this.annotations.values())
      .filter(sel => getTargetSource(sel.target) === resourceIdStr && sel.motivation === 'linking');
  }

  async getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]> {
    const resourceIdStr = String(resourceId);
    return Array.from(this.annotations.values())
      .filter(sel => getTargetSource(sel.target) === resourceIdStr);
  }

  async getResourceReferencedBy(resourceId: ResourceId, _motivation?: string): Promise<Annotation[]> {
    return Array.from(this.annotations.values())
      .filter(sel => getBodySource(sel.body) === String(resourceId));
  }

  async getResourceConnections(resourceId: ResourceId): Promise<GraphConnection[]> {
    const connections: GraphConnection[] = [];
    const refs = await this.getReferences(resourceId);
    const resourceIdStr = String(resourceId);

    for (const ref of refs) {
      const bodySource = getBodySource(ref.body);
      if (bodySource) {
        const targetDoc = await this.getResource(bodySource);
        if (targetDoc) {
          const reverseRefs = await this.getReferences(bodySource);
          const bidirectional = reverseRefs.some(r => getBodySource(r.body) === resourceIdStr);

          connections.push({
            targetResource: targetDoc,
            annotations: [ref],
            bidirectional,
          });
        }
      }
    }

    return connections;
  }

  async findPath(fromResourceId: ResourceId, toResourceId: ResourceId, maxDepth: number = 5): Promise<GraphPath[]> {
    const visited = new Set<ResourceId>();
    const queue: { docId: ResourceId; path: ResourceDescriptor[]; sels: Annotation[] }[] = [];
    const fromDoc = await this.getResource(fromResourceId);

    if (!fromDoc) return [];

    queue.push({ docId: fromResourceId, path: [fromDoc], sels: [] });
    visited.add(fromResourceId);

    const paths: GraphPath[] = [];

    while (queue.length > 0 && paths.length < 10) {
      const { docId, path, sels } = queue.shift()!;

      if (path.length > maxDepth) continue;

      if (docId === toResourceId) {
        paths.push({ resources: path, annotations: sels });
        continue;
      }

      const connections = await this.getResourceConnections(docId);

      for (const conn of connections) {
        const targetId = getResourceId(conn.targetResource);
        if (targetId && !visited.has(targetId)) {
          visited.add(targetId);
          queue.push({
            docId: targetId,
            path: [...path, conn.targetResource],
            sels: [...sels, ...conn.annotations],
          });
        }
      }
    }

    return paths;
  }

  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    const typeCounts = new Map<string, number>();

    for (const doc of this.resources.values()) {
      const types = getResourceEntityTypes(doc);
      for (const type of types) {
        typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
      }
    }

    return Array.from(typeCounts.entries()).map(([type, count]) => ({
      type,
      count,
    }));
  }

  async getStats(): Promise<{
    resourceCount: number;
    annotationCount: number;
    highlightCount: number;
    referenceCount: number;
    entityReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  }> {
    const entityTypes: Record<string, number> = {};
    const contentTypes: Record<string, number> = {};

    for (const doc of this.resources.values()) {
      for (const type of doc.entityTypes || []) {
        entityTypes[type] = (entityTypes[type] || 0) + 1;
      }
      const primaryRep = getPrimaryRepresentation(doc);
      if (primaryRep?.mediaType) {
        contentTypes[primaryRep.mediaType] = (contentTypes[primaryRep.mediaType] || 0) + 1;
      }
    }

    const annotations = Array.from(this.annotations.values());
    // Use motivation to distinguish types
    const highlightCount = annotations.filter(a => a.motivation === 'highlighting').length;
    const referenceCount = annotations.filter(a => a.motivation === 'linking').length;
    // Extract entity types from annotation body
    const entityReferenceCount = annotations.filter(
      a => a.motivation === 'linking' && getEntityTypes(a).length > 0
    ).length;

    return {
      resourceCount: this.resources.size,
      annotationCount: this.annotations.size,
      highlightCount,
      referenceCount,
      entityReferenceCount,
      entityTypes,
      contentTypes,
    };
  }
}
