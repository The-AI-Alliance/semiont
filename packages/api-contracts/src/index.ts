/**
 * @semiont/api-contracts
 *
 * API contracts and schemas for Semiont
 * Request and response DTOs for type-safe API communication
 */

// Request schemas
export * from './requests/document';
export * from './requests/selection';

// Response schemas
export * from './responses/common';
export * from './responses/document';
export * from './responses/selection';

// Legacy exports (for backward compatibility)
export * from './auth';
export * from './common';
export * from './user';

// Version information
export const API_CONTRACTS_VERSION = '0.1.0';
export const API_TYPES_VERSION = '0.1.0'; // Backward compatibility