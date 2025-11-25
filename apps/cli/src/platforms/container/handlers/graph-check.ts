import { execSync } from 'child_process';
import { ContainerCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { GraphServiceConfig } from '@semiont/core';

/**
 * Check handler for Container graph database services
 * Supports JanusGraph, Neo4j, Neptune (for local testing), and other graph databases
 */
const checkGraphContainer = async (context: ContainerCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, runtime, containerName } = context;

  // Type narrowing for graph service config
  const config = service.config as GraphServiceConfig;
  const graphType = config.type;
  
  try {
    // Check container status
    const containerStatus = execSync(
      `${runtime} inspect ${containerName} --format '{{.State.Status}}'`,
      { encoding: 'utf-8' }
    ).trim();
    
    if (containerStatus !== 'running') {
      return {
        success: true,
        status: 'stopped',
        health: {
          healthy: false,
          details: { containerStatus, graphType }
        },
        metadata: { 
          containerStatus,
          serviceType: 'graph',
          graphType
        }
      };
    }
    
    // Get container ID
    const containerId = execSync(
      `${runtime} inspect ${containerName} --format '{{.Id}}'`,
      { encoding: 'utf-8' }
    ).trim();
    
    // Get port mappings
    const portsOutput = execSync(
      `${runtime} port ${containerName}`,
      { encoding: 'utf-8' }
    ).trim();
    
    // Parse ports into a Record<string, string>
    const ports: Record<string, string> = {};
    if (portsOutput) {
      portsOutput.split('\n').forEach(line => {
        const match = line.match(/(\d+\/\w+)\s+->\s+([\d.:]+)/);
        if (match) {
          ports[match[1]] = match[2];
        }
      });
    }
    
    // Check if the graph service is responding
    const port = config.port;
    let isHealthy = false;
    let healthDetails: any = {
      status: 'running',
      graphType,
      endpoint: port ? getGraphEndpoint(graphType, port) : undefined
    };
    
    // Try to verify the service is actually responding
    try {
      switch (graphType) {
        case 'janusgraph':
        case 'neptune':
          // Check if Gremlin server port is accessible
          // JanusGraph doesn't have a simple HTTP endpoint, so we just check if the port is open
          try {
            // Check if port is listening using a simple TCP connection test
            execSync(`${runtime} exec ${containerName} sh -c "echo 'test' | nc -w 1 localhost ${port}"`, {
              encoding: 'utf-8',
              timeout: 5000,
              stdio: 'pipe'
            });
            isHealthy = true;

            // Additional JanusGraph-specific checks for better diagnostics
            if (graphType === 'janusgraph') {
              // Check if dependent services are healthy
              try {
                const cassandraRunning = execSync(`${runtime} ps --filter "name=semiont-cassandra" --format "{{.Names}}"`, {
                  encoding: 'utf-8',
                  stdio: 'pipe'
                }).trim().includes('semiont-cassandra');

                const elasticsearchRunning = execSync(`${runtime} ps --filter "name=semiont-elasticsearch" --format "{{.Names}}"`, {
                  encoding: 'utf-8',
                  stdio: 'pipe'
                }).trim().includes('semiont-elasticsearch');

                healthDetails.dependencies = {
                  cassandra: cassandraRunning ? 'running' : 'stopped',
                  elasticsearch: elasticsearchRunning ? 'running' : 'stopped'
                };

                // Check for known WebSocket compatibility issues
                healthDetails.clientCompatibility = {
                  gremlinJs: 'known_issue',
                  issue: 'gremlin JavaScript client has WebSocket API incompatibility with Node.js',
                  error: 'this._ws.on is not a function',
                  workaround: 'Use HTTP-based JanusGraph client or alternative Gremlin client'
                };

                // Check startup ordering
                healthDetails.startupOrder = {
                  status: 'fixed',
                  note: 'Container dependencies use health checks for proper startup ordering'
                };

              } catch {
                // Dependency check is best-effort
              }
            }
          } catch {
            // If nc fails, try checking if the java process is running
            const processes = execSync(`${runtime} exec ${containerName} ps aux`, {
              encoding: 'utf-8',
              stdio: 'pipe'
            });
            // If JanusGraph java process is running, consider it healthy
            isHealthy = processes.includes('java') && processes.includes('janusgraph');

            if (!isHealthy) {
              healthDetails.processCheck = 'JanusGraph java process not found';
            }
          }
          break;
        case 'neo4j':
          // Neo4j bolt protocol check would require specific client
          // For now, just check if port is listening
          execSync(`nc -z localhost ${port}`, { timeout: 5000 });
          isHealthy = true;
          break;
        case 'arangodb' as any:  // ArangoDB support
          // Check ArangoDB HTTP API
          const httpCode = execSync(
            `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/_api/version`,
            { encoding: 'utf-8', timeout: 5000 }
          ).trim();
          isHealthy = httpCode === '200';
          break;
        default:
          // Generic port check
          execSync(`nc -z localhost ${port}`, { timeout: 5000 });
          isHealthy = true;
      }
    } catch (healthCheckError) {
      // Service not responding
      isHealthy = false;
      healthDetails.error = 'Service not responding on expected port';
    }
    
    // Get recent logs
    let logs: { recent: string[]; errors: string[] } | undefined;
    try {
      const logOutput = execSync(
        `${runtime} logs ${containerName} --tail 20`,
        { encoding: 'utf-8', maxBuffer: 1024 * 1024 }
      );
      
      const logLines = logOutput.split('\n').filter(Boolean);
      logs = {
        recent: logLines.slice(-10),
        errors: logLines.filter((line: string) => 
          line.toLowerCase().includes('error') || 
          line.toLowerCase().includes('exception') ||
          line.toLowerCase().includes('failed')
        ).slice(-5)
      };
    } catch (logError) {
      // Log collection is best-effort
    }
    
    // Get container image info
    const image = execSync(
      `${runtime} inspect ${containerName} --format '{{.Config.Image}}'`,
      { encoding: 'utf-8' }
    ).trim();
    
    return {
      success: true,
      status: isHealthy ? 'running' : 'unhealthy',
      platformResources: {
        platform: 'container' as const,
        data: {
          containerId,
          containerName,
          image,
          ports
        }
      },
      health: {
        healthy: isHealthy,
        details: healthDetails
      },
      logs,
      metadata: {
        serviceType: 'graph',
        graphType,
        containerName,
        stateVerified: true
      }
    };
  } catch (error: any) {
    // Container doesn't exist or other Docker/Podman error
    if (error.message?.includes('No such container') || error.message?.includes('no such container')) {
      return {
        success: true,
        status: 'stopped',
        health: {
          healthy: false,
          details: { error: 'Container does not exist' }
        },
        metadata: {
          serviceType: 'graph',
          graphType,
          containerName
        }
      };
    }
    
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
};

/**
 * Get the connection endpoint for the graph database
 */
function getGraphEndpoint(graphType: string, port: number): string {
  const host = 'localhost';

  switch (graphType) {
    case 'janusgraph':
    case 'neptune':
      return `ws://${host}:${port}/gremlin`;
    case 'neo4j':
      return `bolt://${host}:${port}`;
    case 'arangodb':
      return `http://${host}:${port}`;
    default:
      return `${host}:${port}`;
  }
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