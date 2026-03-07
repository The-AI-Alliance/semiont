/**
 * Configuration Error Class
 * 
 * Custom error class for configuration validation and loading errors.
 * Provides structured error information with helpful suggestions.
 */

export class ConfigurationError extends Error {
  public override readonly cause?: Error;

  constructor(
    message: string,
    public environment?: string,
    public suggestion?: string,
    cause?: Error
  ) {
    super(message);
    this.name = 'ConfigurationError';
    this.cause = cause;
  }
  
  /**
   * Format the error nicely for CLI output
   */
  override toString(): string {
    let output = `❌ ${this.message}`;
    if (this.environment) {
      output += `\n   Environment: ${this.environment}`;
    }
    if (this.suggestion) {
      output += `\n   💡 Suggestion: ${this.suggestion}`;
    }
    return output;
  }
}