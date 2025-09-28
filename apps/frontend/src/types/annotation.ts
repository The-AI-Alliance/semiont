// Base annotation interface
export interface BaseAnnotation {
  id: string;
  type: 'highlight' | 'reference';
}

// Highlight annotation
export interface HighlightAnnotation extends BaseAnnotation {
  type: 'highlight';
}

// Reference annotation
export interface ReferenceAnnotation extends BaseAnnotation {
  type: 'reference';
  entityType?: string;
  referenceType?: string;
  resolvedDocumentId?: string;
  resolvedDocumentName?: string;
  provisional?: boolean;
}

// Union type for all annotations
export type Annotation = HighlightAnnotation | ReferenceAnnotation;

// Update types
export interface AnnotationUpdate {
  type?: 'highlight' | 'reference';
  entityType?: string | null;
  referenceType?: string | null;
  resolvedDocumentId?: string | null;
  resolvedDocumentName?: string | null;
  provisional?: boolean;
}

// Selection type
export interface TextSelection {
  text: string;
  start: number;
  end: number;
}