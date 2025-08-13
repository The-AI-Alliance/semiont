/**
 * Shared logging utilities for CLI commands
 */

import { colors } from './cli-colors.js';

// Global flag to control output suppression for structured formats
let globalSuppressOutput = false;

/**
 * Set the global output suppression state
 * @param suppress - Whether to suppress output
 * @returns The previous suppression state
 */
export function setSuppressOutput(suppress: boolean): boolean {
  const previous = globalSuppressOutput;
  globalSuppressOutput = suppress;
  return previous;
}

/**
 * Get the current output suppression state
 */
export function getSuppressOutput(): boolean {
  return globalSuppressOutput;
}

export class CliLogger {
  private verbose: boolean;
  private suppressOutput: boolean;

  constructor(verbose: boolean = false, suppressOutput: boolean = false) {
    this.verbose = verbose;
    this.suppressOutput = suppressOutput;
  }

  error(message: string): void {
    if (!this.suppressOutput && !globalSuppressOutput) {
      console.error(`${colors.red}❌ ${message}${colors.reset}`);
    }
  }

  success(message: string): void {
    if (!this.suppressOutput && !globalSuppressOutput) {
      console.log(`${colors.green}✅ ${message}${colors.reset}`);
    }
  }

  warning(message: string): void {
    if (!this.suppressOutput && !globalSuppressOutput) {
      console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
    }
  }

  info(message: string): void {
    if (!this.suppressOutput && !globalSuppressOutput) {
      console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
    }
  }

  debug(message: string): void {
    if (!this.suppressOutput && !globalSuppressOutput && this.verbose) {
      console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
    }
  }

  log(message: string): void {
    if (!this.suppressOutput && !globalSuppressOutput) {
      console.log(message);
    }
  }

  step(current: number, total: number, message: string): void {
    if (!this.suppressOutput && !globalSuppressOutput) {
      console.log(`${colors.cyan}[${current}/${total}]${colors.reset} ${colors.blue}${message}${colors.reset}`);
    }
  }
}

// Convenience functions for quick usage that respect global suppression
export function printError(message: string): void {
  if (!globalSuppressOutput) {
    console.error(`${colors.red}❌ ${message}${colors.reset}`);
  }
}

export function printSuccess(message: string): void {
  if (!globalSuppressOutput) {
    console.log(`${colors.green}✅ ${message}${colors.reset}`);
  }
}

export function printWarning(message: string): void {
  if (!globalSuppressOutput) {
    console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
  }
}

export function printInfo(message: string): void {
  if (!globalSuppressOutput) {
    console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
  }
}

export function printDebug(message: string, verbose: boolean = false): void {
  if (!globalSuppressOutput && verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}