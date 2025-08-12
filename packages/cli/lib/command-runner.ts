/**
 * Secure command execution utility
 * Prevents injection attacks and provides safe process execution
 */

import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { CommandOptions, CommandResult, ScriptError } from './types.js';
import { validateCommand } from './validators.js';
import { logger } from './logger.js';
import { getNodeEnvForEnvironment } from './deployment-resolver.js';

export class CommandRunner {
  private defaultTimeout: number;
  private defaultCwd: string;

  constructor(defaultTimeout: number = 30000, defaultCwd: string = process.cwd()) {
    this.defaultTimeout = defaultTimeout;
    this.defaultCwd = defaultCwd;
  }

  /**
   * Execute command synchronously with security checks
   */
  execSync(command: string, options: CommandOptions = {}): CommandResult {
    const validation = validateCommand(command);
    if (!validation.success) {
      throw new ScriptError(`Invalid command: ${validation.error}`, 'COMMAND_VALIDATION_ERROR');
    }

    const safeCommand = validation.data!;
    const execOptions = {
      cwd: options.cwd || this.defaultCwd,
      timeout: options.timeout || this.defaultTimeout,
      encoding: 'utf8' as const,
      env: { ...process.env, ...options.env },
      maxBuffer: 10 * 1024 * 1024, // 10MB max buffer
    };

    logger.debug('Executing command', { 
      command: safeCommand.substring(0, 100),
      cwd: execOptions.cwd,
      timeout: execOptions.timeout
    });

    try {
      const stdout = execSync(safeCommand, execOptions);
      
      logger.debug('Command completed successfully', {
        command: safeCommand.substring(0, 50),
        outputLength: stdout.length
      });

      return {
        success: true,
        stdout: stdout.toString(),
        code: 0
      };
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown command error';
      const stderr = error.stderr?.toString() || '';
      const code = error.status || 1;

      logger.error('Command execution failed', {
        command: safeCommand.substring(0, 50),
        code,
        error: errorMessage.substring(0, 200)
      });

      return {
        success: false,
        stderr,
        code,
      };
    }
  }

  /**
   * Execute command asynchronously with streaming output
   */
  async execAsync(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    const validation = validateCommand(command);
    if (!validation.success) {
      throw new ScriptError(`Invalid command: ${validation.error}`, 'COMMAND_VALIDATION_ERROR');
    }

    const safeCommand = validation.data!;
    
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = safeCommand.split(' ');
      
      const child: ChildProcessWithoutNullStreams = spawn(cmd!, args, {
        cwd: options.cwd || this.defaultCwd,
        env: { ...process.env, ...options.env },
        stdio: 'pipe'
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new ScriptError('Command timeout', 'COMMAND_TIMEOUT'));
      }, options.timeout || this.defaultTimeout);

      child.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          resolve({
            success: true,
            stdout,
            code
          });
        } else {
          resolve({
            success: false,
            stderr,
            code: code || 1
          });
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(new ScriptError(`Command execution error: ${error.message}`, 'COMMAND_EXEC_ERROR'));
      });
    });
  }

  /**
   * Execute AWS CLI command with additional safety checks
   */
  execAwsCommand(command: string, options: CommandOptions = {}): CommandResult {
    if (!command.startsWith('aws ')) {
      throw new ScriptError('AWS command must start with "aws "', 'INVALID_AWS_COMMAND');
    }

    // Add standard AWS CLI options for safety
    const safeCommand = `${command} --output json --no-cli-pager`;
    
    return this.execSync(safeCommand, {
      ...options,
      timeout: options.timeout || 60000, // AWS commands may take longer
    });
  }

  /**
   * Execute npm command with additional safety checks
   */
  execNpmCommand(command: string, options: CommandOptions = {}): CommandResult {
    if (!command.startsWith('npm ')) {
      throw new ScriptError('NPM command must start with "npm "', 'INVALID_NPM_COMMAND');
    }

    // Prevent potentially dangerous npm scripts
    const dangerousPatterns = ['postinstall', 'preinstall', 'prepare'];
    const hasDangerous = dangerousPatterns.some(pattern => command.includes(pattern));
    
    if (hasDangerous) {
      logger.warn('Potentially dangerous npm command detected', { command });
    }

    return this.execSync(command, options);
  }

  /**
   * Execute CDK command with proper error handling
   */
  execCdkCommand(command: string, options: CommandOptions = {}): CommandResult {
    if (!command.startsWith('cdk ') && !command.startsWith('npx cdk ')) {
      throw new ScriptError('CDK command must start with "cdk " or "npx cdk "', 'INVALID_CDK_COMMAND');
    }

    return this.execSync(command, {
      ...options,
      timeout: options.timeout || 300000, // CDK commands can take up to 5 minutes
    });
  }

  /**
   * Test if a command exists and is executable
   */
  commandExists(command: string): boolean {
    try {
      const result = this.execSync(`which ${command}`, { timeout: 5000 });
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * Get safe environment for command execution
   */
  getSafeEnv(additionalVars: Record<string, string> = {}, environment?: string): Record<string, string> {
    // Start with clean environment
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      USER: process.env.USER || '',
      NODE_ENV: environment ? getNodeEnvForEnvironment(environment) : (process.env.NODE_ENV || 'production'),
    };

    // Add AWS_REGION only if it's actually set
    if (process.env.AWS_REGION) {
      safeEnv.AWS_REGION = process.env.AWS_REGION;
    }

    // Add AWS credentials if available
    const awsVars = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE'];
    awsVars.forEach(key => {
      if (process.env[key]) {
        safeEnv[key] = process.env[key]!;
      }
    });

    return { ...safeEnv, ...additionalVars };
  }
}

// Default command runner instance
export const commandRunner = new CommandRunner();

// Convenience functions
export const exec = {
  sync: (cmd: string, opts?: CommandOptions) => commandRunner.execSync(cmd, opts),
  async: (cmd: string, opts?: CommandOptions) => commandRunner.execAsync(cmd, opts),
  aws: (cmd: string, opts?: CommandOptions) => commandRunner.execAwsCommand(cmd, opts),
  npm: (cmd: string, opts?: CommandOptions) => commandRunner.execNpmCommand(cmd, opts),
  cdk: (cmd: string, opts?: CommandOptions) => commandRunner.execCdkCommand(cmd, opts),
};