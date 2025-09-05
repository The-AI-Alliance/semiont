/**
 * Check Command - Unified Executor Implementation
 * 
 * Performs health checks and status verification for running services
 * using the new UnifiedExecutor architecture.
 */

import { z } from 'zod';
import { ServicePlatformInfo } from '../platform-resolver.js';
import { CommandResult, createCommandResult } from '../command-result.js';
import { CommandDescriptor, createCommandDescriptor } from '../command-descriptor.js';
import { UnifiedExecutor } from '../unified-executor.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema } from '../base-options-schema.js';
import { PlatformStrategy } from '../platform-strategy.js';
import { Service } from '../../services/types.js';
import { HandlerResult } from '../handlers/types.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const CheckOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  all: z.boolean().default(false),
  deep: z.boolean().default(true),  // Deep checking on by default
  wait: z.boolean().default(false),
  timeout: z.number().optional(),
});

type CheckOptions = z.output<typeof CheckOptionsSchema>;

// =====================================================================
// COMMAND DESCRIPTOR
// =====================================================================

const checkDescriptor: CommandDescriptor<CheckOptions> = createCommandDescriptor({
  name: 'check',
  
  defaultOptions: {
    deep: true,  // Deep dependency checking on by default
    wait: false,
    all: false,
  } as Partial<CheckOptions>,
  
  buildServiceConfig: (options, serviceInfo) => ({
    ...serviceInfo.config,
    platform: serviceInfo.platform,
    deep: options.deep,
    wait: options.wait,
    timeout: options.timeout,
  }),
  
  extractHandlerOptions: (options) => ({
    deep: options.deep,
    wait: options.wait,
    timeout: options.timeout,
    all: options.all,
  }),
  
  buildResult: (handlerResult: HandlerResult, service: Service, platform: PlatformStrategy, serviceType: string): CommandResult => {
    // Type guard for check-specific results
    const checkResult = handlerResult as any; // CheckHandlerResult
    
    return createCommandResult({
      entity: service.name,
      platform: platform.getPlatformName() as any,
      success: handlerResult.success,
      error: handlerResult.error,
      metadata: {
        ...handlerResult.metadata,
        serviceType,
        stateVerified: checkResult.stateVerified,
        stateMismatch: checkResult.stateMismatch,
      }
    }, {
      status: checkResult.status || 'unknown',
      health: checkResult.health,
      logs: checkResult.logs,
      resources: checkResult.platformResources,
      dependencies: checkResult.dependencies,  // For deep checking
    });
  },
  
  // Environment validation is handled by UnifiedExecutor
  
  continueOnError: true,  // Continue checking all services even if one fails
  supportsAll: true,
});

// =====================================================================
// EXECUTOR INSTANCE
// =====================================================================

const checkExecutor = new UnifiedExecutor(checkDescriptor);

// =====================================================================
// COMMAND EXPORT
// =====================================================================

/**
 * Main check command function
 */
export async function check(
  serviceDeployments: ServicePlatformInfo[],
  options: CheckOptions
) {
  return checkExecutor.execute(serviceDeployments, options);
}

// CheckResult type alias removed - use CommandResult directly

// =====================================================================
// COMMAND DEFINITION (for CLI)
// =====================================================================

export const checkCommand = new CommandBuilder()
  .name('check')
  .description('Check status and health of services')
  .examples(
    'semiont check --service frontend',
    'semiont check --all',
    'semiont check --deep --wait'
  )
  .args({
    args: {
      '--service': {
        type: 'string',
        description: 'Service to check (or "all" for all services)',
      },
      '--all': {
        type: 'boolean',
        description: 'Check all services',
        default: false,
      },
      '--deep': {
        type: 'boolean',
        description: 'Run deep health checks',
        default: false,
      },
      '--wait': {
        type: 'boolean',
        description: 'Wait for services to become healthy',
        default: false,
      },
      '--timeout': {
        type: 'number',
        description: 'Timeout in seconds when using --wait',
        default: 60,
      },
    },
    aliases: {
      '-s': '--service',
    },
  })
  .schema(CheckOptionsSchema)
  .handler(check)
  .build();