/**
 * Base class for all CLI commands
 * Provides common functionality and consistent patterns
 */

import { z } from 'zod';
import { CliLogger } from './cli-logger.js';
import { getProjectRoot } from './cli-paths.js';
import { parseCommandArgs, BaseOptionsSchema } from './argument-parser.js';

export abstract class BaseCommand<TOptions extends z.ZodRawShape> {
  protected logger: CliLogger;
  protected projectRoot: string;
  protected options: z.infer<z.ZodObject<TOptions>>;

  constructor(
    protected schema: z.ZodObject<TOptions>, 
    protected commandName: string,
    importMetaUrl: string
  ) {
    // Parse arguments and create logger
    this.options = this.parseArgs();
    this.logger = new CliLogger(this.options.verbose);
    this.projectRoot = getProjectRoot(importMetaUrl);
  }

  /**
   * Parse command arguments using the standardized approach
   */
  protected parseArgs(): z.infer<z.ZodObject<TOptions>> {
    return parseCommandArgs(this.schema as any, this.commandName) as z.infer<z.ZodObject<TOptions>>;
  }

  /**
   * Validate environment if needed
   */
  protected validateEnvironment(): void {
    if (!this.options.environment) {
      this.logger.error(`--environment is required for ${this.commandName}`);
      process.exit(1);
    }

  }

  /**
   * Execute the command (implemented by subclasses)
   */
  abstract execute(): Promise<void>;

  /**
   * Run the command with error handling
   */
  async run(): Promise<void> {
    try {
      await this.execute();
    } catch (error) {
      this.logger.error(`${this.commandName} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.options.verbose && error instanceof Error) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  }
}

/**
 * Utility to create a command that can be run directly
 */
export function createCommand<TOptions extends z.ZodRawShape>(
  CommandClass: new (importMetaUrl: string) => BaseCommand<TOptions>,
  importMetaUrl: string
): void {
  if (importMetaUrl === `file://${process.argv[1]}`) {
    const command = new CommandClass(importMetaUrl);
    command.run();
  }
}