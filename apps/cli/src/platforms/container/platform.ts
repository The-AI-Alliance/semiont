/**
 * Container Platform Strategy
 * 
 * Runs services in isolated containers using Docker or Podman. This platform provides
 * consistent environments across development, testing, and production deployments.
 * 
 * Capabilities:
 * - Auto-detects and uses available container runtime (Docker or Podman)
 * - Creates containers with resource limits based on service requirements
 * - Manages container lifecycle (start, stop, restart, update)
 * - Supports volume mounts for persistent storage
 * - Provides network isolation and port mapping
 * - Enables exec into running containers for debugging
 * 
 * Requirements Handling:
 * - Compute: Sets memory limits and CPU shares on containers
 * - Network: Maps container ports to host ports, creates networks
 * - Storage: Mounts volumes for persistent and ephemeral storage
 * - Dependencies: Ensures dependent containers are running and networked
 * - Build: Can build images from Dockerfile when specified
 */

import { execSync } from 'child_process';
import * as path from "path";
import * as fs from 'fs';
import { StartResult } from "../../core/commands/start.js";
import { StopResult } from "../../core/commands/stop.js";
import { CheckResult } from "../../core/commands/check.js";
import { UpdateResult } from "../../core/commands/update.js";
import { ProvisionResult } from "../../core/commands/provision.js";
import { PublishResult } from "../../core/commands/publish.js";
import { BackupResult } from "../../core/commands/backup.js";
import { createPlatformResources } from "../platform-resources.js";
import { ExecResult, ExecOptions } from "../../core/commands/exec.js";
import { TestResult, TestOptions } from "../../core/commands/test.js";
import { RestoreResult, RestoreOptions } from "../../core/commands/restore.js";
import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import { printInfo, printWarning } from '../../core/io/cli-logger.js';

export class ContainerPlatformStrategy extends BasePlatformStrategy {
  private runtime: 'docker' | 'podman';
  
  constructor() {
    super();
    this.runtime = this.detectContainerRuntime();
  }
  
  getPlatformName(): string {
    return 'container';
  }
  
  async start(service: Service): Promise<StartResult> {
    const requirements = service.getRequirements();
    const containerName = this.getResourceName(service);
    const image = service.getImage();
    
    // Remove existing container if it exists
    try {
      execSync(`${this.runtime} rm -f ${containerName}`, { stdio: 'ignore' });
    } catch {
      // Container might not exist
    }
    
    // Build run command from requirements
    const runArgs: string[] = [
      'run',
      '-d',
      '--name', containerName,
      '--network', `semiont-${service.environment}`
    ];
    
    // Add port mappings from network requirements
    if (requirements.network?.ports) {
      for (const port of requirements.network.ports) {
        runArgs.push('-p', `${port}:${port}`);
      }
    }
    
    // Add environment variables
    const envVars = {
      ...service.getEnvironmentVariables(),
      ...(requirements.environment || {})
    };
    
    for (const [key, value] of Object.entries(envVars)) {
      runArgs.push('-e', `${key}=${value}`);
    }
    
    // Add volumes from storage requirements
    if (requirements.storage) {
      for (const storage of requirements.storage) {
        if (storage.persistent) {
          const volumeName = storage.volumeName || `${containerName}-data`;
          runArgs.push('-v', `${volumeName}:${storage.mountPath}`);
          
          // Create volume if it doesn't exist
          try {
            execSync(`${this.runtime} volume create ${volumeName}`, { stdio: 'ignore' });
          } catch {
            // Volume might already exist
          }
        } else if (storage.type === 'bind') {
          // Bind mount from host
          const hostPath = path.join(service.projectRoot, 'data', service.name);
          fs.mkdirSync(hostPath, { recursive: true });
          runArgs.push('-v', `${hostPath}:${storage.mountPath}`);
        }
      }
    }
    
    // Add resource limits from requirements
    if (requirements.resources) {
      if (requirements.resources.memory) {
        runArgs.push('--memory', requirements.resources.memory);
      }
      if (requirements.resources.cpu) {
        runArgs.push('--cpus', requirements.resources.cpu);
      }
      if (requirements.resources.gpus) {
        runArgs.push('--gpus', requirements.resources.gpus.toString());
      }
    }
    
    // Add security settings from requirements
    if (requirements.security) {
      if (requirements.security.runAsUser) {
        runArgs.push('--user', requirements.security.runAsUser.toString());
      }
      if (requirements.security.readOnlyRootFilesystem) {
        runArgs.push('--read-only');
      }
      if (!requirements.security.allowPrivilegeEscalation) {
        runArgs.push('--security-opt', 'no-new-privileges');
      }
      if (requirements.security.capabilities?.drop) {
        for (const cap of requirements.security.capabilities.drop) {
          runArgs.push('--cap-drop', cap);
        }
      }
      if (requirements.security.capabilities?.add) {
        for (const cap of requirements.security.capabilities.add) {
          runArgs.push('--cap-add', cap);
        }
      }
    }
    
    // Add health check from requirements
    if (requirements.network?.healthCheckPath) {
      const port = requirements.network.healthCheckPort || requirements.network.ports?.[0];
      if (port) {
        const interval = requirements.network.healthCheckInterval || 30;
        runArgs.push(
          '--health-cmd', `curl -f http://localhost:${port}${requirements.network.healthCheckPath} || exit 1`,
          '--health-interval', `${interval}s`,
          '--health-timeout', '10s',
          '--health-retries', '3',
          '--health-start-period', '40s'
        );
      }
    }
    
    // Add labels from requirements
    if (requirements.labels) {
      for (const [key, value] of Object.entries(requirements.labels)) {
        runArgs.push('--label', `${key}=${value}`);
      }
    }
    
    // Add restart policy from annotations
    const restartPolicy = requirements.annotations?.['container/restart'] || 'unless-stopped';
    runArgs.push('--restart', restartPolicy);
    
    // Add the image
    runArgs.push(image);
    
    // Add command if specified
    const command = service.getCommand();
    if (command && command !== 'npm start') {
      runArgs.push(...command.split(' '));
    }
    
    // Run container
    const runCommand = `${this.runtime} ${runArgs.join(' ')}`;
    
    if (!service.quiet) {
      printInfo(`Running container: ${containerName}`);
    }
    
    const containerId = execSync(runCommand, { encoding: 'utf-8' }).trim();
    
    // Wait for container to be ready
    await this.waitForContainer(containerName, requirements);
    
    // Build endpoint from network requirements
    let endpoint: string | undefined;
    if (requirements.network?.ports && requirements.network.ports.length > 0) {
      const primaryPort = requirements.network.ports[0];
      endpoint = `http://localhost:${primaryPort}`;
    }
    
    return {
      entity: service.name,
      platform: 'container',
      success: true,
      startTime: new Date(),
      endpoint,
      resources: createPlatformResources('container', {
        containerId: containerId.substring(0, 12),
        containerName,
        image
      }),
      metadata: {
        containerName,
        image,
        runtime: this.runtime,
        volumes: requirements.storage?.filter(s => s.persistent).map(s => s.volumeName || `${containerName}-data`),
        ports: requirements.network?.ports
      }
    };
  }
  
  async stop(service: Service): Promise<StopResult> {
    const containerName = this.getResourceName(service);
    
    try {
      // Check if container exists
      execSync(`${this.runtime} inspect ${containerName}`, { stdio: 'ignore' });
      
      // Stop container
      execSync(`${this.runtime} stop ${containerName}`);
      
      // Remove container
      execSync(`${this.runtime} rm ${containerName}`);
      
      return {
        entity: service.name,
        platform: 'container',
        success: true,
        stopTime: new Date(),
        gracefulShutdown: true,
        metadata: {
          containerName,
          runtime: this.runtime
        }
      };
    } catch {
      return {
        entity: service.name,
        platform: 'container',
        success: true,
        stopTime: new Date(),
        metadata: {
          message: 'Container not found or already stopped'
        }
      };
    }
  }
  
  async check(service: Service): Promise<CheckResult> {
    const requirements = service.getRequirements();
    const containerName = this.getResourceName(service);
    let status: CheckResult['status'] = 'stopped';
    let containerId: string | undefined;
    
    try {
      // Check container status
      const containerStatus = execSync(
        `${this.runtime} inspect ${containerName} --format '{{.State.Status}}'`,
        { encoding: 'utf-8' }
      ).trim();
      
      if (containerStatus === 'running') {
        status = 'running';
        
        // Get container ID
        containerId = execSync(
          `${this.runtime} inspect ${containerName} --format '{{.Id}}'`,
          { encoding: 'utf-8' }
        ).trim().substring(0, 12);
        
        // Check container health if health check was configured
        if (requirements.network?.healthCheckPath) {
          try {
            const health = execSync(
              `${this.runtime} inspect ${containerName} --format '{{.State.Health.Status}}'`,
              { encoding: 'utf-8' }
            ).trim();
            
            if (health === 'unhealthy') {
              status = 'unhealthy';
            }
          } catch {
            // No health check results yet
          }
        }
      } else if (containerStatus === 'exited' || containerStatus === 'stopped') {
        status = 'stopped';
      } else {
        status = 'unknown';
      }
    } catch {
      // Container doesn't exist
      status = 'stopped';
    }
    
    // Collect logs if running
    let logs: CheckResult['logs'] | undefined;
    if (status === 'running' || status === 'unhealthy') {
      logs = await this.collectLogs(service);
    }
    
    // Get health details
    let health: CheckResult['health'] | undefined;
    if (status === 'running' && requirements.network?.healthCheckPath) {
      const port = requirements.network.healthCheckPort || requirements.network.ports?.[0];
      if (port) {
        const healthUrl = `http://localhost:${port}${requirements.network.healthCheckPath}`;
        try {
          const response = await fetch(healthUrl, {
            signal: AbortSignal.timeout(5000)
          });
          health = {
            endpoint: healthUrl,
            statusCode: response.status,
            healthy: response.ok,
            details: { 
              status: response.ok ? 'healthy' : 'unhealthy',
              containerHealth: status === 'running' ? 'healthy' : status
            }
          };
        } catch (error) {
          health = {
            endpoint: healthUrl,
            healthy: false,
            details: { 
              error: (error as Error).message,
              containerHealth: status
            }
          };
        }
      }
    }
    
    return {
      entity: service.name,
      platform: 'container',
      success: true,
      checkTime: new Date(),
      status,
      stateVerified: true,
      resources: containerId ? createPlatformResources('container', {
        containerId,
        ports: requirements.network?.ports ? { 
          [requirements.network.ports[0]]: String(requirements.network.ports[0]) 
        } : undefined
      }) : undefined,
      health,
      logs
    };
  }
  
  async update(service: Service): Promise<UpdateResult> {
    const requirements = service.getRequirements();
    const containerName = this.getResourceName(service);
    const oldContainerId = await this.getContainerId(containerName);
    
    // For containers with replicas > 1, use rolling update
    const replicas = requirements.resources?.replicas || 1;
    const strategy = replicas > 1 ? 'rolling' : 'recreate';
    
    if (strategy === 'rolling' && replicas > 1) {
      // Rolling update (simplified version)
      const newContainerName = `${containerName}-new`;
      
      // Start new container
      // Create a new service instance for the rolling update
      const startResult = await this.start(service);
      
      // Wait for health check
      await this.waitForContainer(newContainerName, requirements);
      
      // Stop old container
      await this.stop(service);
      
      // Rename new container
      execSync(`${this.runtime} rename ${newContainerName} ${containerName}`);
      
      return {
        entity: service.name,
        platform: 'container',
        success: true,
        updateTime: new Date(),
        previousVersion: oldContainerId,
        newVersion: startResult.resources?.platform === 'container' ? 
          startResult.resources.data.containerId : undefined,
        strategy: 'rolling',
        metadata: {
          rollbackSupported: true,
          downtime: 0
        }
      };
    } else {
      // Recreate strategy
      await this.stop(service);
      const startResult = await this.start(service);
      
      return {
        entity: service.name,
        platform: 'container',
        success: true,
        updateTime: new Date(),
        previousVersion: oldContainerId,
        newVersion: startResult.resources?.platform === 'container' ? 
          startResult.resources.data.containerId : undefined,
        strategy: 'recreate',
        metadata: {
          rollbackSupported: false
        }
      };
    }
  }
  
  async provision(service: Service): Promise<ProvisionResult> {
    const requirements = service.getRequirements();
    
    if (!service.quiet) {
      printInfo(`Provisioning ${service.name} for container deployment...`);
    }
    
    // Ensure container runtime is available
    if (!this.runtime) {
      throw new Error('No container runtime (Docker or Podman) found');
    }
    
    const dependencies = requirements.dependencies?.services || [];
    const metadata: any = {
      runtime: this.runtime
    };
    
    // Create network if it doesn't exist
    const networkName = `semiont-${service.environment}`;
    try {
      execSync(`${this.runtime} network create ${networkName}`, { stdio: 'ignore' });
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
            execSync(`${this.runtime} volume create ${volumeName}`);
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
        
        execSync(
          `${this.runtime} build -t ${imageTag} -f ${dockerfile} ${buildArgs.join(' ')} .`,
          { cwd: buildContext }
        );
        
        metadata.image = imageTag;
        metadata.built = true;
      }
    } else {
      // Pull pre-built image
      const image = service.getImage();
      if (!service.quiet) {
        printInfo(`Pulling image ${image}...`);
      }
      
      try {
        execSync(`${this.runtime} pull ${image}`);
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
              throw new Error(`Required external dependency '${ext.name}' is not available`);
            }
          } catch (error) {
            if (ext.required) {
              throw new Error(`Required external dependency '${ext.name}' is not reachable`);
            }
          }
        }
      }
    }
    
    return {
      entity: service.name,
      platform: 'container',
      success: true,
      provisionTime: new Date(),
      dependencies,
      metadata
    };
  }
  
  async publish(service: Service): Promise<PublishResult> {
    const requirements = service.getRequirements();
    const imageTag = `${service.name}:${service.environment}`;
    const version = new Date().toISOString().replace(/[:.]/g, '-');
    const versionedTag = `${service.name}:${version}`;
    
    if (!service.quiet) {
      printInfo(`Publishing ${service.name} for container deployment...`);
    }
    
    const artifacts: PublishResult['artifacts'] = {};
    
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
        
        execSync(
          `${this.runtime} build -t ${versionedTag} -t ${imageTag} -f ${dockerfile} ${buildArgs.join(' ')} .`,
          { cwd: buildContext }
        );
        
        artifacts.imageTag = versionedTag;
        artifacts.imageUrl = versionedTag; // Local image
        
        // Get image size (could be stored in metadata if needed)
        execSync(
          `${this.runtime} images ${versionedTag} --format "{{.Size}}"`,
          { encoding: 'utf-8' }
        ).trim();
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
        execSync(`${this.runtime} tag ${versionedTag} ${remoteTag}`);
        
        // Push to registry
        execSync(`${this.runtime} push ${remoteTag}`);
        
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
      
      execSync(`${this.runtime} save -o ${exportPath} ${versionedTag}`);
      artifacts.bundleUrl = `file://${exportPath}`;
      // Store bundle size in metadata
    }
    
    return {
      entity: service.name,
      platform: 'container',
      success: true,
      publishTime: new Date(),
      artifacts,
      version: {
        current: version,
        previous: 'latest'
      },
      rollback: {
        supported: true,
        command: `${this.runtime} run ${imageTag}`
      },
      metadata: {
        runtime: this.runtime,
        buildRequirements: requirements.build
      }
    };
  }
  
  async backup(service: Service): Promise<BackupResult> {
    const requirements = service.getRequirements();
    const containerName = this.getResourceName(service);
    const backupId = `${service.name}-${service.environment}-${Date.now()}`;
    const backupDir = path.join(service.projectRoot, '.semiont', 'backups', service.environment);
    
    fs.mkdirSync(backupDir, { recursive: true });
    
    const backup: BackupResult['backup'] = {
      size: 0,
      location: '',
      format: 'tar'
    };
    
    if (!service.quiet) {
      printInfo(`Creating backup for ${service.name} (container platform)...`);
    }
    
    try {
      const backupPath = path.join(backupDir, `${backupId}.tar.gz`);
      const itemsToBackup: string[] = [];
      
      // Backup volumes based on storage requirements
      if (requirements.storage) {
        for (const storage of requirements.storage) {
          if (storage.persistent && storage.backupEnabled !== false) {
            const volumeName = storage.volumeName || `${containerName}-data`;
            
            // Check if volume exists
            try {
              execSync(`${this.runtime} volume inspect ${volumeName}`, { stdio: 'ignore' });
              
              // Create temporary container to access volume data
              const tempContainer = `backup-${Date.now()}`;
              execSync(
                `${this.runtime} run --rm -d --name ${tempContainer} -v ${volumeName}:${storage.mountPath} alpine sleep 300`
              );
              
              // Export volume data
              const volumeBackup = path.join(backupDir, `${volumeName}.tar`);
              execSync(
                `${this.runtime} exec ${tempContainer} tar cf - ${storage.mountPath} | gzip > ${volumeBackup}.gz`
              );
              
              // Stop temp container
              execSync(`${this.runtime} stop ${tempContainer}`);
              
              itemsToBackup.push(`${volumeName}.tar.gz`);
              
              if (backup) {
                if (!backup.details) {
                  backup.details = { type: 'volume', paths: [], preservePermissions: true };
                }
                if (!backup.details.paths) {
                  backup.details.paths = [];
                }
                backup.details.paths.push(volumeName);
              }
            } catch (error) {
              printWarning(`Could not backup volume ${volumeName}: ${error}`);
            }
          }
        }
      }
      
      // Backup container image if requested
      if (requirements.annotations?.['backup/image'] === 'true') {
        const image = service.getImage();
        const imageBackup = path.join(backupDir, `${backupId}-image.tar`);
        
        execSync(`${this.runtime} save -o ${imageBackup} ${image}`);
        itemsToBackup.push(path.basename(imageBackup));
        
        if (backup) {
          backup.details = {
            ...backup.details,
            image,
            imageId: execSync(
              `${this.runtime} images ${image} --format "{{.ID}}"`,
              { encoding: 'utf-8' }
            ).trim(),
            type: 'container'
          };
        }
      }
      
      // Backup container configuration
      if (this.isContainerRunning(containerName)) {
        const configBackup = path.join(backupDir, `${backupId}-config.json`);
        const config = execSync(
          `${this.runtime} inspect ${containerName}`,
          { encoding: 'utf-8' }
        );
        fs.writeFileSync(configBackup, config);
        itemsToBackup.push(path.basename(configBackup));
        
        if (backup) {
          backup.details = {
            ...backup.details,
            containerConfig: true
          };
        }
      }
      
      if (itemsToBackup.length === 0) {
        throw new Error(`No data to backup for ${service.name}`);
      }
      
      // Create final backup archive
      execSync(
        `tar -czf ${backupPath} -C ${backupDir} ${itemsToBackup.join(' ')}`,
        { cwd: backupDir }
      );
      
      // Clean up intermediate files
      for (const item of itemsToBackup) {
        fs.unlinkSync(path.join(backupDir, item));
      }
      
      backup.size = fs.statSync(backupPath).size;
      backup.location = backupPath;
      backup.format = 'tar';
      backup.compression = 'gzip';
      
      // Calculate checksum
      const checksum = execSync(`shasum -a 256 "${backup.location}"`, { encoding: 'utf-8' })
        .split(' ')[0];
      backup.checksum = checksum;
      
      // Set retention
      const retentionDays = requirements.annotations?.['backup/retention'] 
        ? parseInt(requirements.annotations['backup/retention'])
        : 30;
      
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + retentionDays);
      
      if (!service.quiet) {
        const sizeMB = Math.round(backup.size! / 1024 / 1024 * 100) / 100;
        printInfo(`Backup created: ${path.basename(backup.location!)} (${sizeMB} MB)`);
      }
      
      return {
        entity: service.name,
        platform: 'container',
        success: true,
        backupTime: new Date(),
        backupId,
        backup,
        retention: {
          expiresAt,
          policy: retentionDays > 30 ? 'yearly' : retentionDays > 7 ? 'monthly' : 'weekly',
          autoCleanup: true
        },
        restore: {
          supported: true,
          command: `semiont restore --service ${service.name} --backup-id ${backupId}`,
          requirements: ['Container runtime available', 'Backup file exists']
        },
        metadata: {
          platform: 'container',
          runtime: this.runtime,
          storageRequirements: requirements.storage
        }
      };
      
    } catch (error) {
      return {
        entity: service.name,
        platform: 'container',
        success: false,
        backupTime: new Date(),
        backupId,
        error: (error as Error).message
      };
    }
  }
  
  async exec(service: Service, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const requirements = service.getRequirements();
    const containerName = this.getResourceName(service);
    const execTime = new Date();
    const startTime = Date.now();
    
    // Check if container is running
    if (!this.isContainerRunning(containerName)) {
      return {
        entity: service.name,
        platform: 'container',
        success: false,
        execTime,
        command,
        error: `Container ${containerName} is not running`
      };
    }
    
    // Build exec command
    const execArgs = ['exec'];
    
    // Add user from security requirements if specified
    if (requirements.security?.runAsUser && !options.user) {
      execArgs.push('-u', requirements.security.runAsUser.toString());
    } else if (options.user) {
      execArgs.push('-u', options.user);
    }
    
    // Add environment variables
    const env = {
      ...(requirements.environment || {}),
      ...options.env
    };
    
    for (const [key, value] of Object.entries(env)) {
      execArgs.push('-e', `${key}=${value}`);
    }
    
    // Add working directory
    if (options.workingDirectory) {
      execArgs.push('-w', options.workingDirectory);
    }
    
    // Interactive and TTY options
    if (options.interactive) {
      execArgs.push('-i');
    }
    if (options.tty) {
      execArgs.push('-t');
    }
    
    execArgs.push(containerName);
    
    // Add shell or command
    const shell = options.shell || '/bin/sh';
    if (options.interactive || options.tty) {
      execArgs.push(shell);
    } else {
      execArgs.push(shell, '-c', command);
    }
    
    if (!service.quiet) {
      printInfo(`Executing in container ${containerName}: ${command}`);
    }
    
    try {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      
      const fullCommand = `${this.runtime} ${execArgs.join(' ')}`;
      
      if (options.interactive || options.tty) {
        // Interactive execution
        execSync(fullCommand, {
          stdio: 'inherit',
          timeout: options.timeout
        });
      } else if (options.captureOutput !== false) {
        // Capture output
        try {
          stdout = execSync(fullCommand, {
            encoding: 'utf-8',
            timeout: options.timeout,
            maxBuffer: 1024 * 1024 * 10 // 10MB
          });
        } catch (error: any) {
          exitCode = error.status || 1;
          stdout = error.stdout?.toString() || '';
          stderr = error.stderr?.toString() || error.message;
        }
      } else {
        // Stream output
        execSync(fullCommand, {
          stdio: 'inherit',
          timeout: options.timeout
        });
      }
      
      const duration = Date.now() - startTime;
      
      return {
        entity: service.name,
        platform: 'container',
        success: exitCode === 0,
        execTime,
        command,
        execution: {
          user: options.user || (requirements.security?.runAsUser?.toString()),
          shell,
          interactive: options.interactive || false,
          tty: options.tty || false,
          exitCode,
          duration,
          environment: undefined
        },
        output: options.captureOutput !== false ? {
          stdout,
          stderr,
          combined: stdout + (stderr ? `\n${stderr}` : '')
        } : undefined,
        streaming: {
          supported: true,
          websocketUrl: options.interactive ? 'ws://localhost:8080' : undefined
        },
        security: {
          authenticated: true,
          audit: true
        },
        error: exitCode !== 0 ? `Command exited with code ${exitCode}` : undefined
      };
      
    } catch (error) {
      return {
        entity: service.name,
        platform: 'container',
        success: false,
        execTime,
        command,
        error: (error as Error).message
      };
    }
  }
  
  async test(service: Service, options: TestOptions = {}): Promise<TestResult> {
    const requirements = service.getRequirements();
    const testTime = new Date();
    const startTime = Date.now();
    
    // Use test container if specified
    const testImage = requirements.annotations?.['test/image'] || service.getImage();
    const testCommand = requirements.annotations?.['test/command'] || 'npm test';
    
    // Create test container name
    const testContainerName = `${this.getResourceName(service)}-test-${Date.now()}`;
    
    if (!service.quiet) {
      printInfo(`Running tests for ${service.name} in container...`);
    }
    
    try {
      // Build test run command
      const runArgs = [
        'run',
        '--rm',
        '--name', testContainerName,
        '--network', `semiont-${service.environment}`
      ];
      
      // Add test environment
      const env = {
        NODE_ENV: 'test',
        CI: 'true',
        ...service.getEnvironmentVariables(),
        ...(requirements.environment || {})
      };
      
      for (const [key, value] of Object.entries(env)) {
        runArgs.push('-e', `${key}=${value}`);
      }
      
      // Mount source code if needed
      if (requirements.annotations?.['test/mount-source'] === 'true') {
        const sourcePath = path.join(service.projectRoot, 'apps', service.name);
        runArgs.push('-v', `${sourcePath}:/app`);
        runArgs.push('-w', '/app');
      }
      
      // Add coverage volume if requested
      if (options.coverage) {
        const coverageDir = path.join(service.projectRoot, 'coverage', service.name);
        fs.mkdirSync(coverageDir, { recursive: true });
        runArgs.push('-v', `${coverageDir}:/coverage`);
      }
      
      runArgs.push(testImage);
      
      // Add test command with options
      let fullTestCommand = testCommand;
      if (options.suite) {
        fullTestCommand = testCommand.replace('test', `test:${options.suite}`);
      }
      if (options.coverage) {
        fullTestCommand += ' --coverage';
      }
      // Pattern option would be added here if it existed in TestOptions
      if (options.bail) {
        fullTestCommand += ' --bail';
      }
      
      runArgs.push('sh', '-c', fullTestCommand);
      
      // Run tests
      const output = execSync(
        `${this.runtime} ${runArgs.join(' ')}`,
        {
          encoding: 'utf-8',
          timeout: options.timeout || 300000, // 5 minutes
          maxBuffer: 1024 * 1024 * 50 // 50MB
        }
      );
      
      const duration = Date.now() - startTime;
      
      // Parse test results
      const framework = requirements.annotations?.['test/framework'] || 'jest';
      const testResults = this.parseTestOutput(output, framework);
      const coverage = options.coverage ? this.parseCoverageOutput(output, framework) : undefined;
      
      // Collect metadata
      const testMetadata: any = {};
      if (options.coverage) {
        const coverageDir = path.join(service.projectRoot, 'coverage', service.name);
        if (fs.existsSync(coverageDir)) {
          testMetadata.coverageDir = coverageDir;
        }
      }
      
      return {
        entity: service.name,
        platform: 'container',
        success: true,
        testTime,
        suite: options.suite || 'unit',
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration,
        coverage,
        metadata: {
          ...testMetadata,
          framework,
          runner: 'container',
          parallel: false,
          containerName: testContainerName,
          testImage,
          testCommand: fullTestCommand
        }
      };
      
    } catch (error: any) {
      const exitCode = error.status || 1;
      const output = error.stdout?.toString() || '';
      const framework = requirements.annotations?.['test/framework'] || 'jest';
      
      // Even on failure, try to parse what we can
      const testResults = this.parseTestOutput(output, framework);
      const failures = this.parseFailures(output, framework);
      
      return {
        entity: service.name,
        platform: 'container',
        success: false,
        testTime,
        suite: options.suite || 'unit',
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: Date.now() - startTime,
        error: `Tests failed with exit code ${exitCode}`,
        metadata: {
          exitCode,
          outputLength: output.length,
          failures
        }
      };
    }
  }
  
  async restore(service: Service, backupId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const requirements = service.getRequirements();
    const containerName = this.getResourceName(service);
    const restoreTime = new Date();
    const startTime = Date.now();
    const backupDir = path.join(service.projectRoot, '.semiont', 'backups', service.environment);
    const backupPath = path.join(backupDir, `${backupId}.tar.gz`);
    
    if (!service.quiet) {
      printInfo(`Restoring ${service.name} from backup ${backupId}`);
    }
    
    if (!fs.existsSync(backupPath)) {
      return {
        entity: service.name,
        platform: 'container',
        success: false,
        restoreTime,
        backupId,
        error: `Backup not found: ${backupId}`
      };
    }
    
    try {
      // Stop container if running
      let downtimeStart: Date | undefined;
      if (options.stopService !== false) {
        downtimeStart = new Date();
        await this.stop(service);
      }
      
      // Extract backup
      const tempDir = path.join(backupDir, 'restore-temp');
      fs.mkdirSync(tempDir, { recursive: true });
      
      execSync(`tar -xzf ${backupPath} -C ${tempDir}`);
      
      // Restore volumes
      if (requirements.storage) {
        for (const storage of requirements.storage) {
          if (storage.persistent) {
            const volumeName = storage.volumeName || `${containerName}-data`;
            const volumeBackup = path.join(tempDir, `${volumeName}.tar.gz`);
            
            if (fs.existsSync(volumeBackup)) {
              // Remove old volume
              try {
                execSync(`${this.runtime} volume rm ${volumeName}`, { stdio: 'ignore' });
              } catch {
                // Volume might not exist
              }
              
              // Create new volume
              execSync(`${this.runtime} volume create ${volumeName}`);
              
              // Restore data to volume
              const tempContainer = `restore-${Date.now()}`;
              execSync(
                `${this.runtime} run --rm -d --name ${tempContainer} -v ${volumeName}:${storage.mountPath} alpine sleep 300`
              );
              
              execSync(
                `gunzip -c ${volumeBackup} | ${this.runtime} exec -i ${tempContainer} tar xf - -C /`
              );
              
              execSync(`${this.runtime} stop ${tempContainer}`);
            }
          }
        }
      }
      
      // Restore container image if included
      const imageBackup = path.join(tempDir, `${backupId}-image.tar`);
      if (fs.existsSync(imageBackup)) {
        execSync(`${this.runtime} load -i ${imageBackup}`);
      }
      
      // Clean up temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
      
      // Start service if requested
      let downtimeEnd: Date | undefined;
      let serviceStarted = false;
      
      if (options.startService !== false) {
        try {
          await this.start(service);
          serviceStarted = true;
          downtimeEnd = new Date();
        } catch (startError) {
          printWarning(`Failed to start service after restore: ${startError}`);
        }
      }
      
      // Run health check
      let healthCheckPassed = false;
      if (serviceStarted && requirements.network?.healthCheckPath) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for startup
        const checkResult = await this.check(service);
        healthCheckPassed = checkResult.health?.healthy || false;
      }
      
      const duration = Date.now() - startTime;
      
      return {
        entity: service.name,
        platform: 'container',
        success: true,
        restoreTime,
        backupId,
        restore: {
          source: backupPath,
          destination: 'container volumes',
          size: fs.statSync(backupPath).size,
          duration
        },
        validation: {
          checksumVerified: options.verifyChecksum !== false,
          dataComplete: true,
          servicesRestarted: serviceStarted,
          healthCheck: healthCheckPassed
        },
        downtime: downtimeStart && downtimeEnd ? {
          start: downtimeStart,
          end: downtimeEnd,
          duration: downtimeEnd.getTime() - downtimeStart.getTime(),
          planned: true
        } : undefined,
        metadata: {
          platform: 'container',
          runtime: this.runtime,
          restoreMethod: 'volume recreation'
        }
      };
      
    } catch (error) {
      return {
        entity: service.name,
        platform: 'container',
        success: false,
        restoreTime,
        backupId,
        error: (error as Error).message
      };
    }
  }
  
  async collectLogs(service: Service): Promise<CheckResult['logs']> {
    const containerName = this.getResourceName(service);
    
    try {
      const logs = execSync(
        `${this.runtime} logs --tail 100 ${containerName} 2>&1`,
        { encoding: 'utf-8' }
      ).split('\n').filter(line => line.trim());
      
      return {
        recent: logs.slice(-10),
        errors: logs.filter(l => l.match(/\b(error|ERROR|Error)\b/)).length,
        warnings: logs.filter(l => l.match(/\b(warning|WARNING|Warning)\b/)).length
      };
    } catch {
      return undefined;
    }
  }
  
  /**
   * Helper method to detect container runtime
   */
  protected override detectContainerRuntime(): 'docker' | 'podman' {
    try {
      execSync('docker version', { stdio: 'ignore' });
      return 'docker';
    } catch {
      try {
        execSync('podman version', { stdio: 'ignore' });
        return 'podman';
      } catch {
        throw new Error('No container runtime (Docker or Podman) found');
      }
    }
  }
  
  /**
   * Get standardized resource name for container
   */
  protected override getResourceName(service: Service): string {
    return `semiont-${service.name}-${service.environment}`;
  }
  
  /**
   * Wait for container to be ready
   */
  private async waitForContainer(containerName: string, requirements?: any): Promise<void> {
    const maxAttempts = 30;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      try {
        const status = execSync(
          `${this.runtime} inspect ${containerName} --format '{{.State.Status}}'`,
          { encoding: 'utf-8' }
        ).trim();
        
        if (status === 'running') {
          // If health check is configured, wait for it
          if (requirements?.network?.healthCheckPath) {
            try {
              const health = execSync(
                `${this.runtime} inspect ${containerName} --format '{{.State.Health.Status}}'`,
                { encoding: 'utf-8' }
              ).trim();
              
              if (health === 'healthy') {
                return;
              }
            } catch {
              // No health status yet
            }
          } else {
            return; // Container is running, no health check configured
          }
        }
      } catch {
        // Container might not exist yet
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    
    throw new Error(`Container ${containerName} failed to start within ${maxAttempts} seconds`);
  }
  
  /**
   * Check if container is running
   */
  private isContainerRunning(containerName: string): boolean {
    try {
      const status = execSync(
        `${this.runtime} inspect ${containerName} --format '{{.State.Status}}'`,
        { encoding: 'utf-8' }
      ).trim();
      return status === 'running';
    } catch {
      return false;
    }
  }
  
  /**
   * Get container ID
   */
  private async getContainerId(containerName: string): Promise<string | undefined> {
    try {
      return execSync(
        `${this.runtime} inspect ${containerName} --format '{{.Id}}'`,
        { encoding: 'utf-8' }
      ).trim().substring(0, 12);
    } catch {
      return undefined;
    }
  }
  
  /**
   * Parse test output
   */
  private parseTestOutput(output: string, framework: string): any {
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0
    };
    
    if (framework === 'jest') {
      const match = output.match(/Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/);
      if (match) {
        results.failed = parseInt(match[1]);
        results.passed = parseInt(match[2]);
        results.total = parseInt(match[3]);
      }
    } else if (framework === 'mocha') {
      const passMatch = output.match(/(\d+)\s+passing/);
      const failMatch = output.match(/(\d+)\s+failing/);
      const skipMatch = output.match(/(\d+)\s+pending/);
      
      if (passMatch) results.passed = parseInt(passMatch[1]);
      if (failMatch) results.failed = parseInt(failMatch[1]);
      if (skipMatch) results.skipped = parseInt(skipMatch[1]);
      results.total = results.passed + results.failed + results.skipped;
    }
    
    return results;
  }
  
  /**
   * Parse coverage output
   */
  private parseCoverageOutput(output: string, framework: string): any {
    const coverage: any = {};
    
    if (framework === 'jest') {
      const match = output.match(/Lines\s+:\s+([\d.]+)%.*?Branches\s+:\s+([\d.]+)%.*?Functions\s+:\s+([\d.]+)%.*?Statements\s+:\s+([\d.]+)%/s);
      if (match) {
        coverage.lines = parseFloat(match[1]);
        coverage.branches = parseFloat(match[2]);
        coverage.functions = parseFloat(match[3]);
        coverage.statements = parseFloat(match[4]);
      }
    }
    
    return Object.keys(coverage).length > 0 ? coverage : undefined;
  }
  
  /**
   * Parse test failures
   */
  private parseFailures(output: string, _framework: string): any[] {
    const failures: any[] = [];
    const failureRegex = /✕\s+(.+?)(?:\s+\([\d.]+\s*ms\))?$/gm;
    let match;
    
    while ((match = failureRegex.exec(output)) !== null) {
      failures.push({
        test: match[1],
        suite: 'unknown',
        error: 'Test failed'
      });
      
      if (failures.length >= 10) break;
    }
    
    return failures;
  }
  
  /**
   * Manage secrets using Docker/Podman secrets
   */
  override async manageSecret(
    action: 'get' | 'set' | 'list' | 'delete',
    secretPath: string,
    value?: any,
    options?: import('../../core/platform-strategy.js').SecretOptions
  ): Promise<import('../../core/platform-strategy.js').SecretResult> {
    const secretName = this.formatSecretName(secretPath, options?.environment);
    
    try {
      switch (action) {
        case 'get': {
          // Docker/Podman secrets are write-only, can't read their values directly
          // We can only check if they exist
          try {
            execSync(`${this.runtime} secret inspect ${secretName}`, { stdio: 'ignore' });
            return {
              success: true,
              action,
              secretPath,
              value: '[SECRET EXISTS BUT CANNOT BE READ]',
              platform: 'container',
              storage: `${this.runtime}-secret`,
              metadata: {
                note: 'Container secrets are write-only for security'
              }
            };
          } catch {
            return {
              success: false,
              action,
              secretPath,
              platform: 'container',
              storage: `${this.runtime}-secret`,
              error: `Secret not found: ${secretPath}`
            };
          }
        }
        
        case 'set': {
          const secretValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
          
          // First, try to remove existing secret if it exists
          try {
            execSync(`${this.runtime} secret rm ${secretName}`, { stdio: 'ignore' });
          } catch {
            // Secret doesn't exist, that's fine
          }
          
          // Create new secret
          try {
            execSync(`echo '${secretValue}' | ${this.runtime} secret create ${secretName} -`, {
              encoding: 'utf-8'
            });
            
            return {
              success: true,
              action,
              secretPath,
              platform: 'container',
              storage: `${this.runtime}-secret`,
              metadata: {
                secretName
              }
            };
          } catch (error) {
            return {
              success: false,
              action,
              secretPath,
              platform: 'container',
              storage: `${this.runtime}-secret`,
              error: `Failed to create secret: ${(error as Error).message}`
            };
          }
        }
        
        case 'list': {
          try {
            const output = execSync(
              `${this.runtime} secret ls --format '{{.Name}}'`,
              { encoding: 'utf-8' }
            );
            
            const allSecrets = output.trim().split('\n').filter(s => s);
            const prefix = this.formatSecretName(secretPath, options?.environment);
            
            const matchingSecrets = allSecrets
              .filter(name => name.startsWith(prefix))
              .map(name => this.extractSecretPath(name));
            
            return {
              success: true,
              action,
              secretPath,
              values: matchingSecrets,
              platform: 'container',
              storage: `${this.runtime}-secret`,
              metadata: {
                totalFound: matchingSecrets.length
              }
            };
          } catch (error) {
            return {
              success: false,
              action,
              secretPath,
              platform: 'container',
              storage: `${this.runtime}-secret`,
              error: `Failed to list secrets: ${(error as Error).message}`
            };
          }
        }
        
        case 'delete': {
          try {
            execSync(`${this.runtime} secret rm ${secretName}`, { stdio: 'ignore' });
            return {
              success: true,
              action,
              secretPath,
              platform: 'container',
              storage: `${this.runtime}-secret`
            };
          } catch {
            // Already deleted or doesn't exist
            return {
              success: true,
              action,
              secretPath,
              platform: 'container',
              storage: `${this.runtime}-secret`
            };
          }
        }
        
        default:
          return {
            success: false,
            action,
            secretPath,
            platform: 'container',
            error: `Unknown action: ${action}`
          };
      }
    } catch (error) {
      return {
        success: false,
        action,
        secretPath,
        platform: 'container',
        storage: `${this.runtime}-secret`,
        error: (error as Error).message
      };
    }
  }
  
  /**
   * Format secret name for container runtime
   */
  private formatSecretName(secretPath: string, environment?: string): string {
    // Container secret names: semiont_env_path
    if (!environment) {
      throw new Error('Environment is required for secret management');
    }
    const formattedPath = secretPath.replace(/[\/\-\.]/g, '_');
    return `semiont_${environment}_${formattedPath}`;
  }
  
  /**
   * Extract secret path from container secret name
   */
  private extractSecretPath(secretName: string): string {
    // Extract path from names like: semiont_production_oauth_google
    const parts = secretName.split('_');
    if (parts.length >= 3 && parts[0] === 'semiont') {
      // Skip 'semiont' and environment, join rest with /
      return parts.slice(2).join('/');
    }
    return secretName;
  }
  
  /**
   * Quick check if a container is running using saved state
   * This is faster than doing a full check() call
   */
  override async quickCheckRunning(state: import('../../core/state-manager.js').ServiceState): Promise<boolean> {
    if (!state.resources || state.resources.platform !== 'container') {
      return false;
    }
    
    const containerId = state.resources.data.containerId;
    if (!containerId) {
      return false;
    }
    
    try {
      const status = execSync(
        `${this.runtime} inspect ${containerId} --format '{{.State.Status}}'`,
        { encoding: 'utf-8', stdio: 'pipe' }
      ).trim();
      
      return status === 'running';
    } catch {
      // Container doesn't exist or error checking
      return false;
    }
  }
}