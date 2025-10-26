/**
 * Document input/output types
 */

import type { components } from '@semiont/api-client';
import type { CreationMethod } from './creation-methods';

type ContentFormat = components['schemas']['ContentFormat'];

export interface CreateDocumentInput {
  name: string;
  entityTypes: string[];
  content: string;
  format: ContentFormat;
  contentChecksum: string;
  creator: components['schemas']['Agent'];
  creationMethod: CreationMethod;
  sourceAnnotationId?: string;
  sourceDocumentId?: string;
}

export interface UpdateDocumentInput {
  name?: string;
  entityTypes?: string[];
  archived?: boolean;
}

export interface DocumentFilter {
  entityTypes?: string[];
  search?: string;
  limit?: number;
  offset?: number;
}
