import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import net from 'net';

/**
 * Check handler for External database services (PostgreSQL, MySQL, etc.)
 * These are external services that are not managed by Semiont
 */
const checkExternalDatabase = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const databaseType = service.config.type || 'postgres';

  // Configuration display (sanitized)
  const config: any = {
    type: databaseType,
    name: service.name,
    host: service.config.host || 'localhost',
    port: service.config.port || 5432,
    database: service.config.database || 'default'
  };

  // Handle PostgreSQL connectivity check
  if (databaseType === 'postgres' || databaseType === 'postgresql') {
    config.username = service.config.username ? service.config.username : 'not configured';
    config.authentication = service.config.password ? 'configured' : 'not configured';

    // Test actual connectivity using TCP socket
    const host = service.config.host || 'localhost';
    const port = service.config.port || 5432;

    try {
      const isReachable = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();

        socket.setTimeout(5000); // 5 second timeout

        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });

        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });

        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });

        socket.connect(port, host);
      });

      if (isReachable) {
        return {
          success: true,
          status: 'running',
          health: {
            healthy: true,
            details: {
              message: `PostgreSQL is reachable at ${host}:${port}`,
              configuration: config
            }
          },
          metadata: {
            serviceType: 'database',
            databaseType,
            platform: 'external',
            managedExternally: true
          }
        };
      } else {
        return {
          success: false,
          status: 'unhealthy',
          error: `Cannot connect to PostgreSQL at ${host}:${port}`,
          health: {
            healthy: false,
            details: {
              message: `PostgreSQL unreachable at ${host}:${port}`,
              configuration: config
            }
          },
          metadata: {
            serviceType: 'database',
            databaseType,
            platform: 'external',
            managedExternally: true
          }
        };
      }
    } catch (error) {
      return {
        success: false,
        status: 'unhealthy',
        error: error instanceof Error ? error.message : String(error),
        health: {
          healthy: false,
          details: {
            message: 'Failed to check PostgreSQL connectivity',
            error: error instanceof Error ? error.message : String(error),
            configuration: config
          }
        },
        metadata: {
          serviceType: 'database',
          databaseType,
          platform: 'external',
          managedExternally: true
        }
      };
    }
  }

  // Handle MySQL connectivity check
  if (databaseType === 'mysql' || databaseType === 'mariadb') {
    config.username = service.config.username ? service.config.username : 'not configured';
    config.authentication = service.config.password ? 'configured' : 'not configured';

    const host = service.config.host || 'localhost';
    const port = service.config.port || 3306;

    try {
      const isReachable = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();

        socket.setTimeout(5000); // 5 second timeout

        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });

        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });

        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });

        socket.connect(port, host);
      });

      if (isReachable) {
        return {
          success: true,
          status: 'running',
          health: {
            healthy: true,
            details: {
              message: `MySQL/MariaDB is reachable at ${host}:${port}`,
              configuration: config
            }
          },
          metadata: {
            serviceType: 'database',
            databaseType,
            platform: 'external',
            managedExternally: true
          }
        };
      } else {
        return {
          success: false,
          status: 'unhealthy',
          error: `Cannot connect to MySQL/MariaDB at ${host}:${port}`,
          health: {
            healthy: false,
            details: {
              message: `MySQL/MariaDB unreachable at ${host}:${port}`,
              configuration: config
            }
          },
          metadata: {
            serviceType: 'database',
            databaseType,
            platform: 'external',
            managedExternally: true
          }
        };
      }
    } catch (error) {
      return {
        success: false,
        status: 'unhealthy',
        error: error instanceof Error ? error.message : String(error),
        health: {
          healthy: false,
          details: {
            message: 'Failed to check MySQL/MariaDB connectivity',
            error: error instanceof Error ? error.message : String(error),
            configuration: config
          }
        },
        metadata: {
          serviceType: 'database',
          databaseType,
          platform: 'external',
          managedExternally: true
        }
      };
    }
  }

  // Handle other database types
  return {
    success: true,
    status: 'unknown',
    health: {
      healthy: true,
      details: {
        message: `External ${databaseType} service - status unknown`,
        configuration: config,
        note: 'Use the native client tools to check service health'
      }
    },
    metadata: {
      serviceType: 'database',
      databaseType,
      platform: 'external',
      managedExternally: true
    }
  };
};

/**
 * Descriptor for External database check handler
 */
export const databaseCheckDescriptor: HandlerDescriptor<ExternalCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'external',
  serviceType: 'database',
  handler: checkExternalDatabase
};