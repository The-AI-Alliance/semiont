import * as fs from 'fs';
import * as path from 'path';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { getProxyPaths } from './proxy-paths.js';
import { getTemplatesDir } from '../../../core/io/cli-paths.js';
import type { ProxyServiceConfig } from '@semiont/core';

/**
 * Copy and process the proxy configuration template
 */
function processProxyConfig(
  templatePath: string,
  outputPath: string,
  replacements: Record<string, string>
): void {
  let content = fs.readFileSync(templatePath, 'utf-8');

  for (const [key, value] of Object.entries(replacements)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    content = content.replace(regex, value);
  }

  fs.writeFileSync(outputPath, content);
}

/**
 * Provision handler for proxy services on POSIX systems
 *
 * Creates the proxy runtime directory, processes the envoy.yaml template
 * with the correct host/port values, and prepares for starting.
 */
const provisionProxyService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;
  const config = service.config as ProxyServiceConfig;

  if (!service.quiet) {
    printInfo(`Provisioning proxy service ${service.name} (type: ${config.type})...`);
  }

  const paths = getProxyPaths(context);

  // Create directories
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });

  if (!service.quiet) {
    printInfo(`Created proxy directories in: ${paths.runtimeDir}`);
  }

  // Get port configurations
  const proxyPort = config.port || 8080;
  const adminPort = config.adminPort || 9901;
  const backendPort = config.backendPort || 4000;
  const frontendPort = config.frontendPort || 3000;

  // Process configuration template based on proxy type
  if (config.type === 'envoy') {
    const templatePath = path.join(getTemplatesDir(import.meta.url), 'envoy.yaml');

    if (!fs.existsSync(templatePath)) {
      return {
        success: false,
        error: `Envoy template not found at ${templatePath}`,
        metadata: { serviceType: 'proxy', proxyType: config.type }
      };
    }

    // For posix, proxy connects to localhost services directly
    const hostAddress = '127.0.0.1';

    processProxyConfig(templatePath, paths.configFile, {
      HOST_ADDRESS: hostAddress,
      BACKEND_PORT: backendPort.toString(),
      FRONTEND_PORT: frontendPort.toString()
    });

    if (!service.quiet) {
      printSuccess(`Created Envoy configuration at ${paths.configFile}`);
    }
  } else {
    return {
      success: false,
      error: `Proxy type ${config.type} is not yet implemented`,
      metadata: { serviceType: 'proxy', proxyType: config.type }
    };
  }

  const metadata = {
    serviceType: 'proxy',
    proxyType: config.type,
    configFile: paths.configFile,
    logsDir: paths.logsDir,
    ports: {
      proxy: proxyPort,
      admin: adminPort,
      backend: backendPort,
      frontend: frontendPort
    },
    configured: true
  };

  if (!service.quiet) {
    printSuccess(`Proxy service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Proxy details:');
    printInfo(`  Type: ${config.type}`);
    printInfo(`  Config: ${paths.configFile}`);
    printInfo(`  Proxy port: ${proxyPort}`);
    printInfo(`  Admin port: ${adminPort}`);
    printInfo(`  Backend routing: 127.0.0.1:${backendPort}`);
    printInfo(`  Frontend routing: 127.0.0.1:${frontendPort}`);
    printInfo('');
    printInfo('Next steps:');
    printInfo(`  Start proxy: semiont start --service proxy --environment ${service.environment}`);
  }

  return {
    success: true,
    metadata
  };
};

export const proxyProvisionDescriptor: HandlerDescriptor<PosixProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'posix',
  serviceType: 'proxy',
  handler: provisionProxyService
};
