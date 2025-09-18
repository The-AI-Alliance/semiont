import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import neo4j from 'neo4j-driver';

/**
 * Check handler for External graph database services (Neo4j, ArangoDB, etc.)
 * These are external services that are not managed by Semiont
 */
const checkExternalGraph = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const graphType = service.config.type || 'neo4j';

  // Configuration display (sanitized)
  const config: any = {
    type: graphType,
    name: service.name,
  };

  // Handle Neo4j connectivity check
  if (graphType === 'neo4j') {
    config.uri = service.config.uri ? '***' : 'not configured';
    config.database = service.config.database || 'neo4j';
    config.authentication = service.config.username ? 'configured' : 'not configured';

    // Test actual connectivity
    if (service.config.uri && service.config.username && service.config.password) {
      const driver = neo4j.driver(
        service.config.uri,
        neo4j.auth.basic(service.config.username, service.config.password)
      );

      try {
        // Verify connectivity
        await driver.verifyConnectivity();

        // Get server info
        const serverInfo = await driver.getServerInfo();

        await driver.close();

        return {
          success: true,
          status: 'running',
          health: {
            healthy: true,
            details: {
              message: `Neo4j connected successfully`,
              protocolVersion: serverInfo.protocolVersion,
              address: serverInfo.address,
              database: service.config.database || 'neo4j',
              configuration: config
            }
          },
          metadata: {
            serviceType: 'graph',
            graphType,
            platform: 'external',
            managedExternally: true,
            agent: serverInfo.agent
          }
        };
      } catch (error) {
        await driver.close();

        return {
          success: false,
          status: 'unhealthy',
          error: error instanceof Error ? error.message : String(error),
          health: {
            healthy: false,
            details: {
              message: 'Failed to connect to Neo4j',
              error: error instanceof Error ? error.message : String(error),
              configuration: config
            }
          },
          metadata: {
            serviceType: 'graph',
            graphType,
            platform: 'external',
            managedExternally: true
          }
        };
      }
    } else {
      // Missing configuration
      return {
        success: false,
        status: 'stopped',
        error: 'Neo4j connection parameters missing',
        health: {
          healthy: false,
          details: {
            message: 'Neo4j configuration incomplete',
            configuration: config,
            missing: [
              !service.config.uri && 'uri',
              !service.config.username && 'username',
              !service.config.password && 'password'
            ].filter(Boolean).join(', ')
          }
        },
        metadata: {
          serviceType: 'graph',
          graphType,
          platform: 'external',
          managedExternally: true
        }
      };
    }
  }

  // Handle other graph types
  switch (graphType) {
    case 'arangodb':
      config.url = service.config.url ? '***' : 'not configured';
      config.database = service.config.database || 'default';
      config.authentication = service.config.username ? 'configured' : 'not configured';
      break;
    default:
      config.note = 'External graph service - configuration not validated';
  }

  return {
    success: true,
    status: 'unknown',
    health: {
      healthy: true,
      details: {
        message: `External ${graphType} service - status unknown`,
        configuration: config,
        note: 'Use the native client tools to check service health'
      }
    },
    metadata: {
      serviceType: 'graph',
      graphType,
      platform: 'external',
      managedExternally: true
    }
  };
};

/**
 * Descriptor for External graph check handler
 */
export const graphCheckDescriptor: HandlerDescriptor<ExternalCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'external',
  serviceType: 'graph',
  handler: checkExternalGraph
};