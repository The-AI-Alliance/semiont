/**
 * Multi-Service Executor
 * 
 * Executes a single command across multiple service deployments.
 * Provides consistent execution patterns including error handling,
 * service instantiation, handler resolution, and result aggregation.
 */

import { ServicePlatformInfo, Platform } from './platform-resolver.js';
import { Service } from '../services/types.js';
import { ServiceName } from './service-discovery.js';
import { ServiceFactory } from '../services/service-factory.js';
import { PlatformStrategy } from './platform-strategy.js';
import { CommandDescriptor } from './command-descriptor.js';
import { CommandResult, createCommandResult } from './command-result.js';
import { CommandResults } from './command-results.js';
import { HandlerRegistry } from './handlers/registry.js';
import { HandlerContextBuilder } from './handlers/context.js';
import { HandlerResult } from './handlers/types.js';
import { Config } from './cli-config.js';
import { parseEnvironment } from './environment-validator.js';
import { printError, printInfo } from './io/cli-logger.js';

// Get project root (user's project directory, NOT the Semiont source repo)
const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

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
   */
  async execute(
    serviceDeployments: ServicePlatformInfo[],
    options: TOptions
  ): Promise<CommandResults<CommandResult>> {
    const startTime = Date.now();
    
    // Resolve environment: --environment flag takes precedence over SEMIONT_ENV
    const environment = options.environment || process.env.SEMIONT_ENV;
    if (!environment) {
      throw new Error(
        'Environment is required. Specify --environment flag or set SEMIONT_ENV environment variable'
      );
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
    
    if (!isStructuredOutput && !finalOptions.quiet) {
      printInfo(`Executing ${this.descriptor.name} command in ${finalOptions.environment} environment`);
    }
    
    // Execute all services
    const results: CommandResult[] = [];
    
    for (const serviceInfo of services) {
      try {
        const result = await this.executeService(serviceInfo, finalOptions);
        results.push(result);
        
        if (!isStructuredOutput && !finalOptions.quiet && !result.success) {
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
          platform: serviceInfo.platform as Platform,
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
    options: TOptions
  ): Promise<CommandResult> {
    // 1. Get platform strategy
    const { PlatformFactory } = await import('../platforms/index.js');
    const platform = PlatformFactory.getPlatform(serviceInfo.platform);
    
    // 2. Create config object (environment is guaranteed to exist from execute())
    const config: Config = {
      projectRoot: PROJECT_ROOT,
      environment: parseEnvironment(options.environment!),
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
      { 
        ...serviceInfo.config, 
        ...serviceConfig,
        platform: serviceInfo.platform 
      }
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
      // No handler found - return error result
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
   * Create a simple executor for commands without special requirements
   */
  static createSimple<TOptions extends BaseOptions>(
    commandName: string,
    resultBuilder: (result: HandlerResult, service: Service, platform: PlatformStrategy) => CommandResult
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