/**
 * Service Discovery Types
 *
 * Type definitions for service names, selectors, and capabilities.
 * Service availability is derived from EnvironmentConfig.services (populated by the TOML loader).
 */

import type { CommandName } from './handlers/types.js';

export type ServiceName = string;
export type ServiceSelector = 'all' | ServiceName;
export type ServiceCapability = CommandName;
