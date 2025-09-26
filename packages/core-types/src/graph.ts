/**
 * Graph types - Models for graph connections and relationships
 */

import { Document } from './document';
import { Selection } from './selection';

/**
 * Represents a connection between documents through selections
 */
export interface GraphConnection {
  targetDocument: Document;
  selections: Selection[];
  relationshipType?: string;
  bidirectional: boolean;
}

/**
 * Represents a path through the graph
 */
export interface GraphPath {
  documents: Document[];
  selections: Selection[];
}

/**
 * Statistics about entity types in the graph
 */
export interface EntityTypeStats {
  type: string;
  count: number;
}