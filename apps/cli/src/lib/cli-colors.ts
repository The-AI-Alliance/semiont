/**
 * Shared color utilities for CLI output
 */

export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

export type Colors = typeof colors;

/**
 * Get the formatted preamble string with version
 */
export function getPreamble(version: string): string {
  return `${colors.bright}🌐 Semiont${colors.reset} ${colors.dim}v${version}${colors.reset} | ${colors.cyan}🌎🌍 The AI Alliance${colors.reset} | ${colors.magenta}✨ Make Meaning${colors.reset}`;
}

/**
 * Get the preamble separator line
 */
export function getPreambleSeparator(): string {
  return `${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`;
}