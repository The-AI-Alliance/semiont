/**
 * Multi-Service Executor
 * 
 * Executes a single command across multiple service deployments.
 * Provides consistent execution patterns including error handling,
 * service instantiation, handler resolution, and result aggregation.
 */

import { ServicePlatformInfo } from './service-resolver.js';
import { PlatformType, EnvironmentConfig } from '@semiont/core';
import { Service } from './service-interface.js';
import { ServiceName } from './service-discovery.js';
import { ServiceFactory } from '../services/service-factory.js';
import { Platform } from './platform.js';
import { CommandDescriptor } from './command-descriptor.js';
import { CommandResult, createCommandResult } from './command-result.js';
import { CommandResults } from './command-types.js';
import { HandlerRegistry } from './handlers/registry.js';
import { HandlerContextBuilder } from './handlers/context.js';
import { HandlerResult, PreflightResult, CommandName } from './handlers/types.js';
import { Config, ServiceConfig } from './cli-config.js';
import { parseEnvironment } from '@semiont/core';
import { printError, printInfo, printWarning, printSuccess } from './io/cli-logger.js';
import { serviceSupportsCommand } from './service-command-capabilities.js';

/**
 * Options that all commands have
 * Must match BaseOptionsSchema for type compatibility
 */
interface BaseOptions {
  environment?: string;  // Optional to match schema, but validated before use
  verbose?: boolean;
  quiet?: boolean;
  dryRun?: boolean;
  output?: string;
  forceDiscovery?: boolean;
  preflight?: boolean;
}

/**
 * Executor that runs a command across multiple services
 */
export class MultiServiceExecutor<TOptions extends BaseOptions> {
  constructor(
    private descriptor: CommandDescriptor<TOptions>
  ) {}
  
  /**
   * Execute the command for all service deployments
   *
   * @param serviceDeployments - Service deployments to execute command on
   * @param options - Command options
   * @param envConfig - Environment configuration (passed from entry point, includes projectRoot in _metadata)
   */
  async execute(
    serviceDeployments: ServicePlatformInfo[],
    options: TOptions,
    envConfig: EnvironmentConfig
  ): Promise<CommandResults<CommandResult>> {
    const startTime = Date.now();

    const environment = envConfig._metadata?.environment;
    if (!environment) {
      throw new Error('Environment is required in envConfig._metadata');
    }

    // Apply defaults and validate
    const finalOptions = {
      ...this.descriptor.defaultOptions,
      ...options,
      environment  // Ensure environment is always set
    } as TOptions;
    
    this.descriptor.validateOptions?.(finalOptions);
    
    // Pre-execution hook (e.g., for synthetic services)
    const services = this.descriptor.preExecute 
      ? await this.descriptor.preExecute(serviceDeployments, finalOptions)
      : serviceDeployments;
    
    // Determine output mode
    const isStructuredOutput = finalOptions.output &&
      ['json', 'yaml', 'table'].includes(finalOptions.output);

    // Preflight-only mode: run this command's own preflights and return
    if (finalOptions.preflight) {
      if (!isStructuredOutput && !finalOptions.quiet) {
        printInfo(`Running preflight checks for '${this.descriptor.name}' in ${finalOptions.environment} environment`);
      }

      const results = await this.runOwnPreflights(services, finalOptions, envConfig);

      return {
        command: this.descriptor.name,
        environment: finalOptions.environment!,
        timestamp: new Date(),
        duration: Date.now() - startTime,
        results,
        summary: {
          total: results.length,
          succeeded: results.filter(r => r.success).length,
          failed: results.filter(r => !r.success).length,
          warnings: 0
        },
        executionContext: {
          user: process.env.USER || 'unknown',
          workingDirectory: process.cwd(),
          dryRun: true
        }
      };
    }

    if (!isStructuredOutput && !finalOptions.quiet) {
      printInfo(`Executing ${this.descriptor.name} command in ${finalOptions.environment} environment`);
    }

    // Execute all services
    const results: CommandResult[] = [];

    for (const serviceInfo of services) {
      try {
        const result = await this.executeService(serviceInfo, finalOptions, envConfig);
        results.push(result);

        if (!isStructuredOutput && !finalOptions.quiet && !result.success && result.error) {
          printError(`Failed to ${this.descriptor.name} ${serviceInfo.name}: ${result.error}`);
        }
      } catch (error) {
        // Handle execution errors
        const errorResult = this.descriptor.handleExecutionError?.(
          error as Error,
          serviceInfo,
          finalOptions
        ) || createCommandResult({
          entity: serviceInfo.name as ServiceName,
          platform: serviceInfo.platform as PlatformType,
          success: false,
          error: (error as Error).message,
          metadata: {
            errorType: 'execution_failure',
            errorStack: (error as Error).stack
          }
        });

        results.push(errorResult);

        if (!this.descriptor.continueOnError) {
          break;  // Stop executing if continueOnError is false
        }
      }
    }

    // Post-execution hook
    if (this.descriptor.postExecute) {
      await this.descriptor.postExecute(results, finalOptions);
    }

    // Run preflight checks for the next command in the chain
    if (this.descriptor.nextCommand) {
      await this.runPreflightsForCommand(
        this.descriptor.nextCommand,
        services,
        finalOptions,
        envConfig
      );
    }

    // Create command results
    return {
      command: this.descriptor.name,
      environment: finalOptions.environment!,  // Will be validated to exist
      timestamp: new Date(),
      duration: Date.now() - startTime,
      results,
      summary: {
        total: results.length,
        succeeded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        warnings: 0
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: finalOptions.dryRun || false
      }
    };
  }
  
  /**
   * Execute a single service
   */
  private async executeService(
    serviceInfo: ServicePlatformInfo,
    options: TOptions,
    envConfig: EnvironmentConfig
  ): Promise<CommandResult> {
    // 1. Get platform strategy
    const { PlatformFactory } = await import('../platforms/index.js');
    const platform = await PlatformFactory.getPlatform(serviceInfo.platform);

    // 2. Create config object (environment and projectRoot from envConfig._metadata)
    const environment = envConfig._metadata?.environment;
    if (!environment) {
      throw new Error('Environment is required in envConfig._metadata');
    }
    const projectRoot = envConfig._metadata?.projectRoot ?? null;

    // Get available environments for validation
    const { getAvailableEnvironments } = await import('../core/config-loader.js');
    const availableEnvironments = getAvailableEnvironments();

    const config: Config = {
      projectRoot,
      environment: parseEnvironment(environment, availableEnvironments),
      verbose: options.verbose || false,
      quiet: options.quiet || false,
      dryRun: options.dryRun || false
    };

    // 3. Build service-specific configuration
    const serviceConfig = this.descriptor.buildServiceConfig(options, serviceInfo);

    // 4. Create service instance
    const service = ServiceFactory.create(
      serviceInfo.name as ServiceName,
      serviceInfo.platform,
      config,
      envConfig,
      {
        ...serviceInfo.config,
        ...serviceConfig,
        platform: { type: serviceInfo.platform }
      } as ServiceConfig
    );
    
    // 5. Determine service type
    const serviceType = platform.determineServiceType(service);
    
    // 6. Get handler from registry
    const registry = HandlerRegistry.getInstance();
    const handlerDescriptor = registry.getHandlerForCommand(
      this.descriptor.name,
      platform.getPlatformName(),
      serviceType
    );
    
    if (!handlerDescriptor) {
      // Platform doesn't manage lifecycle → skip silently
      if (!platform.managesLifecycle()) {
        return this.descriptor.buildResult(
          {
            success: true,
            metadata: { serviceType, skipped: true, reason: `${platform.getPlatformName()} does not manage lifecycle` }
          },
          service,
          platform,
          serviceType
        );
      }

      // Service opted out of this command via capability annotations → skip
      const annotations = service.getRequirements().annotations;
      if (!serviceSupportsCommand(annotations, this.descriptor.name)) {
        return this.descriptor.buildResult(
          {
            success: true,
            metadata: { serviceType, skipped: true, reason: `${serviceType} does not support ${this.descriptor.name}` }
          },
          service,
          platform,
          serviceType
        );
      }

      // Handler genuinely missing — error
      return this.descriptor.buildResult(
        {
          success: false,
          error: `No ${this.descriptor.name} handler for ${serviceType} on ${platform.getPlatformName()}`,
          metadata: { serviceType }
        },
        service,
        platform,
        serviceType
      );
    }
    
    // 7. Build handler context
    const handlerOptions = this.descriptor.extractHandlerOptions(options);
    const contextExtensions = await platform.buildHandlerContextExtensions(
      service,
      handlerDescriptor.requiresDiscovery || false
    );
    
    const baseContext = HandlerContextBuilder.buildBaseContext(
      service, 
      platform,  // Pass the platform object, not just its name
      handlerOptions  // Pass options to base context
    );
    const context = HandlerContextBuilder.extend(baseContext, contextExtensions);
    
    // 8. Execute handler
    const handlerResult = await handlerDescriptor.handler(context);
    
    // 9. Transform handler result to command result
    return this.descriptor.buildResult(
      handlerResult,
      service,
      platform,
      serviceType
    );
  }
  
  /**
   * Run this command's own preflight checks across all services.
   * Used when --preflight flag is passed. Returns CommandResult[] where
   * failed preflights produce success: false results.
   */
  private async runOwnPreflights(
    serviceDeployments: ServicePlatformInfo[],
    options: TOptions,
    envConfig: EnvironmentConfig
  ): Promise<CommandResult[]> {
    const environment = envConfig._metadata?.environment;
    if (!environment) return [];
    const projectRoot = envConfig._metadata?.projectRoot ?? null;

    const { PlatformFactory } = await import('../platforms/index.js');
    const { getAvailableEnvironments } = await import('../core/config-loader.js');
    const availableEnvironments = getAvailableEnvironments();
    const registry = HandlerRegistry.getInstance();

    const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
    const results: CommandResult[] = [];

    for (const serviceInfo of serviceDeployments) {
      try {
        const platform = await PlatformFactory.getPlatform(serviceInfo.platform);
        const config: Config = {
          projectRoot,
          environment: parseEnvironment(environment, availableEnvironments),
          verbose: options.verbose || false,
          quiet: options.quiet || false,
          dryRun: true,
        };

        const serviceConfig = this.descriptor.buildServiceConfig(options, serviceInfo);
        const service = ServiceFactory.create(
          serviceInfo.name as ServiceName,
          serviceInfo.platform,
          config,
          envConfig,
          {
            ...serviceInfo.config,
            ...serviceConfig,
            platform: { type: serviceInfo.platform },
          } as ServiceConfig
        );

        const serviceType = platform.determineServiceType(service);

        const descriptor = registry.getHandlerForCommand(
          this.descriptor.name,
          platform.getPlatformName(),
          serviceType
        );
        if (!descriptor) {
          // Platform doesn't manage lifecycle → skip
          if (!platform.managesLifecycle()) {
            results.push(createCommandResult({
              entity: serviceInfo.name as ServiceName,
              platform: serviceInfo.platform as PlatformType,
              success: true,
              metadata: { serviceType, skipped: true, reason: `${platform.getPlatformName()} does not manage lifecycle` }
            }));
            continue;
          }

          // Service opted out via annotations → skip
          const annotations = service.getRequirements().annotations;
          if (!serviceSupportsCommand(annotations, this.descriptor.name)) {
            results.push(createCommandResult({
              entity: serviceInfo.name as ServiceName,
              platform: serviceInfo.platform as PlatformType,
              success: true,
              metadata: { serviceType, skipped: true, reason: `${serviceType} does not support ${this.descriptor.name}` }
            }));
            continue;
          }

          // Handler genuinely missing — error
          results.push(createCommandResult({
            entity: serviceInfo.name as ServiceName,
            platform: serviceInfo.platform as PlatformType,
            success: false,
            error: `No ${this.descriptor.name} handler for ${serviceType} on ${platform.getPlatformName()}`,
            metadata: { serviceType }
          }));
          continue;
        }

        const handlerOptions = this.descriptor.extractHandlerOptions(options);
        const contextExtensions = await platform.buildHandlerContextExtensions(
          service,
          descriptor.requiresDiscovery || false
        );
        const baseContext = HandlerContextBuilder.buildBaseContext(service, platform, handlerOptions);
        const context = HandlerContextBuilder.extend(baseContext, contextExtensions);

        const preflight = await descriptor.preflight(context);

        // Print check results
        if (!isStructuredOutput && !options.quiet) {
          for (const check of preflight.checks) {
            if (check.pass) {
              printSuccess(`  ${serviceInfo.name}: ${check.message}`);
            } else {
              printWarning(`  ${serviceInfo.name}: ${check.message}`);
            }
          }
        }

        results.push(createCommandResult({
          entity: serviceInfo.name as ServiceName,
          platform: serviceInfo.platform as PlatformType,
          success: preflight.pass,
          error: preflight.pass ? undefined : preflight.checks.filter(c => !c.pass).map(c => c.message).join('; '),
          metadata: { serviceType, preflight: true, checks: preflight.checks }
        }));
      } catch (error) {
        results.push(createCommandResult({
          entity: serviceInfo.name as ServiceName,
          platform: serviceInfo.platform as PlatformType,
          success: false,
          error: `Preflight resolution failed: ${(error as Error).message}`,
          metadata: { preflight: true }
        }));
      }
    }

    return results;
  }

  /**
   * Run preflight checks for a different command's handlers across all services.
   * Called after the current command completes to validate preconditions for the next command.
   */
  async runPreflightsForCommand(
    nextCommand: CommandName,
    serviceDeployments: ServicePlatformInfo[],
    options: TOptions,
    envConfig: EnvironmentConfig
  ): Promise<void> {
    const environment = envConfig._metadata?.environment;
    if (!environment) return;
    const projectRoot = envConfig._metadata?.projectRoot ?? null;

    const quiet = options.quiet || false;
    const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
    if (isStructuredOutput) return;

    const { PlatformFactory } = await import('../platforms/index.js');
    const { getAvailableEnvironments } = await import('../core/config-loader.js');
    const availableEnvironments = getAvailableEnvironments();
    const registry = HandlerRegistry.getInstance();

    const allChecks: { service: string; result: PreflightResult }[] = [];

    for (const serviceInfo of serviceDeployments) {
      try {
        const platform = await PlatformFactory.getPlatform(serviceInfo.platform);
        const config: Config = {
          projectRoot,
          environment: parseEnvironment(environment, availableEnvironments),
          verbose: options.verbose || false,
          quiet: true,  // Suppress output during preflight resolution
          dryRun: options.dryRun || false,
        };

        const service = ServiceFactory.create(
          serviceInfo.name as ServiceName,
          serviceInfo.platform,
          config,
          envConfig,
          {
            ...serviceInfo.config,
            platform: { type: serviceInfo.platform },
          } as ServiceConfig
        );

        const serviceType = platform.determineServiceType(service);

        // Skip if platform doesn't manage lifecycle or service doesn't support this command
        if (!platform.managesLifecycle()) continue;
        const annotations = service.getRequirements().annotations;
        if (!serviceSupportsCommand(annotations, nextCommand)) continue;

        const descriptor = registry.getHandlerForCommand(
          nextCommand,
          platform.getPlatformName(),
          serviceType
        );
        if (!descriptor) continue;

        const contextExtensions = await platform.buildHandlerContextExtensions(
          service,
          descriptor.requiresDiscovery || false
        );
        const baseContext = HandlerContextBuilder.buildBaseContext(
          service,
          platform,
          options as Record<string, unknown>,
        );
        const context = HandlerContextBuilder.extend(baseContext, contextExtensions);

        const result = await descriptor.preflight(context);
        allChecks.push({ service: serviceInfo.name, result });
      } catch {
        // Preflight resolution failed — skip this service silently
      }
    }

    if (allChecks.length === 0) return;

    const failedChecks = allChecks.filter(c => !c.result.pass);
    if (failedChecks.length === 0 && !options.verbose) return;

    if (!quiet) {
      printInfo(`\nPreflight checks for '${nextCommand}':`);
      for (const { service, result } of allChecks) {
        if (result.checks.length === 0) continue;
        for (const check of result.checks) {
          if (check.pass) {
            if (options.verbose) {
              printSuccess(`  ${service}: ${check.message}`);
            }
          } else {
            printWarning(`  ${service}: ${check.message}`);
          }
        }
      }
    }
  }

  /**
   * Create a simple executor for commands without special requirements
   */
  static createSimple<TOptions extends BaseOptions>(
    commandName: CommandName,
    resultBuilder: (result: HandlerResult, service: Service, platform: Platform) => CommandResult
  ): MultiServiceExecutor<TOptions> {
    return new MultiServiceExecutor<TOptions>({
      name: commandName,
      buildResult: resultBuilder,
      buildServiceConfig: (options, serviceInfo) => ({
        ...serviceInfo.config,
        ...options
      }),
      extractHandlerOptions: (options) => options as Record<string, any>,
      continueOnError: true,
      supportsAll: true
    });
  }
}