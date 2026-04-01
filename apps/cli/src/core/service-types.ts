/**
 * Service Types
 * 
 * High-level service types that describe what a service does,
 * not how it's implemented. Platforms map these types to their
 * specific implementations (e.g., frontend → S3+CloudFront on AWS).
 */

/**
 * Core service types that describe service behavior
 */
export const SERVICE_TYPES = {
  // Application layer
  FRONTEND: 'frontend',      // User interfaces, static sites, SPAs
  BACKEND: 'backend',        // API servers, business logic, microservices
  
  // Data layer
  DATABASE: 'database',      // Persistent data storage (SQL, NoSQL)
  GRAPH: 'graph',           // Graph databases, knowledge graphs
  
  // Compute layer
  WORKER: 'worker',         // Background jobs, async processing, queues
  INFERENCE: 'inference',   // ML model serving, AI inference endpoints
  
  // Special protocols
  MCP: 'mcp',              // Model Context Protocol servers
  
  // Infrastructure
  STACK: 'stack',          // Infrastructure stacks (CloudFormation, Terraform)
  FILESYSTEM: 'filesystem', // Shared/persistent file storage (EFS, NFS, etc.)
} as const;

/**
 * Type for service types
 */
export type ServiceType = typeof SERVICE_TYPES[keyof typeof SERVICE_TYPES];

/**
 * Check if a string is a valid service type
 */
export function isValidServiceType(type: string): type is ServiceType {
  return Object.values(SERVICE_TYPES).includes(type as ServiceType);
}

/**
 * Get service type from annotations with validation
 */
export function getServiceTypeFromAnnotations(
  annotations?: Record<string, string>
): ServiceType | undefined {
  const type = annotations?.['service/type'];
  if (type && isValidServiceType(type)) {
    return type;
  }
  return undefined;
}

/**
 * Service type annotation key
 */
export const SERVICE_TYPE_ANNOTATION = 'service/type' as const;