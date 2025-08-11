/**
 * Output Formatter - Multi-format output system for command results
 * 
 * This module provides formatting for structured command results in multiple
 * output formats while maintaining backward compatibility with human-readable output.
 */

import { CommandResults, ServiceResult, AnyServiceResult } from './command-results.js';

export type OutputFormat = 'summary' | 'table' | 'json' | 'yaml';

export interface OutputOptions {
  format: OutputFormat;
  quiet: boolean;
  verbose: boolean;
  fields?: string[]; // For selective field output
  colors?: boolean; // Whether to include color codes
}

export interface TableColumn {
  header: string;
  key: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  format?: (value: any) => string;
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

    // Command header
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
      const icon = service.success ? '✅' : '❌';
      const statusColor = service.success ? c.green : c.red;
      
      output += `${icon} ${c.bright}${service.service}${c.reset} (${service.deploymentType}): ${statusColor}${service.status}${c.reset}\n`;
      
      // Show endpoint if available
      const startResult = service as any;
      if (startResult.endpoint && !options.quiet) {
        output += `   ${c.dim}endpoint: ${startResult.endpoint}${c.reset}\n`;
      }
      
      // Show resource ID
      if (options.verbose && service.resourceId) {
        const resourceInfo = this.formatResourceId(service.resourceId);
        if (resourceInfo) {
          output += `   ${c.dim}resource: ${resourceInfo}${c.reset}\n`;
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
   * ASCII table format
   */
  private static formatTable(results: CommandResults, options: OutputOptions): string {
    if (results.services.length === 0) {
      return 'No services to display\n';
    }

    const columns: TableColumn[] = [
      { header: 'Service', key: 'service', width: 12 },
      { header: 'Type', key: 'deploymentType', width: 10 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Duration', key: 'duration', width: 10, format: (ms) => `${ms}ms` },
    ];

    // Add endpoint column if any service has an endpoint
    const hasEndpoints = results.services.some(s => (s as any).endpoint);
    if (hasEndpoints) {
      columns.push({ header: 'Endpoint', key: 'endpoint', width: 25 });
    }

    // Add resource ID column in verbose mode
    if (options.verbose) {
      columns.push({ header: 'Resource', key: 'resourceId', width: 20, format: (r) => this.formatResourceId(r) });
    }

    return this.createTable(results.services, columns, options);
  }

  /**
   * Create ASCII table from data
   */
  private static createTable(data: ServiceResult[], columns: TableColumn[], options: OutputOptions): string {
    const c = options.colors !== false ? this.colors : this.createNoColorMap();
    
    // Calculate column widths
    const widths = columns.map(col => {
      const dataWidth = Math.max(...data.map(row => {
        const value = this.getNestedValue(row, col.key);
        const formatted = col.format ? col.format(value) : String(value || '');
        return formatted.length;
      }));
      return Math.max(col.width || 0, col.header.length, dataWidth);
    });

    let output = '';
    
    // Header
    output += '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐\n';
    output += '│';
    columns.forEach((col, i) => {
      const header = ` ${c.bright}${col.header}${c.reset} `;
      const padding = widths[i] + 2 - col.header.length;
      output += header + ' '.repeat(padding) + '│';
    });
    output += '\n';
    
    // Separator
    output += '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤\n';
    
    // Data rows
    data.forEach((row, rowIndex) => {
      output += '│';
      columns.forEach((col, colIndex) => {
        const value = this.getNestedValue(row, col.key);
        const formatted = col.format ? col.format(value) : String(value || '');
        const padding = widths[colIndex] + 2 - formatted.length;
        
        // Color based on success status
        const colored = row.success ? formatted : `${c.red}${formatted}${c.reset}`;
        output += ` ${colored}` + ' '.repeat(padding) + '│';
      });
      output += '\n';
    });
    
    // Footer
    output += '└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘\n';
    
    return output;
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
    if (!resourceId) return '';
    
    if (resourceId.aws) {
      return resourceId.aws.id || resourceId.aws.arn || resourceId.aws.name || '';
    }
    
    if (resourceId.container) {
      return resourceId.container.id ? resourceId.container.id.substring(0, 12) : resourceId.container.name || '';
    }
    
    if (resourceId.process) {
      return resourceId.process.pid ? `pid:${resourceId.process.pid}` : resourceId.process.path || '';
    }
    
    if (resourceId.external) {
      return resourceId.external.endpoint || resourceId.external.path || '';
    }
    
    return '';
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
export function formatResults(results: CommandResults, format: OutputFormat = 'summary'): string {
  return OutputFormatter.format(results, {
    format,
    quiet: false,
    verbose: false,
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