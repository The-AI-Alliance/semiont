import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { ContainerStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printError } from '../../../core/io/cli-logger.js';
import { getProxyPaths } from './proxy-paths.js';
import type { ProxyServiceConfig } from '@semiont/core';
import { checkCommandAvailable, checkContainerRuntime, checkPortFree, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Get the Docker image for the proxy type
 */
function getProxyImage(type: string, customImage?: string): string {
  if (customImage) {
    return customImage;
  }

  switch (type) {
    case 'envoy':
      return 'envoyproxy/envoy:v1.28-latest';
    case 'nginx':
      return 'nginx:alpine';
    case 'haproxy':
      return 'haproxy:alpine';
    default:
      return 'envoyproxy/envoy:v1.28-latest';
  }
}

/**
 * Get command arguments for the proxy type
 */
function getProxyCommand(type: string): string[] {
  switch (type) {
    case 'envoy':
      return ['-c', '/etc/envoy/envoy.yaml'];
    case 'nginx':
      return [];
    case 'haproxy':
      return ['-f', '/usr/local/etc/haproxy/haproxy.cfg'];
    default:
      return [];
  }
}

/**
 * Start handler for proxy services in containers
 */
const startProxyService = async (context: ContainerStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, runtime, containerName } = context;
  const config = service.config as ProxyServiceConfig;

  if (!service.quiet) {
    printInfo(`Starting proxy service ${service.name} (type: ${config.type})...`);
  }

  // Get proxy paths
  const paths = getProxyPaths(context);

  // Check if config file exists
  if (!fs.existsSync(paths.configFile)) {
    return {
      success: false,
      error: `Configuration file not found: ${paths.configFile}. Please run 'semiont provision --service proxy' first.`,
      metadata: { serviceType: 'proxy', proxyType: config.type }
    };
  }

  // Check if container already exists
  try {
    const existingContainer = execFileSync(runtime, ['ps', '-aq', '-f', `name=${containerName}`], { encoding: 'utf-8' }).trim();

    if (existingContainer) {
      // Check if it's running
      const isRunning = execFileSync(runtime, ['ps', '-q', '-f', `name=${containerName}`], { encoding: 'utf-8' }).trim();

      if (isRunning) {
        if (!service.quiet) {
          printInfo(`Proxy container ${containerName} is already running`);
        }
        return {
          success: true,
          metadata: {
            serviceType: 'proxy',
            proxyType: config.type,
            containerId: existingContainer,
            alreadyRunning: true
          }
        };
      } else {
        // Container exists but not running, remove it
        if (!service.quiet) {
          printInfo(`Removing stopped container ${containerName}`);
        }
        execFileSync(runtime, ['rm', containerName], { stdio: 'pipe' });
      }
    }
  } catch (error) {
    // Container doesn't exist, continue with creation
  }

  // Get image and ports
  const imageName = getProxyImage(config.type, config.image);
  const proxyPort = config.port || 8080;
  const adminPort = config.adminPort || 9901;

  // Build Docker run command
  const runArgs = [
    'run', '-d',
    '--name', containerName,
    '-p', `${proxyPort}:8080`,
    '-p', `${adminPort}:9901`,
    '-v', `${paths.configDir}:/etc/envoy:ro`,
    '--add-host=host.docker.internal:host-gateway',  // Ensure IPv4 resolution for upstream services
    '--restart', 'unless-stopped',
    '--log-driver', 'json-file',
    '--log-opt', 'max-size=10m',
    '--log-opt', 'max-file=3',
    imageName,
    ...getProxyCommand(config.type)
  ];

  if (!service.quiet) {
    printInfo(`Starting container: ${containerName}`);
    if (service.verbose) {
      printInfo(`Command: ${runtime} ${runArgs.join(' ')}`);
    }
  }

  try {
    // Start the container
    const containerId = execFileSync(runtime, runArgs, { encoding: 'utf-8' }).trim();

    if (!service.quiet) {
      printSuccess(`Container started with ID: ${containerId.substring(0, 12)}`);
    }

    // Wait for container to be healthy (give it a moment to start)
    if (!service.quiet) {
      printInfo('Waiting for proxy to become healthy...');
    }

    // Wait a moment for the container to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if container is still running
    const isRunning = execFileSync(runtime, ['ps', '-q', '-f', `id=${containerId}`], { encoding: 'utf-8' }).trim();

    if (!isRunning) {
      // Get logs to understand why it failed
      const logs = execFileSync(runtime, ['logs', containerId], { encoding: 'utf-8' });
      return {
        success: false,
        error: `Container exited unexpectedly. Logs:\n${logs}`,
        metadata: { serviceType: 'proxy', proxyType: config.type, containerId }
      };
    }

    // For Envoy, check admin interface
    if (config.type === 'envoy') {
      try {
        execFileSync('curl', ['-s', '-o', '/dev/null', `http://localhost:${adminPort}/clusters`], { stdio: 'pipe' });
        if (!service.quiet) {
          printSuccess('Proxy admin interface is accessible');
        }
      } catch {
        if (!service.quiet) {
          printInfo('Admin interface not yet ready, but container is running');
        }
      }
    }

    const metadata = {
      serviceType: 'proxy',
      proxyType: config.type,
      containerId,
      containerName,
      ports: {
        proxy: proxyPort,
        admin: adminPort
      },
      started: new Date().toISOString()
    };

    if (!service.quiet) {
      printSuccess(`Proxy service ${service.name} started successfully`);
      printInfo('');
      printInfo('Proxy is running:');
      printInfo(`  Container: ${containerName}`);
      printInfo(`  Proxy URL: http://localhost:${proxyPort}`);
      if (config.type === 'envoy') {
        printInfo(`  Admin URL: http://localhost:${adminPort}`);
      }
      printInfo('');
      printInfo('Access your application through the proxy:');
      printInfo(`  Frontend: http://localhost:${proxyPort}/`);
      printInfo(`  Backend API: http://localhost:${proxyPort}/api/`);
    }

    return {
      success: true,
      metadata,
      resources: {
        platform: 'container',
        data: {
          containerId,
          containerName
        }
      }
    };
  } catch (error) {
    printError(`Failed to start proxy container: ${error}`);
    return {
      success: false,
      error: `Failed to start proxy container: ${error}`,
      metadata: { serviceType: 'proxy', proxyType: config.type }
    };
  }
};

/**
 * Descriptor for proxy container start handler
 */
const preflightProxyStart = async (context: ContainerStartHandlerContext): Promise<PreflightResult> => {
  const { runtime, service } = context;
  const config = service.config as ProxyServiceConfig;
  const proxyPort = config.port || 8080;
  const adminPort = config.adminPort || 9901;
  return preflightFromChecks([
    checkContainerRuntime(runtime),
    checkCommandAvailable('curl'),
    await checkPortFree(proxyPort),
    await checkPortFree(adminPort),
  ]);
};

export const proxyStartDescriptor: HandlerDescriptor<ContainerStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'container',
  serviceType: 'proxy',
  handler: startProxyService,
  preflight: preflightProxyStart
};
