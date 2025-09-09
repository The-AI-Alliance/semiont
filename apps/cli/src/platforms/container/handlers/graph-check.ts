import { DockerUtils } from '../docker-utils.js';
import { ContainerCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for Container graph database services
 * Supports JanusGraph, Neo4j, Neptune (for local testing), and other graph databases
 */
const checkGraphContainer = async (context: ContainerCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const docker = await DockerUtils.getInstance();
  const requirements = service.getRequirements();
  const graphType = service.config.type || 'janusgraph';
  
  // Container naming
  const containerName = `${service.environment}_graph`;
  const container = docker.getContainer(containerName);
  
  let status: 'running' | 'stopped' | 'unhealthy' = 'stopped';
  let health: any = { healthy: false };
  let logs: { recent: string[]; errors: string[] } | undefined;
  let platformResources: any = undefined;
  
  try {
    const containerInfo = await container.inspect();
    const isRunning = containerInfo.State.Running;
    
    if (isRunning) {
      status = 'running';
      
      // Get container health status if available
      if (containerInfo.State.Health) {
        const healthStatus = containerInfo.State.Health.Status;
        health = {
          healthy: healthStatus === 'healthy',
          details: {
            status: healthStatus,
            checks: containerInfo.State.Health.Log?.slice(-1)[0],
            graphType,
            endpoint: getGraphEndpoint(graphType, requirements.network?.ports?.[0])
          }
        };
        
        if (healthStatus === 'unhealthy') {
          status = 'unhealthy';
        }
      } else {
        // No health check configured, just check if running
        health = {
          healthy: true,
          details: {
            status: 'running',
            graphType,
            endpoint: getGraphEndpoint(graphType, requirements.network?.ports?.[0])
          }
        };
      }
      
      // Get container resource info
      platformResources = {
        platform: 'container' as const,
        data: {
          containerId: containerInfo.Id,
          containerName,
          image: containerInfo.Config.Image,
          ports: containerInfo.NetworkSettings?.Ports,
          graphType
        }
      };
      
      // Get recent logs
      try {
        const logStream = await container.logs({
          stdout: true,
          stderr: true,
          tail: 20,
          timestamps: true
        });
        
        const logLines = logStream.toString().split('\n').filter(Boolean);
        logs = {
          recent: logLines.slice(-10),
          errors: logLines.filter(line => 
            line.toLowerCase().includes('error') || 
            line.toLowerCase().includes('exception') ||
            line.toLowerCase().includes('failed')
          ).slice(-5)
        };
      } catch (logError) {
        // Log collection is best-effort
      }
    }
  } catch (error: any) {
    // Container doesn't exist or other Docker error
    if (error.statusCode !== 404) {
      return {
        success: false,
        error: `Failed to check graph container: ${error.message}`,
        status: 'stopped',
        metadata: {
          serviceType: 'graph',
          graphType
        }
      };
    }
  }
  
  return {
    success: true,
    status,
    platformResources,
    health,
    logs,
    metadata: {
      serviceType: 'graph',
      graphType,
      containerName,
      stateVerified: true
    }
  };
};

/**
 * Get the connection endpoint for the graph database
 */
function getGraphEndpoint(graphType: string, port?: number): string {
  const host = 'localhost';
  const actualPort = port || getDefaultPort(graphType);
  
  switch (graphType) {
    case 'janusgraph':
    case 'neptune':
      return `ws://${host}:${actualPort}/gremlin`;
    case 'neo4j':
      return `bolt://${host}:${actualPort}`;
    case 'arangodb':
      return `http://${host}:${actualPort}`;
    default:
      return `${host}:${actualPort}`;
  }
}

function getDefaultPort(graphType: string): number {
  const ports: Record<string, number> = {
    janusgraph: 8182,
    neo4j: 7687,
    neptune: 8182,
    arangodb: 8529
  };
  return ports[graphType] || 8182;
}

/**
 * Descriptor for Container graph check handler
 */
export const graphCheckDescriptor: HandlerDescriptor<ContainerCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'container',
  serviceType: 'graph',
  handler: checkGraphContainer
};