/**
 * Service Requirements Interface
 * 
 * Platform-agnostic way for services to declare their infrastructure needs.
 * Platforms fulfill these requirements without knowing what service they're deploying.
 */

import { ServiceName } from './services.js';

/**
 * Storage requirements for persistent data
 */
export interface StorageRequirement {
  persistent: boolean;
  volumeName?: string;
  size?: string;         // e.g., "10Gi", "100GB"
  mountPath?: string;    // e.g., "/var/lib/postgresql/data"
  type?: 'volume' | 'bind' | 'tmpfs';
  backupEnabled?: boolean;
}

/**
 * Network requirements for service connectivity
 */
export interface NetworkRequirement {
  ports: number[];
  protocol?: 'tcp' | 'udp';
  needsLoadBalancer?: boolean;
  customDomains?: string[];
  healthCheckPath?: string;
  healthCheckPort?: number;
  healthCheckInterval?: number;
}

/**
 * Dependencies on other services or external resources
 */
export interface DependencyRequirement {
  services: ServiceName[];
  external?: {
    name: string;
    url?: string;
    required: boolean;
    healthCheck?: string;
  }[];
  startupOrder?: ServiceName[];  // Explicit ordering if needed
}

/**
 * Resource allocation requirements
 */
export interface ResourceRequirement {
  cpu?: string;        // e.g., "0.5", "2", "100m"
  memory?: string;     // e.g., "512Mi", "2Gi", "256MB"
  replicas?: number;
  gpus?: number;
  ephemeralStorage?: string;
}

/**
 * Build requirements for services that need compilation/building
 */
export interface BuildRequirement {
  dockerfile?: string;
  buildContext?: string;
  buildArgs?: Record<string, string>;
  prebuilt?: boolean;  // Use pre-built image
  cacheBust?: string[];  // Files that invalidate cache
  target?: string;  // Multi-stage build target
}

/**
 * Security and secrets requirements
 */
export interface SecurityRequirement {
  secrets?: string[];  // Names of required secrets
  runAsUser?: number;
  runAsGroup?: number;
  readOnlyRootFilesystem?: boolean;
  allowPrivilegeEscalation?: boolean;
  capabilities?: {
    add?: string[];
    drop?: string[];
  };
}

/**
 * Complete service requirements specification
 */
export interface ServiceRequirements {
  storage?: StorageRequirement[];
  network?: NetworkRequirement;
  dependencies?: DependencyRequirement;
  resources?: ResourceRequirement;
  build?: BuildRequirement;
  security?: SecurityRequirement;
  environment?: Record<string, string>;
  labels?: Record<string, string>;  // For metadata/organization
  annotations?: Record<string, string>;  // Platform-specific hints
}

/**
 * Type guard to check if an object has service requirements
 */
export function hasServiceRequirements(obj: any): obj is { getRequirements(): ServiceRequirements } {
  return typeof obj?.getRequirements === 'function';
}

/**
 * Merge multiple requirement sets (useful for composition)
 */
export function mergeRequirements(...requirements: Partial<ServiceRequirements>[]): ServiceRequirements {
  const merged: ServiceRequirements = {};
  
  for (const req of requirements) {
    if (req.storage) {
      merged.storage = [...(merged.storage || []), ...req.storage];
    }
    
    if (req.network) {
      merged.network = {
        ...merged.network,
        ...req.network,
        ports: [...(merged.network?.ports || []), ...(req.network.ports || [])]
      };
    }
    
    if (req.dependencies) {
      merged.dependencies = {
        services: [...(merged.dependencies?.services || []), ...(req.dependencies.services || [])],
        external: [...(merged.dependencies?.external || []), ...(req.dependencies.external || [])]
      };
    }
    
    if (req.resources) {
      merged.resources = { ...merged.resources, ...req.resources };
    }
    
    if (req.build) {
      merged.build = { ...merged.build, ...req.build };
    }
    
    if (req.security) {
      merged.security = {
        ...merged.security,
        ...req.security,
        secrets: [...(merged.security?.secrets || []), ...(req.security.secrets || [])]
      };
    }
    
    if (req.environment) {
      merged.environment = { ...merged.environment, ...req.environment };
    }
    
    if (req.labels) {
      merged.labels = { ...merged.labels, ...req.labels };
    }
    
    if (req.annotations) {
      merged.annotations = { ...merged.annotations, ...req.annotations };
    }
  }
  
  return merged;
}

/**
 * Common requirement presets for typical service types
 */
export const RequirementPresets = {
  statefulDatabase: (): Partial<ServiceRequirements> => ({
    storage: [{
      persistent: true,
      type: 'volume',
      backupEnabled: true
    }],
    security: {
      readOnlyRootFilesystem: false,
      allowPrivilegeEscalation: false
    }
  }),
  
  statelessApi: (): Partial<ServiceRequirements> => ({
    network: {
      ports: [3000],
      needsLoadBalancer: true,
      healthCheckPath: '/health',
      protocol: 'tcp'
    },
    resources: {
      replicas: 2
    },
    security: {
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false
    }
  }),
  
  webFrontend: (): Partial<ServiceRequirements> => ({
    network: {
      ports: [80, 443],
      needsLoadBalancer: true,
      protocol: 'tcp'
    },
    build: {
      prebuilt: false
    }
  }),
  
  backgroundWorker: (): Partial<ServiceRequirements> => ({
    resources: {
      replicas: 1
    },
    security: {
      allowPrivilegeEscalation: false
    }
  }),
  
  serverlessFunction: (): Partial<ServiceRequirements> => ({
    resources: {
      memory: '256Mi',
      cpu: '0.25',
      replicas: 0  // Scale to zero when not in use
    },
    annotations: {
      'serverless': 'true',
      'scaling/min': '0',
      'scaling/max': '100',
      'timeout': '30',
      'cold-start': 'true'
    },
    security: {
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false
    }
  })
};