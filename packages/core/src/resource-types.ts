/**
 * Resource input/output types
 */

export interface UpdateResourceInput {
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
