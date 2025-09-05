/**
 * POSIX Platform Strategy
 * 
 * Runs services as native OS processes on the local machine. This platform is ideal for
 * development environments and simple deployments where containerization isn't needed.
 * 
 * Capabilities:
 * - Spawns services as child processes with environment variables
 * - Manages process lifecycle (start, stop, restart)
 * - Tracks running processes via PID files in the state directory
 * - Supports port allocation and basic health checks
 * - Provides process-level isolation through OS mechanisms
 * 
 * Requirements Handling:
 * - Compute: Uses OS-level resource limits where available
 * - Network: Binds to specified ports, checks for conflicts
 * - Storage: Uses local filesystem paths
 * - Dependencies: Verifies dependent processes are running via PID checks
 */


import { BasePlatformStrategy, LogOptions, LogEntry } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import { StateManager } from '../../core/state-manager.js';
import { HandlerRegistry } from '../../core/handlers/registry.js';
import { handlers } from './handlers/index.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class PosixPlatformStrategy extends BasePlatformStrategy {
  constructor() {
    super();
    this.registerHandlers();
  }
  
  private registerHandlers(): void {
    const registry = HandlerRegistry.getInstance();
    registry.registerHandlers('posix', handlers);
  }
  
  getPlatformName(): string {
    return 'posix';
  }
  
  /**
   * Determine service type for handler selection
   */
  determineServiceType(service: Service): string {
    const requirements = service.getRequirements();
    const serviceName = service.name.toLowerCase();
    
    // Check for MCP services
    if (service.name === 'mcp' || 
        requirements.annotations?.['service/type'] === 'mcp') {
      return 'mcp';
    }
    
    // Check for database services
    if (requirements.annotations?.['service/type'] === 'database' ||
        serviceName.includes('postgres') || 
        serviceName.includes('mysql') || 
        serviceName.includes('mongodb') ||
        serviceName.includes('redis')) {
      return 'database';
    }
    
    // Check for web services
    if (requirements.network?.healthCheckPath ||
        requirements.annotations?.['service/type'] === 'web') {
      return 'web';
    }
    
    // Check for filesystem services
    if (requirements.annotations?.['service/type'] === 'filesystem' ||
        serviceName.includes('nfs') ||
        serviceName.includes('samba') ||
        serviceName.includes('webdav')) {
      return 'filesystem';
    }
    
    // Default to worker for everything else
    return 'worker';
  }
  
  /**
   * Build platform-specific context extensions for handlers
   */
  async buildHandlerContextExtensions(service: Service, _requiresDiscovery: boolean): Promise<Record<string, any>> {
    // Load saved state for posix handlers
    const savedState = await StateManager.load(
      service.projectRoot,
      service.environment,
      service.name
    );
    
    return {
      savedState
    };
  }
  
  /**
   * Collect logs for a POSIX service
   * Routes to appropriate log collection method based on service type
   */
  async collectLogs(service: Service, options?: LogOptions): Promise<LogEntry[] | undefined> {
    const serviceType = this.determineServiceType(service);
    const state = await StateManager.load(
      service.projectRoot,
      service.environment,
      service.name
    );
    
    // Route to appropriate implementation
    switch (serviceType) {
      case 'web':
      case 'worker':
        return this.collectProcessLogs(service, state, options);
      
      case 'database':
        return this.collectDatabaseLogs(service, state, options);
        
      case 'filesystem':
        return this.collectFilesystemLogs(service, state, options);
        
      case 'mcp':
        return this.collectMcpLogs(service, state, options);
        
      default:
        return undefined;
    }
  }
  
  /**
   * Collect logs from a running process
   */
  private async collectProcessLogs(
    service: Service,
    state: import('../../core/state-manager.js').ServiceState | null,
    options?: LogOptions
  ): Promise<LogEntry[] | undefined> {
    // Type-safe access to POSIX resources
    const pid = state?.resources?.platform === 'posix' 
      ? (state.resources.data as any).pid 
      : undefined;
      
    if (!pid || !StateManager.isProcessRunning(pid)) {
      return undefined;
    }
    
    const { tail = 10 } = options || {};
    const logs: LogEntry[] = [];
    
    try {
      // Try platform-specific log collection
      if (process.platform === 'darwin') {
        // macOS: Try to get process logs from system log
        try {
          const output = execSync(
            `log show --process ${pid} --last ${tail}m --style json`,
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
          );
          
          const lines = output.split('\n').filter(line => line.trim());
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              logs.push({
                timestamp: new Date(entry.timestamp),
                message: entry.eventMessage || entry.messageText || '',
                level: entry.messageType?.toLowerCase(),
                source: `pid:${pid}`
              });
            } catch {
              // Skip malformed JSON lines
            }
          }
        } catch {
          // System log not available, fall through to alternatives
        }
      } else {
        // Linux: Try journalctl
        try {
          const output = execSync(
            `journalctl _PID=${pid} -n ${tail} --no-pager --output=json`,
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
          );
          
          const lines = output.split('\n').filter(line => line.trim());
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              logs.push({
                timestamp: new Date(parseInt(entry.__REALTIME_TIMESTAMP) / 1000),
                message: entry.MESSAGE || '',
                level: entry.PRIORITY ? this.mapSyslogPriority(entry.PRIORITY) : undefined,
                source: `pid:${pid}`
              });
            } catch {
              // Skip malformed JSON lines
            }
          }
        } catch {
          // journalctl not available
        }
      }
      
      // Fallback: Check for log files in common locations
      if (logs.length === 0) {
        const logPaths = [
          path.join('/var/log', service.name, '*.log'),
          path.join(service.projectRoot, 'logs', '*.log'),
          path.join(service.projectRoot, '.logs', '*.log')
        ];
        
        for (const pattern of logPaths) {
          const dir = path.dirname(pattern);
          const filePattern = path.basename(pattern);
          
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir).filter(f => 
              f.match(filePattern.replace('*', '.*'))
            );
            
            for (const file of files) {
              const fullPath = path.join(dir, file);
              const content = this.tailFile(fullPath, tail);
              if (content) {
                // Parse log lines (assume one log entry per line)
                const lines = content.split('\n');
                for (const line of lines) {
                  if (line.trim()) {
                    logs.push({
                      timestamp: new Date(), // No timestamp in raw logs
                      message: line,
                      source: file
                    });
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      // Log collection failed, return undefined
      console.debug('Failed to collect logs:', error);
    }
    
    return logs.length > 0 ? logs : undefined;
  }
  
  /**
   * Collect logs from a database service
   */
  private async collectDatabaseLogs(
    service: Service,
    _state: import('../../core/state-manager.js').ServiceState | null,
    options?: LogOptions
  ): Promise<LogEntry[] | undefined> {
    const { tail = 10 } = options || {};
    const logs: LogEntry[] = [];
    
    // Common database log locations
    const logPaths = [
      '/var/log/postgresql/*.log',
      '/var/log/mysql/*.log',
      '/var/log/mongodb/*.log',
      path.join(service.projectRoot, 'data', 'logs', '*.log')
    ];
    
    for (const pattern of logPaths) {
      const dir = path.dirname(pattern);
      const filePattern = path.basename(pattern);
      
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => 
          f.match(filePattern.replace('*', '.*'))
        );
        
        for (const file of files.slice(-1)) { // Get most recent file
          const fullPath = path.join(dir, file);
          const content = this.tailFile(fullPath, tail);
          if (content) {
            const lines = content.split('\n');
            for (const line of lines) {
              if (line.trim()) {
                // Try to parse database log format
                const dbLog = this.parseDatabaseLogLine(line);
                logs.push(dbLog);
              }
            }
          }
        }
      }
    }
    
    return logs.length > 0 ? logs : undefined;
  }
  
  /**
   * Collect logs from a filesystem service
   */
  private async collectFilesystemLogs(
    service: Service,
    state: import('../../core/state-manager.js').ServiceState | null,
    options?: LogOptions
  ): Promise<LogEntry[] | undefined> {
    // Similar to process logs but check filesystem-specific locations
    return this.collectProcessLogs(service, state, options);
  }
  
  /**
   * Collect logs from an MCP service
   */
  private async collectMcpLogs(
    service: Service,
    state: import('../../core/state-manager.js').ServiceState | null,
    options?: LogOptions
  ): Promise<LogEntry[] | undefined> {
    // MCP services are processes, so use process log collection
    return this.collectProcessLogs(service, state, options);
  }
  
  /**
   * Helper to tail a file
   */
  private tailFile(filePath: string, lines: number): string | null {
    try {
      if (process.platform === 'win32') {
        // Windows: Use PowerShell
        return execSync(
          `powershell -Command "Get-Content '${filePath}' -Tail ${lines}"`,
          { encoding: 'utf-8' }
        );
      } else {
        // Unix-like: Use tail command
        return execSync(
          `tail -n ${lines} "${filePath}"`,
          { encoding: 'utf-8' }
        );
      }
    } catch {
      return null;
    }
  }
  
  /**
   * Map syslog priority to log level
   */
  private mapSyslogPriority(priority: string | number): string {
    const pri = typeof priority === 'string' ? parseInt(priority) : priority;
    switch (pri) {
      case 0:
      case 1:
      case 2:
      case 3:
        return 'error';
      case 4:
        return 'warn';
      case 5:
      case 6:
        return 'info';
      case 7:
        return 'debug';
      default:
        return 'info';
    }
  }
  
  /**
   * Parse a database log line
   */
  private parseDatabaseLogLine(line: string): LogEntry {
    // Try to parse common database log formats
    // PostgreSQL: 2024-01-01 12:00:00 UTC [1234]: [1-1] LOG:  message
    // MySQL: 2024-01-01T12:00:00.000000Z 0 [Note] message
    
    let timestamp = new Date();
    let level = 'info';
    let message = line;
    
    // PostgreSQL format
    const pgMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*?\s+(LOG|ERROR|WARNING|INFO|DEBUG):\s+(.*)$/);
    if (pgMatch) {
      timestamp = new Date(pgMatch[1]);
      level = pgMatch[2].toLowerCase();
      message = pgMatch[3];
    }
    
    // MySQL format
    const mysqlMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}).*?\[(\w+)\]\s+(.*)$/);
    if (mysqlMatch) {
      timestamp = new Date(mysqlMatch[1]);
      level = mysqlMatch[2].toLowerCase();
      message = mysqlMatch[3];
    }
    
    return {
      timestamp,
      message,
      level,
      source: 'database'
    };
  }
}