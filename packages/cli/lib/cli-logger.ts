/**
 * Shared logging utilities for CLI commands
 */

import { colors } from './cli-colors.js';

export class CliLogger {
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  error(message: string): void {
    console.error(`${colors.red}❌ ${message}${colors.reset}`);
  }

  success(message: string): void {
    console.log(`${colors.green}✅ ${message}${colors.reset}`);
  }

  warning(message: string): void {
    console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
  }

  info(message: string): void {
    console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
  }

  debug(message: string): void {
    if (this.verbose) {
      console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
    }
  }

  log(message: string): void {
    console.log(message);
  }

  step(current: number, total: number, message: string): void {
    console.log(`${colors.cyan}[${current}/${total}]${colors.reset} ${colors.blue}${message}${colors.reset}`);
  }
}

// Convenience functions for quick usage
export function printError(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

export function printSuccess(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

export function printWarning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

export function printInfo(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}