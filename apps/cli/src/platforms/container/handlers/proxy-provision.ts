import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { ContainerProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning, printError } from '../../../core/io/cli-logger.js';
import { getProxyPaths } from './proxy-paths.js';
import type { ProxyServiceConfig } from '@semiont/core';

/**
 * Detect the appropriate host address for Docker to reach host services
 */
function getHostAddress(): string {
  const platform = process.platform;

  if (platform === 'darwin' || platform === 'win32') {
    // macOS and Windows Docker Desktop
    return 'host.docker.internal';
  } else {
    // Linux - try host-gateway first, fallback to bridge IP
    try {
      // Docker 20.10+ supports host-gateway
      execSync('docker run --rm alpine getent hosts host-gateway', { stdio: 'pipe' });
      return 'host-gateway';
    } catch {
      // Fallback to default bridge gateway
      return '172.17.0.1';
    }
  }
}

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
 * Copy and process the proxy configuration template
 */
function processProxyConfig(
  templatePath: string,
  outputPath: string,
  replacements: Record<string, string>
): void {
  // Read template
  let content = fs.readFileSync(templatePath, 'utf-8');

  // Replace placeholders
  for (const [key, value] of Object.entries(replacements)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    content = content.replace(regex, value);
  }

  // Write processed config
  fs.writeFileSync(outputPath, content);
}

/**
 * Provision handler for proxy services in containers
 */
const provisionProxyService = async (context: ContainerProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;
  const config = service.config as ProxyServiceConfig;

  if (!service.quiet) {
    printInfo(`Provisioning proxy service ${service.name} (type: ${config.type})...`);
  }

  // Get proxy paths
  const paths = getProxyPaths(context);

  // Create directories
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });

  if (!service.quiet) {
    printInfo(`Created proxy directories in: ${paths.runtimeDir}`);
  }

  // Detect host address for Docker
  const hostAddress = getHostAddress();
  if (!service.quiet) {
    printInfo(`Using host address: ${hostAddress} for Docker container`);
  }

  // Get port configurations
  const proxyPort = config.port || 8080;
  const adminPort = config.adminPort || 9901;
  const backendPort = config.backendPort || 4000;
  const frontendPort = config.frontendPort || 3000;

  // Process configuration template based on proxy type
  if (config.type === 'envoy') {
    // Get the template path - similar to how init.ts does it
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    let templatePath: string;

    // Check if we're running from source (tests) or dist (production)
    if (__dirname.includes(path.sep + 'src' + path.sep)) {
      // Running from source: go up to project root, then to templates
      templatePath = path.join(__dirname, '..', '..', '..', '..', 'templates', 'envoy.yaml');
    } else {
      // Production: templates are in dist/templates
      templatePath = path.join(__dirname, 'templates', 'envoy.yaml');
    }

    if (!fs.existsSync(templatePath)) {
      return {
        success: false,
        error: `Envoy template not found at ${templatePath}`,
        metadata: { serviceType: 'proxy', proxyType: config.type }
      };
    }

    // Process template with replacements
    processProxyConfig(templatePath, paths.configFile, {
      HOST_ADDRESS: hostAddress,
      BACKEND_PORT: backendPort.toString(),
      FRONTEND_PORT: frontendPort.toString()
    });

    if (!service.quiet) {
      printSuccess(`Created Envoy configuration at ${paths.configFile}`);
    }
  } else {
    // TODO: Add nginx and haproxy config generation
    return {
      success: false,
      error: `Proxy type ${config.type} is not yet implemented`,
      metadata: { serviceType: 'proxy', proxyType: config.type }
    };
  }

  // Pull Docker image
  const imageName = getProxyImage(config.type, config.image);

  if (!service.quiet) {
    printInfo(`Pulling Docker image: ${imageName}...`);
  }

  try {
    execSync(`docker pull ${imageName}`, {
      stdio: service.verbose ? 'inherit' : 'pipe'
    });
    if (!service.quiet) {
      printSuccess(`Docker image ${imageName} ready`);
    }
  } catch (error) {
    printError(`Failed to pull Docker image: ${error}`);
    return {
      success: false,
      error: `Failed to pull Docker image: ${error}`,
      metadata: { serviceType: 'proxy', proxyType: config.type, imageName }
    };
  }

  // Validate that frontend and backend services are configured
  const frontendService = service.environmentConfig.services['frontend'];
  const backendService = service.environmentConfig.services['backend'];

  if (!frontendService) {
    printWarning('Frontend service not configured in environment');
  }

  if (!backendService) {
    printWarning('Backend service not configured in environment');
  }

  const metadata = {
    serviceType: 'proxy',
    proxyType: config.type,
    imageName,
    configFile: paths.configFile,
    logsDir: paths.logsDir,
    hostAddress,
    ports: {
      proxy: proxyPort,
      admin: adminPort,
      backend: backendPort,
      frontend: frontendPort
    },
    configured: true
  };

  if (!service.quiet) {
    printSuccess(`✅ Proxy service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Proxy details:');
    printInfo(`  Type: ${config.type}`);
    printInfo(`  Image: ${imageName}`);
    printInfo(`  Config: ${paths.configFile}`);
    printInfo(`  Proxy port: ${proxyPort}`);
    printInfo(`  Admin port: ${adminPort}`);
    printInfo(`  Backend routing: ${hostAddress}:${backendPort}`);
    printInfo(`  Frontend routing: ${hostAddress}:${frontendPort}`);
    printInfo('');
    printInfo('Next steps:');
    printInfo(`  1. Ensure backend is running on port ${backendPort}`);
    printInfo(`  2. Ensure frontend is running on port ${frontendPort}`);
    printInfo(`  3. Start proxy: semiont start --service proxy --environment ${service.environment}`);
  }

  return {
    success: true,
    metadata
  };
};

/**
 * Descriptor for proxy container provision handler
 */
export const proxyProvisionDescriptor: HandlerDescriptor<ContainerProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'container',
  serviceType: 'proxy',
  handler: provisionProxyService
};