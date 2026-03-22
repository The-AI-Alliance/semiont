/**
 * Service Discovery Types
 *
 * Type definitions for service names, selectors, and capabilities.
 * Service availability is derived from EnvironmentConfig.services (populated by the TOML loader).
 */

export type ServiceName = string;
export type ServiceSelector = 'all' | ServiceName;
export type ServiceCapability = string;
