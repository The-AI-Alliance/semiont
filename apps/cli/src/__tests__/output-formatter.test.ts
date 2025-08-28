/**
 * Output Formatter Tests
 * 
 * Tests the multi-format output system for structured command results
 * including JSON, YAML, table, and summary formats.
 */

import { describe, it, expect } from 'vitest';
import { 
  OutputFormatter, 
  formatResults, 
  formatResultsQuiet, 
  formatResultsVerbose 
} from '../commands/output-formatter.js';
import { 
  createBaseResult, 
  createErrorResult,
  type CommandResults,
  type StartResult 
} from '../commands/command-results.js';

describe('Output Formatter', () => {
  const startTime = Date.now();
  
  // Create test data
  const createTestResults = (): CommandResults => ({
    command: 'start',
    environment: 'test',
    timestamp: new Date('2024-01-15T10:30:00Z'),
    duration: 1500,
    services: [
      {
        ...createBaseResult('start', 'frontend', 'container', 'test', startTime),
        startTime: new Date('2024-01-15T10:30:01Z'),
        endpoint: 'http://localhost:3000',  // Add endpoint at service level for StartResult
        resourceId: {
          container: {
            id: 'abc123456789',
            name: 'semiont-frontend-test'
          }
        },
        status: 'running',
        metadata: {
          startTime: new Date('2024-01-15T10:30:01Z'),
          endpoint: 'http://localhost:3000',
          containerName: 'semiont-frontend-test',
          image: 'semiont-frontend:latest',
          port: 3000
        }
      } as StartResult,
      {
        ...createErrorResult(
          createBaseResult('start', 'backend', 'process', 'test', startTime),
          'Port 3001 already in use'
        ),
        resourceId: {
          process: {
            pid: 0,
            port: 3001,
            path: '/app/backend'
          }
        },
        status: 'failed',
        metadata: {
          startTime: new Date('2024-01-15T10:30:02Z'),
          command: 'npm run dev',
          workingDirectory: '/app/backend',
          port: 3001
        }
      }
    ],
    summary: {
      total: 2,
      succeeded: 1,
      failed: 1,
      warnings: 0
    },
    executionContext: {
      user: 'testuser',
      workingDirectory: '/app',
      dryRun: false
    }
  });

  describe('JSON Format', () => {
    it('should format results as JSON', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'json',
        quiet: false,
        verbose: false,
        colors: false
      });

      const parsed = JSON.parse(formatted);
      
      expect(parsed).toMatchObject({
        command: 'start',
        environment: 'test',
        timestamp: '2024-01-15T10:30:00.000Z',
        duration: 1500,
        services: expect.arrayContaining([
          expect.objectContaining({
            service: 'frontend',
            success: true,
            status: 'running',
            metadata: expect.objectContaining({
              endpoint: 'http://localhost:3000'
            })
          }),
          expect.objectContaining({
            service: 'backend',
            success: false,
            status: 'failed',
            error: 'Port 3001 already in use'
          })
        ]),
        summary: {
          total: 2,
          succeeded: 1,
          failed: 1,
          warnings: 0
        }
      });
    });

    it('should format JSON with proper indentation in verbose mode', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'json',
        quiet: false,
        verbose: true,
        colors: false
      });

      // Verbose mode should have indented JSON
      expect(formatted).toContain('  "command": "start"');
      expect(formatted).toContain('    "service": "frontend"');
    });

    it('should format compact JSON in non-verbose mode', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'json',
        quiet: false,
        verbose: false,
        colors: false
      });

      // Non-verbose mode should be compact
      expect(formatted).toContain('{"command":"start"');
      expect(formatted).not.toContain('  "command"');
    });
  });

  describe('YAML Format', () => {
    it('should format results as YAML', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'yaml',
        quiet: false,
        verbose: false,
        colors: false
      });

      expect(formatted).toContain('command: "start"');
      expect(formatted).toContain('environment: "test"');
      expect(formatted).toContain('services:');
      expect(formatted).toContain('  - command: "start"');
      expect(formatted).toContain('    service: "frontend"');
      expect(formatted).toContain('    success: true');
      expect(formatted).toContain('summary:');
      expect(formatted).toContain('  total: 2');
      expect(formatted).toContain('  succeeded: 1');
    });

    it('should handle nested objects in YAML', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'yaml',
        quiet: false,
        verbose: false,
        colors: false
      });

      expect(formatted).toContain('resourceId:');
      expect(formatted).toContain('  container:');
      expect(formatted).toContain('    id: "abc123456789"');
      expect(formatted).toContain('metadata:');
      expect(formatted).toContain('  containerName: "semiont-frontend-test"');
    });
  });

  describe('Table Format', () => {
    it('should format results as table', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'table',
        quiet: false,
        verbose: false,
        colors: false
      });

      expect(formatted).toContain('Service');
      expect(formatted).toContain('Type');
      expect(formatted).toContain('Status');
      // Note: Duration column was removed in refactoring
      // expect(formatted).toContain('Duration');
      expect(formatted).toContain('frontend');
      expect(formatted).toContain('container');
      expect(formatted).toContain('[OK]');
      expect(formatted).toContain('running');
      expect(formatted).toContain('backend');
      expect(formatted).toContain('process');
      expect(formatted).toContain('[FAIL]');
      expect(formatted).toContain('failed');
    });

    it('should include endpoints in table when available', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'table',
        quiet: false,
        verbose: false,
        colors: false
      });

      expect(formatted).toContain('Endpoint');
      expect(formatted).toContain('http://localhost:3000');
    });

    it('should include resource info in verbose table mode', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'table',
        quiet: false,
        verbose: true,
        colors: false
      });

      expect(formatted).toContain('Resource');
      expect(formatted).toContain('abc123456789'); // Container ID (truncated)
    });

    it('should handle empty services list', () => {
      const emptyResults: CommandResults = {
        ...createTestResults(),
        services: [],
        summary: { total: 0, succeeded: 0, failed: 0, warnings: 0 }
      };

      const formatted = OutputFormatter.format(emptyResults, {
        format: 'table',
        quiet: false,
        verbose: false,
        colors: false
      });

      expect(formatted).toBe('No services to display\n');
    });
  });

  describe('Summary Format', () => {
    it('should format results as human-readable summary', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'summary',
        quiet: false,
        verbose: false,
        colors: false
      });

      expect(formatted).toContain('📊 start completed in 1500ms');
      expect(formatted).toContain('[OK] frontend (container): running');
      expect(formatted).toContain('[FAIL] backend (process): failed');
      expect(formatted).toContain('endpoint: http://localhost:3000');
      expect(formatted).toContain('error: Port 3001 already in use');
      expect(formatted).toContain('Summary: 1 succeeded, 1 failed, 2 total');
    });

    it('should include verbose metadata in summary', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'summary',
        quiet: false,
        verbose: true,
        colors: false
      });

      expect(formatted).toContain('Environment: test');
      expect(formatted).toContain('Timestamp: 2024-01-15T10:30:00.000Z');
      expect(formatted).toContain('User: testuser');
      expect(formatted).toContain('resource: semiont-frontend-test:abc123456789');
      expect(formatted).toContain('containerName: semiont-frontend-test');
      expect(formatted).toContain('image: semiont-frontend:latest');
    });

    it('should support quiet mode', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'summary',
        quiet: true,
        verbose: false,
        colors: false
      });

      expect(formatted).not.toContain('📊 start completed');
      expect(formatted).not.toContain('endpoint:');
      expect(formatted).not.toContain('Summary:');
      expect(formatted).toContain('[OK] frontend (container): running');
      expect(formatted).toContain('[FAIL] backend (process): failed');
    });

    it('should handle color codes correctly', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'summary',
        quiet: false,
        verbose: false,
        colors: true
      });

      // Should contain ANSI color codes
      expect(formatted).toMatch(/\x1b\[/);
      expect(formatted).toContain('\x1b[36m'); // cyan
      expect(formatted).toContain('\x1b[32m'); // green
      expect(formatted).toContain('\x1b[31m'); // red
      expect(formatted).toContain('\x1b[0m');  // reset
    });

    it('should strip colors when colors=false', () => {
      const results = createTestResults();
      const formatted = OutputFormatter.format(results, {
        format: 'summary',
        quiet: false,
        verbose: false,
        colors: false
      });

      // Should not contain ANSI color codes
      expect(formatted).not.toMatch(/\x1b\[/);
    });

    it('should show dry run indicator', () => {
      const dryRunResults: CommandResults = {
        ...createTestResults(),
        executionContext: {
          ...createTestResults().executionContext,
          dryRun: true
        }
      };

      const formatted = OutputFormatter.format(dryRunResults, {
        format: 'summary',
        quiet: false,
        verbose: true,
        colors: false
      });

      expect(formatted).toContain('⚠️  DRY RUN MODE');
    });
  });

  describe('Resource ID Formatting', () => {
    it('should format AWS resource IDs', () => {
      const awsResults: CommandResults = {
        ...createTestResults(),
        services: [{
          ...createBaseResult('provision', 'database', 'aws', 'production', startTime),
          resourceId: {
            aws: {
              arn: 'arn:aws:rds:us-east-1:123456789012:db:prod-database',
              id: 'prod-database',
              name: 'production-database'
            }
          },
          status: 'provisioned',
          metadata: {}
        }]
      };

      const formatted = OutputFormatter.format(awsResults, {
        format: 'summary',
        quiet: false,
        verbose: true,
        colors: false
      });

      expect(formatted).toContain('resource: prod-database');
    });

    it('should format process resource IDs', () => {
      const processResults: CommandResults = {
        ...createTestResults(),
        services: [{
          ...createBaseResult('start', 'backend', 'process', 'local', startTime),
          resourceId: {
            process: {
              pid: 12345,
              port: 3001,
              path: '/app/backend'
            }
          },
          status: 'running',
          metadata: {}
        }]
      };

      const formatted = OutputFormatter.format(processResults, {
        format: 'summary',
        quiet: false,
        verbose: true,
        colors: false
      });

      expect(formatted).toContain('resource: PID:12345');
    });

    it('should format external resource IDs', () => {
      const externalResults: CommandResults = {
        ...createTestResults(),
        services: [{
          ...createBaseResult('check', 'database', 'external', 'remote', startTime),
          resourceId: {
            external: {
              endpoint: 'db.example.com:5432'
            }
          },
          status: 'external',
          metadata: {}
        }]
      };

      const formatted = OutputFormatter.format(externalResults, {
        format: 'summary',
        quiet: false,
        verbose: true,
        colors: false
      });

      expect(formatted).toContain('resource: db.example.com:5432');
    });
  });

  describe('Utility Functions', () => {
    it('should provide quick formatting function', () => {
      const results = createTestResults();
      const formatted = formatResults(results, 'json');
      
      const parsed = JSON.parse(formatted);
      expect(parsed.command).toBe('start');
      expect(parsed.environment).toBe('test');
    });

    it('should provide quiet formatting function', () => {
      const results = createTestResults();
      const formatted = formatResultsQuiet(results, 'summary');
      
      expect(formatted).not.toContain('📊 start completed');
      expect(formatted).toContain('[OK] frontend');
    });

    it('should provide verbose formatting function', () => {
      const results = createTestResults();
      const formatted = formatResultsVerbose(results, 'summary');
      
      expect(formatted).toContain('Environment: test');
      expect(formatted).toContain('User: testuser');
      expect(formatted).toContain('containerName:');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null/undefined metadata values', () => {
      const resultsWithNulls: CommandResults = {
        ...createTestResults(),
        services: [{
          ...createBaseResult('test', 'service', 'container', 'test', startTime),
          resourceId: { container: { id: 'test', name: 'test' } },
          status: 'running',
          metadata: {
            validValue: 'test',
            nullValue: null,
            undefinedValue: undefined,
            emptyString: ''
          }
        }]
      };

      const formatted = OutputFormatter.format(resultsWithNulls, {
        format: 'summary',
        quiet: false,
        verbose: true,
        colors: false
      });

      expect(formatted).toContain('validValue: test');
      expect(formatted).not.toContain('nullValue:');
      expect(formatted).not.toContain('undefinedValue:');
      // Empty string should be shown
      expect(formatted).toContain('emptyString:');
    });

    it('should handle Date objects in metadata', () => {
      const resultsWithDates: CommandResults = {
        ...createTestResults(),
        services: [{
          ...createBaseResult('test', 'service', 'container', 'test', startTime),
          resourceId: { container: { id: 'test', name: 'test' } },
          status: 'running',
          metadata: {
            createdAt: new Date('2024-01-15T10:30:00Z'),
            lastUpdate: new Date('2024-01-15T11:00:00Z')
          }
        }]
      };

      const formatted = OutputFormatter.format(resultsWithDates, {
        format: 'summary',
        quiet: false,
        verbose: true,
        colors: false
      });

      expect(formatted).toContain('createdAt: 2024-01-15T10:30:00.000Z');
      expect(formatted).toContain('lastUpdate: 2024-01-15T11:00:00.000Z');
    });

    it('should handle complex nested objects in metadata', () => {
      const resultsWithComplexMetadata: CommandResults = {
        ...createTestResults(),
        services: [{
          ...createBaseResult('test', 'service', 'container', 'test', startTime),
          resourceId: { container: { id: 'test', name: 'test' } },
          status: 'running',
          metadata: {
            config: {
              env: { NODE_ENV: 'test', PORT: '3000' },
              features: ['feature1', 'feature2']
            }
          }
        }]
      };

      const formatted = OutputFormatter.format(resultsWithComplexMetadata, {
        format: 'summary',
        quiet: false,
        verbose: true,
        colors: false
      });

      expect(formatted).toContain('config: {"env":{"NODE_ENV":"test","PORT":"3000"},"features":["feature1","feature2"]}');
    });
  });
});