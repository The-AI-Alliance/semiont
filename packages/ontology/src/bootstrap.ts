/**
 * Entity Types Bootstrap - moved to backend
 *
 * NOTE: The bootstrap service has been moved back to apps/backend/src/bootstrap/entity-types-bootstrap.ts
 * to avoid circular dependency between @semiont/ontology and @semiont/core.
 *
 * Only DEFAULT_ENTITY_TYPES is exported from this package.
 * The bootstrap logic depends on EnvironmentConfig from @semiont/core and EventStore from backend,
 * so it belongs in the backend, not in the ontology package.
 */

export { DEFAULT_ENTITY_TYPES } from './entity-types';
