/**
 * Selection types - Core domain model for selections within documents
 *
 * IMPORTANT: We use "resolved" terminology throughout (not "referenced")
 * A selection can be:
 * - Highlight: selection without resolvedDocumentId field
 * - Stub Reference: selection with resolvedDocumentId field but null value
 * - Resolved Reference: selection with non-null resolvedDocumentId value
 * - Entity Reference: resolved reference with entity types
 */

import { ReferenceTag } from './reference-tags';

/**
 * Base selection type - represents any selection within a document
 */
export interface Selection {
  id: string;
  documentId: string;
  selectionData: any;     // Type-specific data (offset, length, coordinates, etc.)

  // Reference fields - presence determines selection type:
  // - Field absent: highlight
  // - Field present with null: stub reference
  // - Field present with value: resolved reference
  resolvedDocumentId?: string | null;
  resolvedAt?: Date;
  resolvedBy?: string;

  // Reference tags - semantic relationship types
  referenceTags?: ReferenceTag[];

  // If resolved document has entity types and selection specifies them
  entityTypes?: string[];  // Specific entity types this selection references

  // Provisional selections are auto-detected
  provisional: boolean;

  metadata?: Record<string, any>;
  createdBy?: string;  // User who created the selection
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for creating a new selection
 */
export interface CreateSelectionInput {
  documentId: string;
  selectionData: any;

  createdBy?: string;

  // Optional - makes it a reference (stub if null, resolved if non-null)
  resolvedDocumentId?: string | null;
  resolvedBy?: string;

  // Optional - semantic relationship tags
  referenceTags?: ReferenceTag[];

  // Optional - makes it an entity reference
  entityTypes?: string[];

  provisional?: boolean;
  metadata?: Record<string, any>;
}

/**
 * Input for resolving a selection to a document
 */
export interface ResolveSelectionInput {
  selectionId: string;
  documentId: string;
  referenceTags?: ReferenceTag[];  // Semantic relationship tags
  entityTypes?: string[];  // Optionally specify which entity types are being referenced
  provisional?: boolean;
  resolvedBy?: string;
  metadata?: Record<string, any>;
}

/**
 * Filter criteria for querying selections
 */
export interface SelectionFilter {
  documentId?: string;
  resolvedDocumentId?: string;
  provisional?: boolean;
  resolved?: boolean;  // Filter for references
  hasEntityTypes?: boolean;  // Filter for entity references
  referenceTags?: ReferenceTag[];  // Filter by reference tags
  limit?: number;
  offset?: number;
}

// Type guards for different selection types

/**
 * Check if a selection is a highlight (no resolvedDocumentId field)
 */
export function isHighlight(selection: Selection): boolean {
  // Highlight = no resolvedDocumentId field at all
  return !('resolvedDocumentId' in selection);
}

/**
 * Check if a selection is a reference (has resolvedDocumentId field)
 */
export function isReference(selection: Selection): boolean {
  // Reference = has resolvedDocumentId field (even if null for stubs)
  return 'resolvedDocumentId' in selection;
}

/**
 * Check if a selection is a stub reference (has resolvedDocumentId field with null value)
 */
export function isStubReference(selection: Selection): boolean {
  return 'resolvedDocumentId' in selection && selection.resolvedDocumentId === null;
}

/**
 * Check if a selection is a resolved reference (has non-null resolvedDocumentId value)
 */
export function isResolvedReference(selection: Selection): boolean {
  return 'resolvedDocumentId' in selection && selection.resolvedDocumentId !== null;
}

/**
 * Check if a selection is an entity reference
 */
export function isEntityReference(selection: Selection): boolean {
  return !!selection.resolvedDocumentId && !!selection.entityTypes && selection.entityTypes.length > 0;
}

/**
 * Check if a selection has reference tags
 */
export function hasReferenceTags(selection: Selection): boolean {
  return !!selection.referenceTags && selection.referenceTags.length > 0;
}