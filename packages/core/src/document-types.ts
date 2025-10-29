/**
 * Resource input/output types
 */

export interface UpdateDocumentInput {
  name?: string;
  entityTypes?: string[];
  archived?: boolean;
}

export interface ResourceFilter {
  entityTypes?: string[];
  search?: string;
  limit?: number;
  offset?: number;
}
