/**
 * Service CLI Behavior Capabilities
 * 
 * Defines behavioral flags that services can use to modify how the CLI
 * handles their execution, without hardcoding service-specific checks.
 */

/**
 * CLI behavior capabilities that services can declare through annotations
 */
export interface CLIBehaviors {
  /**
   * Suppress all CLI output to keep stdio clean for protocols
   * Used by services that communicate via stdin/stdout (e.g., JSON-RPC)
   */
  suppressCliOutput?: boolean;
  
  /**
   * Keep the CLI process alive after command execution
   * Used by services that need to maintain long-running connections
   */
  keepProcessAlive?: boolean;
  
  /**
   * Automatically enable quiet mode to suppress preambles and banners
   * Used by services that need clean output streams
   */
  forceQuietMode?: boolean;
  
  /**
   * Skip normal result formatting and display
   * Used when service output should not be processed by CLI formatters
   */
  skipResultFormatting?: boolean;
  
  /**
   * Run in interactive mode with inherited stdio
   * Used by services that need direct terminal interaction
   */
  interactiveMode?: boolean;
}

/**
 * Well-known annotation keys for CLI behaviors
 */
export const CLI_BEHAVIOR_ANNOTATIONS = {
  SUPPRESS_OUTPUT: 'cli/suppress-output',
  KEEP_ALIVE: 'cli/keep-process-alive',
  FORCE_QUIET: 'cli/force-quiet-mode',
  SKIP_FORMATTING: 'cli/skip-result-formatting',
  INTERACTIVE: 'cli/interactive-mode'
} as const;

/**
 * Extract CLI behaviors from service requirements
 */
export function extractCLIBehaviors(annotations?: Record<string, string>): CLIBehaviors {
  if (!annotations) {
    return {};
  }
  
  return {
    suppressCliOutput: annotations[CLI_BEHAVIOR_ANNOTATIONS.SUPPRESS_OUTPUT] === 'true',
    keepProcessAlive: annotations[CLI_BEHAVIOR_ANNOTATIONS.KEEP_ALIVE] === 'true',
    forceQuietMode: annotations[CLI_BEHAVIOR_ANNOTATIONS.FORCE_QUIET] === 'true',
    skipResultFormatting: annotations[CLI_BEHAVIOR_ANNOTATIONS.SKIP_FORMATTING] === 'true',
    interactiveMode: annotations[CLI_BEHAVIOR_ANNOTATIONS.INTERACTIVE] === 'true'
  };
}

/**
 * Check if a service requires special CLI handling
 */
export function hasSpecialCLIBehaviors(annotations?: Record<string, string>): boolean {
  if (!annotations) {
    return false;
  }
  
  const behaviors = extractCLIBehaviors(annotations);
  return !!(
    behaviors.suppressCliOutput ||
    behaviors.keepProcessAlive ||
    behaviors.forceQuietMode ||
    behaviors.skipResultFormatting ||
    behaviors.interactiveMode
  );
}