import { execSync } from 'child_process';
import * as fs from 'fs';
import { ContainerCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printError, printWarning } from '../../../core/io/cli-logger.js';
import { getProxyPaths } from './proxy-paths.js';
import type { ProxyServiceConfig } from '@semiont/core';

/**
 * Health check result interface
 */
interface ProxyHealthCheck {
  containerRunning: boolean;
  adminHealthy: boolean;
  frontendRouting: boolean;
  backendRouting: boolean;
  containerId?: string;
  uptime?: string;
  logs?: string;
}

/**
 * Check if a URL is accessible
 */
async function checkUrl(url: string, timeout: number = 5000): Promise<boolean> {
  try {
    execSync(`curl -s -f -m ${Math.floor(timeout / 1000)} ${url} > /dev/null 2>&1`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get container uptime
 */
function getContainerUptime(containerName: string): string | undefined {
  try {
    const uptime = execSync(
      `docker ps --format "table {{.Status}}" --filter name=${containerName} | tail -n +2`,
      { encoding: 'utf-8' }
    ).trim();
    return uptime;
  } catch {
    return undefined;
  }
}

/**
 * Get recent container logs
 */
function getRecentLogs(containerName: string, lines: number = 20): string | undefined {
  try {
    const logs = execSync(`docker logs --tail ${lines} ${containerName} 2>&1`, { encoding: 'utf-8' });
    return logs;
  } catch {
    return undefined;
  }
}

/**
 * Check handler for proxy services in containers
 */
const checkProxyService = async (context: ContainerCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const config = service.config as ProxyServiceConfig;

  if (!service.quiet) {
    printInfo(`Checking proxy service ${service.name} (type: ${config.type})...`);
  }

  // Get proxy paths
  const paths = getProxyPaths(context);

  // Container name
  const containerName = `semiont-proxy-${service.environment}`;

  // Initialize health check result
  const healthCheck: ProxyHealthCheck = {
    containerRunning: false,
    adminHealthy: false,
    frontendRouting: false,
    backendRouting: false
  };

  // Check if container exists and is running
  try {
    const containerId = execSync(`docker ps -q -f name=${containerName}`, { encoding: 'utf-8' }).trim();

    if (containerId) {
      healthCheck.containerRunning = true;
      healthCheck.containerId = containerId.substring(0, 12);
      healthCheck.uptime = getContainerUptime(containerName);

      if (!service.quiet) {
        printSuccess(`Container ${containerName} is running (${healthCheck.containerId})`);
        if (healthCheck.uptime) {
          printInfo(`  Uptime: ${healthCheck.uptime}`);
        }
      }
    } else {
      // Check if container exists but is stopped
      const stoppedContainer = execSync(`docker ps -aq -f name=${containerName}`, { encoding: 'utf-8' }).trim();

      if (stoppedContainer) {
        if (!service.quiet) {
          printWarning(`Container ${containerName} exists but is not running`);
          printInfo('  Run `semiont start --service proxy` to start it');
        }
      } else {
        if (!service.quiet) {
          printWarning(`Container ${containerName} does not exist`);
          printInfo('  Run `semiont provision --service proxy` to set it up');
        }
      }

      return {
        success: false,
        status: 'stopped',
        error: 'Proxy container is not running',
        metadata: {
          serviceType: 'proxy',
          proxyType: config.type,
          healthCheck
        }
      };
    }
  } catch (error) {
    printError(`Failed to check container status: ${error}`);
    return {
      success: false,
      status: 'stopped',
      error: `Failed to check container status: ${error}`,
      metadata: {
        serviceType: 'proxy',
        proxyType: config.type,
        healthCheck
      }
    };
  }

  // Check ports
  const proxyPort = config.port || 8080;
  const adminPort = config.adminPort || 9901;

  // Check admin interface (Envoy specific)
  if (config.type === 'envoy') {
    if (!service.quiet) {
      printInfo(`Checking admin interface on port ${adminPort}...`);
    }

    healthCheck.adminHealthy = await checkUrl(`http://localhost:${adminPort}/clusters`);

    if (healthCheck.adminHealthy) {
      if (!service.quiet) {
        printSuccess(`Admin interface is accessible at http://localhost:${adminPort}`);
      }
    } else {
      if (!service.quiet) {
        printWarning(`Admin interface is not accessible at http://localhost:${adminPort}`);
      }
    }
  }

  // Check proxy routing to frontend
  if (!service.quiet) {
    printInfo('Checking frontend routing through proxy...');
  }

  healthCheck.frontendRouting = await checkUrl(`http://localhost:${proxyPort}/`);

  if (healthCheck.frontendRouting) {
    if (!service.quiet) {
      printSuccess(`Frontend is accessible through proxy at http://localhost:${proxyPort}/`);
    }
  } else {
    if (!service.quiet) {
      printWarning(`Frontend is not accessible through proxy at http://localhost:${proxyPort}/`);
      printInfo('  Ensure frontend is running on port ' + (config.frontendPort || 3000));
    }
  }

  // Check proxy routing to backend
  if (!service.quiet) {
    printInfo('Checking backend API routing through proxy...');
  }

  healthCheck.backendRouting = await checkUrl(`http://localhost:${proxyPort}/api/health`);

  if (healthCheck.backendRouting) {
    if (!service.quiet) {
      printSuccess(`Backend API is accessible through proxy at http://localhost:${proxyPort}/api/`);
    }
  } else {
    if (!service.quiet) {
      printWarning(`Backend API is not accessible through proxy at http://localhost:${proxyPort}/api/`);
      printInfo('  Ensure backend is running on port ' + (config.backendPort || 4000));
    }
  }

  // Check configuration file
  if (!service.quiet) {
    printInfo('Checking configuration...');
  }

  if (fs.existsSync(paths.configFile)) {
    if (!service.quiet) {
      printSuccess(`Configuration file exists: ${paths.configFile}`);
    }
  } else {
    if (!service.quiet) {
      printWarning(`Configuration file missing: ${paths.configFile}`);
      printInfo('  Run `semiont provision --service proxy` to create it');
    }
  }

  // Get recent logs if there are issues
  if (!healthCheck.frontendRouting || !healthCheck.backendRouting) {
    healthCheck.logs = getRecentLogs(containerName, 10);
    if (healthCheck.logs && !service.quiet && service.verbose) {
      printInfo('\nRecent container logs:');
      console.log(healthCheck.logs);
    }
  }

  // Determine overall health
  const isHealthy = healthCheck.containerRunning &&
    (config.type !== 'envoy' || healthCheck.adminHealthy);

  const metadata = {
    serviceType: 'proxy',
    proxyType: config.type,
    containerName,
    ports: {
      proxy: proxyPort,
      admin: adminPort
    },
    healthCheck,
    checked: new Date().toISOString()
  };

  if (isHealthy) {
    if (!service.quiet) {
      printSuccess(`\n✅ Proxy service ${service.name} is healthy`);

      // Show routing summary
      printInfo('\nRouting status:');
      printInfo(`  Proxy: http://localhost:${proxyPort} [${healthCheck.containerRunning ? '✓' : '✗'}]`);
      if (config.type === 'envoy') {
        printInfo(`  Admin: http://localhost:${adminPort} [${healthCheck.adminHealthy ? '✓' : '✗'}]`);
      }
      printInfo(`  Frontend routing: [${healthCheck.frontendRouting ? '✓' : '✗'}]`);
      printInfo(`  Backend routing: [${healthCheck.backendRouting ? '✓' : '✗'}]`);

      if (!healthCheck.frontendRouting || !healthCheck.backendRouting) {
        printInfo('\nNote: Some routes are not accessible. Ensure frontend and backend services are running.');
      }
    }

    return {
      success: true,
      status: 'running',
      metadata
    };
  } else {
    const issues = [];
    if (!healthCheck.containerRunning) issues.push('container not running');
    if (config.type === 'envoy' && !healthCheck.adminHealthy) issues.push('admin interface not healthy');

    return {
      success: false,
      status: 'stopped',
      error: `Proxy service is not healthy: ${issues.join(', ')}`,
      metadata
    };
  }
};

/**
 * Descriptor for proxy container check handler
 */
export const proxyCheckDescriptor: HandlerDescriptor<ContainerCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'container',
  serviceType: 'proxy',
  handler: checkProxyService
};