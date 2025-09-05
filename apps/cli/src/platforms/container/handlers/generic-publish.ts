import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ContainerPublishHandlerContext, PublishHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Publish handler for generic container services
 * 
 * Handles building and publishing container images:
 * - Builds images from Dockerfile if needed
 * - Tags images with versions
 * - Pushes to registries if configured
 * - Exports images to tar files if requested
 * 
 * Supports both Docker and Podman runtimes
 */
const publishGenericService = async (context: ContainerPublishHandlerContext): Promise<PublishHandlerResult> => {
  const { service, runtime } = context;
  const requirements = service.getRequirements();
  const imageTag = `${service.name}:${service.environment}`;
  const version = new Date().toISOString().replace(/[:.]/g, '-');
  const versionedTag = `${service.name}:${version}`;
  
  if (!service.quiet) {
    printInfo(`Publishing ${service.name} for container deployment...`);
  }
  
  const artifacts: PublishHandlerResult['artifacts'] = {};
  
  // Build image if build requirements exist
  if (requirements.build && !requirements.build.prebuilt) {
    const dockerfile = requirements.build.dockerfile || 'Dockerfile';
    const buildContext = requirements.build.buildContext || 
      path.join(service.projectRoot, 'apps', service.name);
    
    if (fs.existsSync(path.join(buildContext, dockerfile))) {
      if (!service.quiet) {
        printInfo(`Building container image ${versionedTag}...`);
      }
      
      // Build with version tag
      const buildArgs = [];
      if (requirements.build.buildArgs) {
        for (const [key, value] of Object.entries(requirements.build.buildArgs)) {
          buildArgs.push(`--build-arg ${key}=${value}`);
        }
      }
      
      if (requirements.build.target) {
        buildArgs.push(`--target ${requirements.build.target}`);
      }
      
      // Add --no-cache flag if requested
      const noCacheFlag = service.config?.noCache ? '--no-cache ' : '';
      
      try {
        execSync(
          `${runtime} build ${noCacheFlag}-t ${versionedTag} -t ${imageTag} -f ${dockerfile} ${buildArgs.join(' ')} .`,
          { 
            cwd: buildContext,
            stdio: service.verbose ? 'inherit' : 'pipe'
          }
        );
        
        artifacts.imageTag = versionedTag;
        artifacts.imageUrl = versionedTag; // Local image
        
        // Get image size
        try {
          const size = execSync(
            `${runtime} images ${versionedTag} --format "{{.Size}}"`,
            { encoding: 'utf-8' }
          ).trim();
          artifacts.imageSize = size;
        } catch {
          // Size retrieval failed, not critical
        }
      } catch (error) {
        return {
          success: false,
          error: `Failed to build image: ${error}`,
          metadata: {
            serviceType: 'generic',
            runtime
          }
        };
      }
    } else {
      return {
        success: false,
        error: `Dockerfile not found at ${path.join(buildContext, dockerfile)}`,
        metadata: {
          serviceType: 'generic',
          runtime
        }
      };
    }
  }
  
  // Push to registry if specified in annotations
  const registryUrl = requirements.annotations?.['container/registry'];
  if (registryUrl && artifacts.imageTag) {
    const remoteTag = `${registryUrl}/${versionedTag}`;
    
    if (!service.quiet) {
      printInfo(`Pushing image to ${registryUrl}...`);
    }
    
    try {
      // Tag for remote registry
      execSync(`${runtime} tag ${versionedTag} ${remoteTag}`, {
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      
      // Push to registry
      execSync(`${runtime} push ${remoteTag}`, {
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      
      artifacts.imageUrl = remoteTag;
      artifacts.registry = registryUrl;
    } catch (error) {
      printWarning(`Failed to push to registry: ${error}`);
    }
  }
  
  // Export image to tar if requested
  if (requirements.annotations?.['container/export'] === 'true') {
    const exportPath = path.join(service.projectRoot, 'dist', `${service.name}-${version}.tar`);
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    
    try {
      execSync(`${runtime} save -o ${exportPath} ${versionedTag}`, {
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      artifacts.bundleUrl = `file://${exportPath}`;
      
      // Get bundle size
      const stats = fs.statSync(exportPath);
      artifacts.bundleSize = `${(stats.size / 1024 / 1024).toFixed(2)} MB`;
    } catch (error) {
      printWarning(`Failed to export image: ${error}`);
    }
  }
  
  return {
    success: true,
    artifacts,
    rollback: {
      supported: true,
      command: `${runtime} run ${imageTag}`
    },
    registry: registryUrl ? {
      type: 'container',
      uri: registryUrl,
      tags: [version, 'latest']
    } : undefined,
    metadata: {
      runtime,
      serviceType: 'generic',
      buildRequirements: requirements.build,
      version,
      imageTag: versionedTag
    }
  };
};

/**
 * Descriptor for generic container publish handler
 */
export const genericPublishDescriptor: HandlerDescriptor<ContainerPublishHandlerContext, PublishHandlerResult> = {
  command: 'publish',
  platform: 'container',
  serviceType: 'generic',
  handler: publishGenericService
};