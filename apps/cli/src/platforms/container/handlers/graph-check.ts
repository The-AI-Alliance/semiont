import { execFileSync } from 'child_process';
import { ContainerCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { GraphServiceConfig } from '@semiont/core';
import { checkCommandAvailable, checkContainerRuntime, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Check handler for Container graph database services
 * Supports JanusGraph, Neo4j, Neptune (for local testing), and other graph databases
 */
const checkGraphContainer = async (context: ContainerCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, runtime, containerName } = context;
  const config = service.config as GraphServiceConfig;
  const graphType = config.type;

  try {
    // Check container status
    const containerStatus = execFileSync(
      runtime, ['inspect', containerName, '--format', '{{.State.Status}}'],
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
    const containerId = execFileSync(
      runtime, ['inspect', containerName, '--format', '{{.Id}}'],
      { encoding: 'utf-8' }
    ).trim();

    // Get port mappings
    const portsOutput = execFileSync(
      runtime, ['port', containerName],
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
          try {
            execFileSync(
              runtime, ['exec', containerName, 'sh', '-c', `echo 'test' | nc -w 1 localhost ${port}`],
              { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }
            );
            isHealthy = true;

            if (graphType === 'janusgraph') {
              try {
                const cassandraRunning = execFileSync(
                  runtime, ['ps', '--filter', 'name=semiont-cassandra', '--format', '{{.Names}}'],
                  { encoding: 'utf-8', stdio: 'pipe' }
                ).trim().includes('semiont-cassandra');

                const elasticsearchRunning = execFileSync(
                  runtime, ['ps', '--filter', 'name=semiont-elasticsearch', '--format', '{{.Names}}'],
                  { encoding: 'utf-8', stdio: 'pipe' }
                ).trim().includes('semiont-elasticsearch');

                healthDetails.dependencies = {
                  cassandra: cassandraRunning ? 'running' : 'stopped',
                  elasticsearch: elasticsearchRunning ? 'running' : 'stopped'
                };

                healthDetails.clientCompatibility = {
                  gremlinJs: 'known_issue',
                  issue: 'gremlin JavaScript client has WebSocket API incompatibility with Node.js',
                  error: 'this._ws.on is not a function',
                  workaround: 'Use HTTP-based JanusGraph client or alternative Gremlin client'
                };

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
            const processes = execFileSync(
              runtime, ['exec', containerName, 'ps', 'aux'],
              { encoding: 'utf-8', stdio: 'pipe' }
            );
            isHealthy = processes.includes('java') && processes.includes('janusgraph');

            if (!isHealthy) {
              healthDetails.processCheck = 'JanusGraph java process not found';
            }
          }
          break;
        case 'neo4j':
          // Neo4j bolt protocol check
          execFileSync('nc', ['-z', 'localhost', String(port)], { timeout: 5000 });
          isHealthy = true;
          break;
        case 'arangodb' as any:
          // Check ArangoDB HTTP API
          const httpCode = execFileSync(
            'curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://localhost:${port!}/_api/version`],
            { encoding: 'utf-8', timeout: 5000 }
          ).trim();
          isHealthy = httpCode === '200';
          break;
        default:
          // Generic port check
          execFileSync('nc', ['-z', 'localhost', String(port)], { timeout: 5000 });
          isHealthy = true;
      }
    } catch (healthCheckError) {
      isHealthy = false;
      healthDetails.error = 'Service not responding on expected port';
    }

    // Get recent logs
    let logs: { recent: string[]; errors: string[] } | undefined;
    try {
      const logOutput = execFileSync(
        runtime, ['logs', containerName, '--tail', '20'],
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
    const image = execFileSync(
      runtime, ['inspect', containerName, '--format', '{{.Config.Image}}'],
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

const preflightGraphCheck = async (context: ContainerCheckHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([
    checkContainerRuntime(context.runtime),
    checkCommandAvailable('curl'),
  ]);
};

export const graphCheckDescriptor: HandlerDescriptor<ContainerCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'container',
  serviceType: 'graph',
  handler: checkGraphContainer,
  preflight: preflightGraphCheck
};
