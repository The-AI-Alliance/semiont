import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { GraphServiceConfig } from '@semiont/core';
import neo4j from 'neo4j-driver';

/**
 * Check handler for External graph database services (Neo4j, ArangoDB, etc.)
 * These are external services that are not managed by Semiont
 */
const checkExternalGraph = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;

  // Type narrowing for graph service config
  const serviceConfig = service.config as GraphServiceConfig;
  const graphType = serviceConfig.type || 'neo4j';

  // Configuration display (sanitized)
  const config: any = {
    type: graphType,
    name: service.name,
  };

  // Handle Neo4j connectivity check
  if (graphType === 'neo4j') {
    config.uri = serviceConfig.uri ? '***' : 'not configured';
    config.database = serviceConfig.database || 'neo4j';
    config.authentication = serviceConfig.username ? 'configured' : 'not configured';

    // Test actual connectivity
    if (serviceConfig.uri && serviceConfig.username && serviceConfig.password) {
      const driver = neo4j.driver(
        serviceConfig.uri,
        neo4j.auth.basic(serviceConfig.username, serviceConfig.password)
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
              database: serviceConfig.database || 'neo4j',
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
              !serviceConfig.uri && 'uri',
              !serviceConfig.username && 'username',
              !serviceConfig.password && 'password'
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
    case 'arangodb' as any:  // ArangoDB support
      config.url = serviceConfig.url ? '***' : 'not configured';
      config.database = serviceConfig.database || 'default';
      config.authentication = serviceConfig.username ? 'configured' : 'not configured';
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