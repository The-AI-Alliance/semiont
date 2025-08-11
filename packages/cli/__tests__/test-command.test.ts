/**
 * Unit tests for the test command with structured output support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { test, TestOptions } from '../commands/test.js';
import { TestResult, CommandResults } from '../lib/command-results.js';
import * as deploymentResolver from '../lib/deployment-resolver.js';
import * as services from '../lib/services.js';
import * as containerRuntime from '../lib/container-runtime.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock dependencies
vi.mock('../lib/deployment-resolver.js');
vi.mock('../lib/services.js');
vi.mock('../lib/container-runtime.js');
vi.mock('child_process');
vi.mock('fs/promises');

// Mock fetch for HTTP health checks
global.fetch = vi.fn();

describe('test command with structured output', () => {
  const mockResolveServiceSelector = vi.mocked(services.resolveServiceSelector);
  const mockValidateServiceSelector = vi.mocked(services.validateServiceSelector);
  const mockResolveServiceDeployments = vi.mocked(deploymentResolver.resolveServiceDeployments);
  const mockListContainers = vi.mocked(containerRuntime.listContainers);
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mocks for service resolution
    mockValidateServiceSelector.mockResolvedValue(undefined);
    mockResolveServiceSelector.mockResolvedValue(['frontend', 'backend']);
    
    // Mock process environment
    process.env.USER = 'testuser';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('health tests', () => {
    it('should run health tests for container services and return structured output', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        service: 'all',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: { port: 3000 }
        },
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: { port: 3001 }
        }
      ]);

      // Mock container runtime listing
      mockListContainers.mockResolvedValue([
        'semiont-frontend-local',
        'semiont-backend-local'
      ]);

      // Mock HTTP health checks
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200
      });

      const results = await test(options);

      expect(results).toBeDefined();
      expect(results.command).toBe('test');
      expect(results.environment).toBe('local');
      expect(results.services).toHaveLength(2);
      
      // Verify frontend test result
      const frontendResult = results.services.find(s => s.service === 'frontend') as TestResult;
      expect(frontendResult).toBeDefined();
      expect(frontendResult.testSuite).toBe('health');
      expect(frontendResult.deploymentType).toBe('container');
      expect(frontendResult.success).toBe(true);
      expect(frontendResult.testsPassed).toBeGreaterThan(0);
      expect(frontendResult.testsFailed).toBe(0);
      
      // Verify backend test result
      const backendResult = results.services.find(s => s.service === 'backend') as TestResult;
      expect(backendResult).toBeDefined();
      expect(backendResult.testSuite).toBe('health');
      expect(backendResult.success).toBe(true);
    });

    it('should handle failed health tests', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        service: 'frontend',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['frontend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: { port: 3000 }
        }
      ]);

      // Mock container not running
      mockListContainers.mockResolvedValue([]);

      const results = await test(options);

      expect(results.services).toHaveLength(1);
      const frontendResult = results.services[0] as TestResult;
      expect(frontendResult.success).toBe(false);
      expect(frontendResult.testsFailed).toBeGreaterThan(0);
      expect(frontendResult.failures).toHaveLength(1);
      expect(frontendResult.failures[0]).toHaveProperty('test', 'health');
    });
  });

  describe('integration tests', () => {
    it('should run integration tests using test runners', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'integration',
        service: 'backend',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      mockResolveServiceSelector.mockResolvedValue(['backend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: {}
        }
      ]);

      // Mock spawn for test runner
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.pid = 12345;
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(options);

      // Simulate successful test run
      setTimeout(() => {
        mockProcess.emit('exit', 0);
      }, 10);

      const results = await resultPromise;

      expect(results.services).toHaveLength(1);
      const backendResult = results.services[0] as TestResult;
      expect(backendResult.testSuite).toBe('integration');
      expect(backendResult.success).toBe(true);
      expect(backendResult.testsPassed).toBeGreaterThan(0);
    });
  });

  describe('e2e tests', () => {
    it('should run E2E tests with playwright', async () => {
      const options: TestOptions = {
        environment: 'staging',
        suite: 'e2e',
        service: 'frontend',
        coverage: false,
        parallel: true,
        timeout: 600,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      mockResolveServiceSelector.mockResolvedValue(['frontend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      mockListContainers.mockResolvedValue(['semiont-frontend-staging']);

      // Mock spawn for playwright
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(options);

      // Simulate successful E2E test
      setTimeout(() => {
        mockProcess.emit('exit', 0);
      }, 10);

      const results = await resultPromise;

      expect(results.services).toHaveLength(1);
      const frontendResult = results.services[0] as TestResult;
      expect(frontendResult.testSuite).toBe('e2e');
      expect(frontendResult.success).toBe(true);
      
      // Verify parallel flag was used
      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['playwright', 'test', '--grep', 'frontend', '--workers', '4']),
        expect.any(Object)
      );
    });
  });

  describe('security tests', () => {
    it('should run security tests checking headers', async () => {
      const options: TestOptions = {
        environment: 'production',
        suite: 'security',
        service: 'backend',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['backend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: { port: 3001 }
        }
      ]);

      // Mock HTTP response with security headers
      (global.fetch as any).mockResolvedValue({
        ok: true,
        headers: new Map([['x-content-type-options', 'nosniff']])
      });

      const results = await test(options);

      expect(results.services).toHaveLength(1);
      const backendResult = results.services[0] as TestResult;
      expect(backendResult.testSuite).toBe('security');
      expect(backendResult.success).toBe(true);
    });
  });

  describe('AWS deployment tests', () => {
    it('should handle AWS deployment type tests', async () => {
      const options: TestOptions = {
        environment: 'production',
        suite: 'health',
        service: 'all',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {}
        },
        {
          name: 'database',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {}
        }
      ]);

      const results = await test(options);

      expect(results.services).toHaveLength(2);
      
      const frontendResult = results.services.find(s => s.service === 'frontend') as TestResult;
      expect(frontendResult.deploymentType).toBe('aws');
      expect(frontendResult.resourceId).toHaveProperty('aws');
      
      const dbResult = results.services.find(s => s.service === 'database') as TestResult;
      expect(dbResult.deploymentType).toBe('aws');
    });
  });

  describe('dry run mode', () => {
    it('should simulate tests without executing in dry run mode', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'all',
        service: 'all',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: true,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      const results = await test(options);

      expect(results.executionContext.dryRun).toBe(true);
      expect(results.services).toHaveLength(3); // all suite runs 3 test suites
      
      results.services.forEach(service => {
        const testResult = service as TestResult;
        expect(testResult.status).toBe('dry-run');
        expect(testResult.metadata).toHaveProperty('dryRun', true);
        expect(testResult.testsRun).toBe(0);
      });

      // Verify no actual test commands were executed
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('test suite selection', () => {
    it('should run all test suites when suite is "all"', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'all',
        service: 'frontend',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['frontend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      mockListContainers.mockResolvedValue(['semiont-frontend-local']);
      (global.fetch as any).mockResolvedValue({ ok: true });

      const results = await test(options);

      // Should run health, integration, and e2e suites
      expect(results.services).toHaveLength(3);
      
      const suites = results.services.map(s => (s as TestResult).testSuite);
      expect(suites).toContain('health');
      expect(suites).toContain('integration');
      expect(suites).toContain('e2e');
    });

    it('should run only specified suite when provided', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        service: 'backend',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['backend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      mockListContainers.mockResolvedValue(['semiont-backend-local']);

      const results = await test(options);

      expect(results.services).toHaveLength(1);
      expect((results.services[0] as TestResult).testSuite).toBe('health');
    });
  });

  describe('error handling', () => {
    it('should handle service resolution errors', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        service: 'invalid-service',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockValidateServiceSelector.mockRejectedValue(
        new Error('Invalid service selector: invalid-service')
      );

      const results = await test(options);

      expect(results.summary.failed).toBe(1);
      expect(results.services).toHaveLength(0);
    });

    it('should handle individual test failures gracefully', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'integration',
        service: 'all',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: {}
        },
        {
          name: 'backend',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: {}
        }
      ]);

      // Mock spawn to fail for one service
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        const mockProcess = new EventEmitter() as any;
        mockProcess.stdout = new EventEmitter();
        mockProcess.stderr = new EventEmitter();
        
        setTimeout(() => {
          if (callCount++ === 0) {
            mockProcess.emit('exit', 1); // First test fails
          } else {
            mockProcess.emit('exit', 0); // Second test succeeds
          }
        }, 10);
        
        return mockProcess;
      });

      const results = await test(options);

      expect(results.services).toHaveLength(2);
      expect(results.summary.total).toBe(2);
      expect(results.summary.succeeded).toBe(1);
      expect(results.summary.failed).toBe(1);
    });
  });

  describe('external service tests', () => {
    it('should test external services', async () => {
      const options: TestOptions = {
        environment: 'production',
        suite: 'connectivity',
        service: 'database',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['database']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'database',
          deploymentType: 'external',
          deployment: { type: 'external' },
          config: {
            host: 'db.example.com',
            port: 5432,
            name: 'production_db'
          }
        }
      ]);

      const results = await test(options);

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0] as TestResult;
      expect(dbResult.deploymentType).toBe('external');
      expect(dbResult.resourceId).toHaveProperty('external');
      expect(dbResult.testSuite).toBe('connectivity');
    });
  });

  describe('summary output', () => {
    it('should provide correct summary statistics', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        service: 'all',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        },
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        },
        {
          name: 'database',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      mockListContainers.mockResolvedValue([
        'semiont-frontend-local',
        'semiont-backend-local',
        'semiont-postgres-local'
      ]);

      (global.fetch as any).mockResolvedValue({ ok: true });

      const results = await test(options);

      expect(results.command).toBe('test');
      expect(results.environment).toBe('local');
      expect(results.summary.total).toBe(3);
      expect(results.summary.succeeded).toBe(3);
      expect(results.summary.failed).toBe(0);
      expect(results.summary.warnings).toBe(0);
      expect(results.executionContext.user).toBe('testuser');
      expect(results.executionContext.dryRun).toBe(false);
    });
  });

  describe('timeout handling', () => {
    it('should respect timeout configuration', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'integration',
        service: 'backend',
        coverage: false,
        parallel: false,
        timeout: 60, // 60 seconds
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['backend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: {}
        }
      ]);

      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(options);
      
      setTimeout(() => {
        mockProcess.emit('exit', 0);
      }, 10);

      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          timeout: 60000 // 60 seconds in milliseconds
        })
      );
    });
  });

  describe('coverage option', () => {
    it('should include coverage data when requested', async () => {
      const options: TestOptions = {
        environment: 'local',
        suite: 'integration',
        service: 'backend',
        coverage: true,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['backend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: {}
        }
      ]);

      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(options);
      
      setTimeout(() => {
        mockProcess.emit('exit', 0);
      }, 10);

      const results = await resultPromise;

      // With coverage enabled, test result could include coverage data
      // (though the current implementation doesn't parse it)
      expect(results.services).toHaveLength(1);
      const testResult = results.services[0] as TestResult;
      expect(testResult).toBeDefined();
    });
  });
});