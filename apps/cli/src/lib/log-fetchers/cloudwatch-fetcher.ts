/**
 * CloudWatch Log Fetcher - Fetches logs from AWS CloudWatch for ECS services
 */

import { 
  CloudWatchLogsClient, 
  FilterLogEventsCommand,
  DescribeLogGroupsCommand
} from '@aws-sdk/client-cloudwatch-logs';
import { 
  CloudFormationClient, 
  DescribeStacksCommand 
} from '@aws-sdk/client-cloudformation';
import { LogFetcher, LogEntry, LogFetchOptions } from '../log-aggregator.js';
import { type ServiceDeploymentInfo } from '../deployment-resolver.js';

export class CloudWatchLogFetcher extends LogFetcher {
  private logsClient: CloudWatchLogsClient;
  private cfnClient: CloudFormationClient;
  private logGroupCache: Map<string, string> = new Map();
  
  constructor(private region: string) {
    super();
    this.logsClient = new CloudWatchLogsClient({ region });
    this.cfnClient = new CloudFormationClient({ region });
  }
  
  async fetchLogs(
    service: ServiceDeploymentInfo,
    options: LogFetchOptions
  ): Promise<LogEntry[]> {
    try {
      // Get log group name - try cache first
      let logGroupName = this.logGroupCache.get(service.name);
      
      if (!logGroupName) {
        logGroupName = await this.getLogGroupName(service);
        if (logGroupName) {
          this.logGroupCache.set(service.name, logGroupName);
        }
      }
      
      if (!logGroupName) {
        console.debug(`No log group found for ${service.name}`);
        return [];
      }
      
      // Fetch logs from CloudWatch
      const command = new FilterLogEventsCommand({
        logGroupName,
        startTime: options.since?.getTime(),
        endTime: options.until?.getTime(),
        limit: options.limit || 50,
        filterPattern: options.filter,
      });
      
      const response = await this.logsClient.send(command);
      
      return this.parseCloudWatchLogs(response.events || [], service.name);
    } catch (error: any) {
      // Silently fail if logs aren't available (common for new deployments)
      if (error.name === 'ResourceNotFoundException') {
        console.debug(`Log group not found for ${service.name}`);
        return [];
      }
      console.error(`CloudWatch log fetch error for ${service.name}:`, error.message);
      return [];
    }
  }
  
  private async getLogGroupName(service: ServiceDeploymentInfo): Promise<string | null> {
    // First try to get from CloudFormation outputs
    try {
      const stackResult = await this.cfnClient.send(new DescribeStacksCommand({
        StackName: 'SemiontAppStack'
      }));
      
      const outputs = stackResult.Stacks?.[0]?.Outputs || [];
      const logGroupOutput = outputs.find(o => 
        o.OutputKey === 'LogGroupName' || 
        o.OutputKey === 'SemiontLogGroupName'
      );
      
      if (logGroupOutput?.OutputValue) {
        return logGroupOutput.OutputValue;
      }
    } catch (error) {
      console.debug('Could not get log group from CloudFormation:', error);
    }
    
    // Fall back to searching for log groups by pattern
    try {
      const describeCommand = new DescribeLogGroupsCommand({
        logGroupNamePrefix: '/ecs/semiont',
        limit: 50
      });
      
      const response = await this.logsClient.send(describeCommand);
      const logGroups = response.logGroups || [];
      
      // Look for a log group that contains 'semiont' (case insensitive)
      const semiontGroup = logGroups.find(lg => 
        lg.logGroupName?.toLowerCase().includes('semiont')
      );
      
      if (semiontGroup?.logGroupName) {
        return semiontGroup.logGroupName;
      }
      
      // Try common ECS log group patterns
      const patterns = [
        `/ecs/semiont-${service.name}`,
        `/aws/ecs/semiont`,
        `/ecs/SemiontCluster`,
        'SemiontLogGroup'
      ];
      
      for (const pattern of patterns) {
        const found = logGroups.find(lg => 
          lg.logGroupName?.includes(pattern)
        );
        if (found?.logGroupName) {
          return found.logGroupName;
        }
      }
    } catch (error) {
      console.debug('Could not search log groups:', error);
    }
    
    return null;
  }
  
  private parseCloudWatchLogs(events: any[], serviceName: string): LogEntry[] {
    return events.map(event => {
      const message = event.message || '';
      
      // Try to parse structured JSON logs first
      try {
        if (message.startsWith('{')) {
          const json = JSON.parse(message);
          return {
            timestamp: new Date(event.timestamp || json.timestamp || json.time || Date.now()),
            service: serviceName,
            level: this.parseLogLevel(json.level || json.severity || 'info'),
            message: json.msg || json.message || json.log || message,
            metadata: json
          };
        }
      } catch {
        // Not JSON, continue with plain text parsing
      }
      
      // Parse common log formats
      // Example: 2024-01-15T10:23:45.123Z INFO [main] Starting application
      const structuredMatch = message.match(/^(\S+)\s+(\w+)\s+\[([^\]]+)\]\s+(.+)$/);
      if (structuredMatch) {
        return {
          timestamp: new Date(structuredMatch[1] || event.timestamp),
          service: serviceName,
          level: this.parseLogLevel(structuredMatch[2]),
          message: structuredMatch[4],
        };
      }
      
      // Parse Hono/Express style logs
      // Example: GET /api/health 200 15ms
      const httpMatch = message.match(/^(\w+)\s+(\/\S+)\s+(\d+)\s+(\d+ms)$/);
      if (httpMatch) {
        return {
          timestamp: new Date(event.timestamp),
          service: serviceName,
          level: httpMatch[3].startsWith('2') ? 'info' : 
                 httpMatch[3].startsWith('4') ? 'warn' : 
                 httpMatch[3].startsWith('5') ? 'error' : 'info',
          message: message,
        };
      }
      
      // Default parsing
      return {
        timestamp: new Date(event.timestamp),
        service: serviceName,
        level: this.extractLogLevel(message),
        message: this.cleanMessage(message),
      };
    });
  }
  
  private parseLogLevel(level: string): LogEntry['level'] {
    const normalized = level.toUpperCase();
    if (['ERROR', 'ERR', 'FATAL', 'CRITICAL'].includes(normalized)) return 'error';
    if (['WARN', 'WARNING'].includes(normalized)) return 'warn';
    if (['DEBUG', 'TRACE'].includes(normalized)) return 'debug';
    return 'info';
  }
  
  private cleanMessage(message: string): string {
    // Remove ANSI color codes
    const ansiRegex = /\x1b\[[0-9;]*m/g;
    let cleaned = message.replace(ansiRegex, '');
    
    // Remove common prefixes
    cleaned = cleaned.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+/, '');
    cleaned = cleaned.replace(/^(INFO|ERROR|WARN|DEBUG|TRACE)\s+/, '');
    
    // Trim whitespace
    return cleaned.trim();
  }
}