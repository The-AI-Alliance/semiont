import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Provision handler for generic container services
 * 
 * Handles provisioning of container infrastructure including:
 * - Network creation
 * - Volume creation for persistent storage
 * - Image building or pulling
 * - External dependency validation
 * 
 * Supports both Docker and Podman runtimes
 */
const provisionGenericService = async (context: ProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, runtime } = context;
  const requirements = service.getRequirements();
  
  if (!service.quiet) {
    printInfo(`Provisioning ${service.name} for container deployment...`);
  }
  
  // Ensure container runtime is available
  if (!runtime) {
    return {
      success: false,
      error: 'No container runtime (Docker or Podman) found',
      metadata: {
        serviceType: 'generic'
      }
    };
  }
  
  const dependencies = requirements.dependencies?.services || [];
  const metadata: any = {
    runtime,
    serviceType: 'generic'
  };
  
  // Create network if it doesn't exist
  const networkName = `semiont-${service.environment}`;
  try {
    execSync(`${runtime} network create ${networkName}`, { stdio: 'ignore' });
    metadata.network = networkName;
  } catch {
    // Network might already exist
  }
  
  // Create volumes from storage requirements
  if (requirements.storage) {
    const volumes: string[] = [];
    for (const storage of requirements.storage) {
      if (storage.persistent) {
        const volumeName = storage.volumeName || `semiont-${service.name}-data-${service.environment}`;
        try {
          execSync(`${runtime} volume create ${volumeName}`);
          volumes.push(volumeName);
          
          if (!service.quiet) {
            printInfo(`Created volume: ${volumeName}`);
          }
        } catch {
          // Volume might already exist
        }
      }
    }
    if (volumes.length > 0) {
      metadata.volumes = volumes;
    }
  }
  
  // Pull or build image based on build requirements
  if (requirements.build && !requirements.build.prebuilt) {
    // Build image from Dockerfile
    const dockerfile = requirements.build.dockerfile || 'Dockerfile';
    const buildContext = requirements.build.buildContext || service.projectRoot;
    const imageTag = `${service.name}:${service.environment}`;
    
    if (fs.existsSync(path.join(buildContext, dockerfile))) {
      if (!service.quiet) {
        printInfo(`Building image ${imageTag} from ${dockerfile}...`);
      }
      
      const buildArgs = [];
      if (requirements.build.buildArgs) {
        for (const [key, value] of Object.entries(requirements.build.buildArgs)) {
          buildArgs.push(`--build-arg ${key}=${value}`);
        }
      }
      
      if (requirements.build.target) {
        buildArgs.push(`--target ${requirements.build.target}`);
      }
      
      try {
        execSync(
          `${runtime} build -t ${imageTag} -f ${dockerfile} ${buildArgs.join(' ')} .`,
          { 
            cwd: buildContext,
            stdio: service.verbose ? 'inherit' : 'pipe'
          }
        );
        
        metadata.image = imageTag;
        metadata.built = true;
      } catch (error) {
        return {
          success: false,
          error: `Failed to build image: ${error}`,
          metadata
        };
      }
    }
  } else {
    // Pull pre-built image
    const image = service.getImage();
    if (!service.quiet) {
      printInfo(`Pulling image ${image}...`);
    }
    
    try {
      execSync(`${runtime} pull ${image}`, {
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      metadata.image = image;
      metadata.pulled = true;
    } catch (error) {
      printWarning(`Failed to pull image ${image}, will try to use local`);
    }
  }
  
  // Check external dependencies
  if (requirements.dependencies?.external) {
    for (const ext of requirements.dependencies.external) {
      if (ext.required && ext.healthCheck) {
        try {
          const response = await fetch(ext.healthCheck, {
            signal: AbortSignal.timeout(5000)
          });
          if (!response.ok && ext.required) {
            return {
              success: false,
              error: `Required external dependency '${ext.name}' is not available`,
              dependencies,
              metadata
            };
          }
        } catch (error) {
          if (ext.required) {
            return {
              success: false,
              error: `Required external dependency '${ext.name}' is not reachable`,
              dependencies,
              metadata
            };
          }
        }
      }
    }
  }
  
  return {
    success: true,
    dependencies,
    metadata: {
      ...metadata,
      runtime  // Include runtime in metadata instead
    },
    resources: {
      platform: 'container',
      data: {
        containerId: '', // Will be populated when container is started
        networkName: metadata.network,
        volumes: metadata.volumes
      }
    }
  };
};

/**
 * Descriptor for generic container provision handler
 */
export const genericProvisionDescriptor: HandlerDescriptor<ProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'container',
  serviceType: 'generic',
  handler: provisionGenericService
};