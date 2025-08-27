/**
 * Output Formatter - Multi-format output system for command results
 * 
 * This module provides formatting for structured command results in multiple
 * output formats while maintaining backward compatibility with human-readable output.
 */

import { CommandResults } from './command-results.js';
import { createStringTable } from './string-utils.js';

export type OutputFormat = 'summary' | 'table' | 'json' | 'yaml';

export interface OutputOptions {
  format: OutputFormat;
  quiet: boolean;
  verbose: boolean;
  fields?: string[]; // For selective field output
  colors?: boolean; // Whether to include color codes
}


export class OutputFormatter {
  private static readonly colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
  };

  /**
   * Main entry point for formatting command results
   */
  static format(results: CommandResults, options: OutputOptions): string {
    switch (options.format) {
      case 'json':
        return this.formatJSON(results, options);
      case 'yaml':
        return this.formatYAML(results, options);
      case 'table':
        return this.formatTable(results, options);
      case 'summary':
      default:
        return this.formatSummary(results, options);
    }
  }

  /**
   * JSON format output
   */
  private static formatJSON(results: CommandResults, options: OutputOptions): string {
    const output = options.fields 
      ? this.selectFields(results, options.fields)
      : results;
      
    // Clean up dates and functions for JSON serialization
    const cleanOutput = this.cleanForSerialization(output);
    
    return JSON.stringify(cleanOutput, null, options.verbose ? 2 : 0);
  }

  /**
   * YAML format output
   */
  private static formatYAML(results: CommandResults, options: OutputOptions): string {
    const output = options.fields 
      ? this.selectFields(results, options.fields)
      : results;
      
    // Simple YAML formatter (could be replaced with a proper YAML library)
    return this.toYAML(output, 0);
  }

  /**
   * Human-readable summary format (default CLI output)
   */
  private static formatSummary(results: CommandResults, options: OutputOptions): string {
    const c = options.colors !== false ? this.colors : this.createNoColorMap();
    let output = '';

    // Command header (no preamble - it's now printed at command start)
    if (!options.quiet) {
      output += `${c.cyan}📊 ${results.command}${c.reset} completed in ${c.bright}${results.duration}ms${c.reset}\n`;
      
      if (options.verbose) {
        output += `${c.dim}Environment: ${results.environment}${c.reset}\n`;
        output += `${c.dim}Timestamp: ${results.timestamp.toISOString()}${c.reset}\n`;
        output += `${c.dim}User: ${results.executionContext.user}${c.reset}\n`;
        if (results.executionContext.dryRun) {
          output += `${c.yellow}⚠️  DRY RUN MODE${c.reset}\n`;
        }
        output += '\n';
      }
    }

    // Service results
    for (const service of results.services) {
      // Determine appropriate status indicator and color
      let statusIndicator = '';
      let statusColor = '';
      
      if (!service.success) {
        statusIndicator = '[FAIL]';
        statusColor = c.red;
      } else if (service.status === 'running' || service.status === 'healthy') {
        statusIndicator = '[OK]';
        statusColor = c.green;
      } else if (service.status === 'stopped') {
        statusIndicator = '[--]';
        statusColor = c.yellow;
      } else if (service.status === 'error') {
        statusIndicator = '[ERR]';
        statusColor = c.red;
      } else if (service.status === 'unknown') {
        statusIndicator = '[??]';
        statusColor = c.dim;
      } else if (service.status === 'degraded') {
        statusIndicator = '[WARN]';
        statusColor = c.yellow;
      } else {
        statusIndicator = '[--]';
        statusColor = c.dim;
      }
      
      output += `${statusColor}${statusIndicator}${c.reset} ${c.bright}${service.service}${c.reset} (${service.deploymentType}): ${statusColor}${service.status}${c.reset}\n`;
      
      // Show endpoint if available (for start results)
      if ('endpoint' in service && service.endpoint && !options.quiet) {
        output += `   ${c.dim}endpoint: ${service.endpoint}${c.reset}\n`;
      }
      
      // Show revision information for update results
      if ('previousVersion' in service && 'newVersion' in service && !options.quiet) {
        if (service.previousVersion && service.newVersion) {
          output += `   ${c.dim}revision: ${service.previousVersion} → ${service.newVersion}${c.reset}\n`;
        } else if (service.newVersion) {
          output += `   ${c.dim}revision: ${service.newVersion}${c.reset}\n`;
        }
      }
      
      // Show resource ID and console URL
      if (options.verbose && service.resourceId) {
        const resourceInfo = this.formatResourceId(service.resourceId);
        if (resourceInfo) {
          output += `   ${c.dim}resource: ${resourceInfo}${c.reset}\n`;
        }
        
        // Show AWS console URL if available
        if (service.resourceId.aws?.consoleUrl) {
          output += `   ${c.cyan}console: ${service.resourceId.aws.consoleUrl}${c.reset}\n`;
        }
      }
      
      // Show metadata in verbose mode
      if (options.verbose && service.metadata && Object.keys(service.metadata).length > 0) {
        for (const [key, value] of Object.entries(service.metadata)) {
          if (value !== undefined && value !== null) {
            output += `   ${c.dim}${key}: ${this.formatValue(value)}${c.reset}\n`;
          }
        }
      }
      
      // Show error details
      if (!service.success && service.error) {
        output += `   ${c.red}error: ${service.error}${c.reset}\n`;
      }
    }

    // Summary statistics
    if (!options.quiet && results.services.length > 1) {
      output += '\n';
      output += `${c.cyan}Summary:${c.reset} `;
      output += `${c.green}${results.summary.succeeded} succeeded${c.reset}, `;
      
      if (results.summary.failed > 0) {
        output += `${c.red}${results.summary.failed} failed${c.reset}, `;
      }
      
      if (results.summary.warnings > 0) {
        output += `${c.yellow}${results.summary.warnings} warnings${c.reset}, `;
      }
      
      output += `${results.summary.total} total\n`;
    }

    return output;
  }

  /**
   * ASCII table format using custom ink table utility
   */
  private static formatTable(results: CommandResults, options: OutputOptions): string {
    if (results.services.length === 0) {
      return 'No services to display\n';
    }

    // Check if terminal supports hyperlinks
    const supportsHyperlinks = process.env.TERM_PROGRAM === 'iTerm.app' || 
                               process.env.TERM === 'xterm-256color' ||
                               process.env.TERM_PROGRAM === 'vscode';
    
    // Determine columns to display
    const columns = ['Service', 'Type', 'Status'];
    
    // Add endpoint column if any service has an endpoint
    const hasEndpoints = results.services.some(s => 'endpoint' in s && s.endpoint);
    if (hasEndpoints) {
      columns.push('Endpoint');
    }

    // Add resource column in verbose mode
    if (options.verbose) {
      columns.push('Resource');
    }

    // Transform service data for table
    const tableData = results.services.map(service => {
      // Determine appropriate status text with color codes
      const c = options.colors !== false ? this.colors : this.createNoColorMap();
      let statusText = '';
      
      if (!service.success) {
        statusText = `${c.red}[FAIL]${c.reset} ${service.status}`;
      } else if (service.status === 'running' || service.status === 'healthy') {
        statusText = `${c.green}[OK]${c.reset} ${service.status}`;
      } else if (service.status === 'stopped') {
        statusText = `${c.yellow}[--]${c.reset} ${service.status}`;
      } else if (service.status === 'error') {
        statusText = `${c.red}[ERR]${c.reset} ${service.status}`;
      } else if (service.status === 'unknown') {
        statusText = `${c.dim}[??]${c.reset} ${service.status}`;
      } else if (service.status === 'degraded') {
        statusText = `${c.yellow}[WARN]${c.reset} ${service.status}`;
      } else {
        statusText = `${c.dim}[--]${c.reset} ${service.status}`;
      }
      
      const row: Record<string, any> = {
        Service: service.service,
        Type: service.deploymentType,
        Status: statusText,
      };

      // Add endpoint if available
      if (hasEndpoints) {
        if ('endpoint' in service && service.endpoint) {
          row.Endpoint = service.endpoint;
        } else {
          row.Endpoint = '-';
        }
      }

      // Add resource ID in verbose mode
      if (options.verbose) {
        const resourceText = this.formatResourceId(service.resourceId);
        
        // If terminal supports hyperlinks and we have a console URL, make the resource clickable
        if (supportsHyperlinks && service.resourceId?.aws?.consoleUrl) {
          const url = service.resourceId.aws.consoleUrl;
          // OSC 8 hyperlink format: \x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\
          row.Resource = `\x1b]8;;${url}\x1b\\${resourceText}\x1b]8;;\x1b\\`;
        } else {
          row.Resource = resourceText;
        }
      }

      return row;
    });

    return createStringTable(tableData, columns, {
      colors: options.colors !== false,
      borders: true,
      padding: 1
    });
  }


  /**
   * Select specific fields from results
   */
  private static selectFields(results: CommandResults, fields: string[]): Partial<CommandResults> {
    const selected: any = {};
    
    for (const field of fields) {
      const value = this.getNestedValue(results, field);
      if (value !== undefined) {
        this.setNestedValue(selected, field, value);
      }
    }
    
    return selected;
  }

  /**
   * Get nested value from object using dot notation
   */
  private static getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Set nested value in object using dot notation
   */
  private static setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    
    const target = keys.reduce((current, key) => {
      if (!(key in current)) {
        current[key] = {};
      }
      return current[key];
    }, obj);
    
    target[lastKey] = value;
  }

  /**
   * Format resource identifier for display
   */
  private static formatResourceId(resourceId: any): string {
    if (!resourceId) return '-';
    
    if (resourceId.aws) {
      // For AWS resources, show ARN or a simplified identifier
      if (resourceId.aws.arn) {
        // For service/cluster/name format, extract just the service name
        if (resourceId.aws.arn.includes('/')) {
          const parts = resourceId.aws.arn.split('/');
          // Return the last part (the actual service name)
          return parts[parts.length - 1] || resourceId.aws.arn;
        }
        
        // For other ARN formats, extract the last meaningful part
        const arnParts = resourceId.aws.arn.split(':');
        const resourcePart = arnParts[arnParts.length - 1] || '';
        
        // If it contains a slash, get the last part
        if (resourcePart.includes('/')) {
          const subParts = resourcePart.split('/');
          return subParts[subParts.length - 1];
        }
        
        return resourcePart || resourceId.aws.name || 'AWS';
      }
      return resourceId.aws.id || resourceId.aws.name || 'AWS';
    }
    
    if (resourceId.container) {
      const name = resourceId.container.name || '';
      const id = resourceId.container.id ? resourceId.container.id.substring(0, 12) : '';
      if (name && id) {
        return `${name}:${id}`;
      }
      return name || id || 'Container';
    }
    
    if (resourceId.process) {
      if (resourceId.process.pid) {
        return `PID:${resourceId.process.pid}`;
      }
      return resourceId.process.path || 'Process';
    }
    
    if (resourceId.external) {
      return resourceId.external.endpoint || resourceId.external.path || 'External';
    }
    
    if (resourceId.mock) {
      return resourceId.mock.id || 'Mock';
    }
    
    return '-';
  }

  /**
   * Format a value for display
   */
  private static formatValue(value: any): string {
    if (value === null || value === undefined) {
      return '';
    }
    
    if (typeof value === 'object') {
      if (value instanceof Date) {
        return value.toISOString();
      }
      return JSON.stringify(value);
    }
    
    return String(value);
  }

  /**
   * Simple YAML formatter
   */
  private static toYAML(obj: any, indent: number = 0): string {
    const spaces = '  '.repeat(indent);
    let result = '';
    
    if (Array.isArray(obj)) {
      for (const item of obj) {
        result += `${spaces}- ${this.toYAML(item, indent + 1).trim()}\n`;
      }
    } else if (obj && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === undefined) {
          result += `${spaces}${key}: null\n`;
        } else if (typeof value === 'object') {
          result += `${spaces}${key}:\n${this.toYAML(value, indent + 1)}`;
        } else {
          const valueStr = typeof value === 'string' ? `"${value}"` : String(value);
          result += `${spaces}${key}: ${valueStr}\n`;
        }
      }
    } else {
      return String(obj);
    }
    
    return result;
  }

  /**
   * Clean object for JSON serialization
   */
  private static cleanForSerialization(obj: any): any {
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.cleanForSerialization(item));
    }
    
    if (obj && typeof obj === 'object') {
      const cleaned: any = {};
      for (const [key, value] of Object.entries(obj)) {
        cleaned[key] = this.cleanForSerialization(value);
      }
      return cleaned;
    }
    
    return obj;
  }

  /**
   * Create a map of empty strings for no-color mode
   */
  private static createNoColorMap(): Record<string, string> {
    const noColor: Record<string, string> = {};
    for (const key of Object.keys(this.colors)) {
      noColor[key] = '';
    }
    return noColor;
  }
}

/**
 * Utility function for quick formatting
 */
export function formatResults(results: CommandResults, format: OutputFormat = 'summary', verbose: boolean = false): string {
  return OutputFormatter.format(results, {
    format,
    quiet: false,
    verbose,
    colors: true
  });
}

/**
 * Utility function for quiet output
 */
export function formatResultsQuiet(results: CommandResults, format: OutputFormat = 'summary'): string {
  return OutputFormatter.format(results, {
    format,
    quiet: true,
    verbose: false,
    colors: false
  });
}

/**
 * Utility function for verbose output
 */
export function formatResultsVerbose(results: CommandResults, format: OutputFormat = 'summary'): string {
  return OutputFormatter.format(results, {
    format,
    quiet: false,
    verbose: true,
    colors: true
  });
}