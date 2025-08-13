/**
 * Unit tests for the test command with structured output support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { test, TestOptions } from '../commands/test.js';
import { TestResult } from '../lib/command-results.js';
import type { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import * as containerRuntime from '../lib/container-runtime.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock dependencies
vi.mock('../lib/container-runtime.js');
vi.mock('child_process');
vi.mock('fs/promises');

// Mock fetch for HTTP health checks
global.fetch = vi.fn();

// Helper function to create service deployments for tests
function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>): ServiceDeploymentInfo[] {
  return services.map(service => ({
    name: service.name,
    deploymentType: service.type as any,
    deployment: { type: service.type },
    config: service.config || {}
  }));
}

describe('test command with structured output', () => {
  const mockListContainers = vi.mocked(containerRuntime.listContainers);
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock process environment
    process.env.USER = 'testuser';
    process.env.VITEST = 'true';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('health tests', () => {
    it('should run health tests for container services and return structured output', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { port: 3000 } },
        { name: 'backend', type: 'container', config: { port: 3001 } }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

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

      const results = await test(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.command).toBe('test');
      expect(results.environment).toBe('local');
      expect(results.services).toHaveLength(2);
      
      // Verify frontend test result
      const frontendResult = results.services.find(s => s.service === 'frontend')! as TestResult;
      expect(frontendResult).toBeDefined();
      expect(frontendResult.testSuite).toBe('health');
      expect(frontendResult.deploymentType).toBe('container');
      expect(frontendResult.success).toBe(true);
      expect(frontendResult.testsPassed).toBeGreaterThan(0);
      expect(frontendResult.testsFailed).toBe(0);
      
      // Verify backend test result
      const backendResult = results.services.find(s => s.service === 'backend')! as TestResult;
      expect(backendResult).toBeDefined();
      expect(backendResult.testSuite).toBe('health');
      expect(backendResult.success).toBe(true);
    });

    it('should handle failed health tests', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { port: 3000 } }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Mock container not running
      mockListContainers.mockResolvedValue([]);

      const results = await test(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      const frontendResult = results.services[0]! as TestResult;
      expect(frontendResult.success).toBe(false);
      expect(frontendResult.testsFailed).toBeGreaterThan(0);
      expect(frontendResult.failures).toHaveLength(1);
      expect(frontendResult.failures[0]).toHaveProperty('test', 'health');
    });
  });

  describe('integration tests', () => {
    it('should run integration tests using test runners', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'integration',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      // Mock spawn for test runner
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.pid = 12345;
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(serviceDeployments, options);

      // Simulate successful test run
      setTimeout(() => {
        mockProcess.emit('exit', 0);
      }, 10);

      const results = await resultPromise;

      expect(results.services).toHaveLength(1);
      const backendResult = results.services[0]! as TestResult;
      expect(backendResult.testSuite).toBe('integration');
      expect(backendResult.success).toBe(true);
      expect(backendResult.testsPassed).toBeGreaterThan(0);
    });
  });

  describe('e2e tests', () => {
    it('should run E2E tests with playwright', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: TestOptions = {
        environment: 'staging',
        suite: 'e2e',
        coverage: false,
        parallel: true,
        timeout: 600,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      // Mock container runtime listing
      mockListContainers.mockResolvedValue(['semiont-frontend-staging']);

      // Mock spawn for playwright
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(serviceDeployments, options);

      // Simulate successful E2E test
      setTimeout(() => {
        mockProcess.emit('exit', 0);
      }, 10);

      const results = await resultPromise;

      expect(results.services).toHaveLength(1);
      const frontendResult = results.services[0]! as TestResult;
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
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001 } }
      ]);

      const options: TestOptions = {
        environment: 'production',
        suite: 'security',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Mock HTTP response with security headers
      (global.fetch as any).mockResolvedValue({
        ok: true,
        headers: new Map([['x-content-type-options', 'nosniff']])
      });

      const results = await test(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      const backendResult = results.services[0]! as TestResult;
      expect(backendResult.testSuite).toBe('security');
      expect(backendResult.success).toBe(true);
    });
  });

  describe('AWS deployment tests', () => {
    it('should handle AWS deployment type tests', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'aws' },
        { name: 'database', type: 'aws' }
      ]);

      const options: TestOptions = {
        environment: 'production',
        suite: 'health',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await test(serviceDeployments, options);

      expect(results.services).toHaveLength(2);
      
      const frontendResult = results.services.find(s => s.service === 'frontend')! as TestResult;
      expect(frontendResult.deploymentType).toBe('aws');
      expect(frontendResult.resourceId).toHaveProperty('aws');
      
      const dbResult = results.services.find(s => s.service === 'database')! as TestResult;
      expect(dbResult.deploymentType).toBe('aws');
    });
  });

  describe('dry run mode', () => {
    it('should simulate tests without executing in dry run mode', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'all',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: true,
        output: 'json'
      };

      const results = await test(serviceDeployments, options);

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

  describe('parallel tests', () => {
    it('should run tests in parallel when requested', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process', config: { port: 3000 } },
        { name: 'backend', type: 'process', config: { port: 3001 } }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'integration',
        coverage: false,
        parallel: true,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Mock spawn for test runners
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(serviceDeployments, options);

      // Simulate successful test runs
      setTimeout(() => {
        mockProcess.emit('exit', 0);
      }, 10);

      const results = await resultPromise;

      expect(results.services).toHaveLength(2);
      results.services.forEach((service) => {
        const testResult = service as TestResult;
        expect(testResult.success).toBe(true);
      });
    });
  });

  describe('external service tests', () => {
    it('should test external services with connectivity checks', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'external', config: { host: 'db.example.com', port: 5432 } }
      ]);

      const options: TestOptions = {
        environment: 'production',
        suite: 'connectivity',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await test(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0]! as TestResult;
      expect(dbResult.deploymentType).toBe('external');
      expect(dbResult.testSuite).toBe('connectivity');
    });
  });

  describe('process deployment tests', () => {
    it('should test process services with port checks', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001 } }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Mock spawn for port check (lsof)
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(serviceDeployments, options);

      // Simulate process running on port
      setTimeout(() => {
        mockProcess.stdout.emit('data', '12345\n');
        mockProcess.emit('exit', 0);
      }, 10);

      // Mock HTTP health check
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200
      });

      const results = await resultPromise;

      expect(results.services).toHaveLength(1);
      const backendResult = results.services[0]! as TestResult;
      expect(backendResult.deploymentType).toBe('process');
      expect(backendResult.success).toBe(true);
    });
  });

  describe('coverage tests', () => {
    it('should enable coverage collection when requested', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'integration',
        coverage: true,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Mock spawn for test runner
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(serviceDeployments, options);

      // Simulate successful test run
      setTimeout(() => {
        mockProcess.emit('exit', 0);
      }, 10);

      const results = await resultPromise;

      expect(results.services).toHaveLength(1);
      const backendResult = results.services[0]! as TestResult;
      expect(backendResult.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle test command failures gracefully', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'integration',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Mock spawn for test runner that fails
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = test(serviceDeployments, options);

      // Simulate failed test run
      setTimeout(() => {
        mockProcess.stderr.emit('data', 'Test error\n');
        mockProcess.emit('exit', 1);
      }, 10);

      const results = await resultPromise;

      expect(results.services).toHaveLength(1);
      const backendResult = results.services[0]! as TestResult;
      expect(backendResult.success).toBe(false);
      expect(backendResult.testsFailed).toBeGreaterThan(0);
    });

    it('should handle timeout errors', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'integration',
        coverage: false,
        parallel: false,
        timeout: 1, // Very short timeout to trigger timeout
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Mock spawn for test runner
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      // Don't emit exit event to simulate timeout
      const results = await test(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      // Test implementation should handle timeout properly
    });
  });

  describe('output formats', () => {
    it('should support JSON output format', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: true,
        output: 'json'
      };

      const results = await test(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.command).toBe('test');
      expect(results.environment).toBe('local');
      expect(results.services).toBeInstanceOf(Array);
    });

    it('should support YAML output format', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options: TestOptions = {
        environment: 'staging',
        suite: 'integration',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: true,
        output: 'yaml'
      };

      const results = await test(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.command).toBe('test');
      expect(results.services).toHaveLength(1);
    });

    it('should support table output format', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'aws' },
        { name: 'backend', type: 'aws' }
      ]);

      const options: TestOptions = {
        environment: 'production',
        suite: 'health',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: true,
        output: 'table'
      };

      const results = await test(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.services).toHaveLength(2);
    });

    it('should support summary output format', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: TestOptions = {
        environment: 'local',
        suite: 'health',
        coverage: false,
        parallel: false,
        timeout: 300,
        verbose: false,
        dryRun: true,
        output: 'summary'
      };

      const results = await test(serviceDeployments, options);

      expect(results.command).toBe('test');
      expect(results.summary.total).toBe(1);
    });
  });
});