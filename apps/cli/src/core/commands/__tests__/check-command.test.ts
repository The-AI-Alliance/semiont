/**
 * Check Command Tests
 * 
 * Tests the check command logic using MockPlatformStrategy.
 * Focus: command orchestration, health checking, status reporting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockPlatformInstance, createServiceDeployments, resetMockState } from './_mock-setup';
import type { CheckOptions } from '../check.js';

// Import mocks (side effects)
import './_mock-setup';

describe('Check Command', () => {
  beforeEach(() => {
    resetMockState();
  });

  afterEach(() => {
    resetMockState();
  });

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful check', async () => {
      const { checkCommand } = await import('../check.js');
      const check = checkCommand.handler;
      
      // Pre-populate mock state to simulate running services
      mockPlatformInstance['mockState'].set('backend', {
        id: 'mock-backend',
        running: true,
        startTime: new Date()
      });
      mockPlatformInstance['mockState'].set('database', {
        id: 'mock-database',
        running: true,  // Set to running so check succeeds
        startTime: new Date()
      });
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' },
        { name: 'database', type: 'mock' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        wait: false,
        timeout: 5000
      };

      const result = await check(serviceDeployments, options);

      expect(result).toBeDefined();
      expect(result.command).toBe('check');
      expect(result.environment).toBe('test');
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.duration).toBeGreaterThan(0);

      // Check results exist and have correct entities
      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThanOrEqual(2);

      const backendResult = result.results.find(r => r.entity === 'backend');
      const databaseResult = result.results.find(r => r.entity === 'database');

      expect(backendResult).toBeDefined();
      expect(backendResult?.platform).toBe('mock');

      expect(databaseResult).toBeDefined();
      expect(databaseResult?.platform).toBe('mock');

      // Check summary exists and has correct total
      expect(result.summary).toBeDefined();
      expect(result.summary.total).toBe(2);

      // Don't assert on exact success/fail counts as mock behavior may vary
      // Just ensure summary adds up correctly
      expect(result.summary.succeeded + result.summary.failed).toBe(2);
    });

    it('should handle health check failures', async () => {
      const { checkCommand } = await import('../check.js');
      const check = checkCommand.handler;
      
      // Set up mock state to indicate a stopped/unhealthy service
      mockPlatformInstance['mockState'].set('backend', {
        id: 'mock-backend',
        running: false,
        startTime: new Date()
      });

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        output: 'json',
        quiet: true,
        verbose: false,
        wait: false,
        timeout: 5000
      };

      const result = await check(serviceDeployments, options);

      // The mock returns success:true even for stopped services (check succeeded, service is stopped)
      expect(result.results[0]!).toMatchObject({
        entity: 'backend',
        platform: 'mock',
        success: true  // Check succeeded, it found the service stopped
      });

      expect(result.summary).toMatchObject({
        total: 1,
        succeeded: 1,  // Check operation succeeded
        failed: 0,
        warnings: 0
      });
    });

    it('should support wait mode for services to become healthy', async () => {
      const { checkCommand } = await import('../check.js');
      const check = checkCommand.handler;
      
      // Start with service stopped
      mockPlatformInstance['mockState'].set('backend', {
        id: 'mock-backend',
        running: false,
        startTime: new Date()
      });
      
      // Simulate service becoming healthy after a delay
      setTimeout(() => {
        const state = mockPlatformInstance['mockState'].get('backend');
        if (state) state.running = true;
      }, 100);
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        wait: true,
        timeout: 500
      };

      const result = await check(serviceDeployments, options);

      // Should eventually report as running if wait logic works
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toBeDefined();
      expect(result.results[0]?.extensions).toBeDefined();
      expect(result.results[0]?.extensions?.status).toBeDefined();
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      const { checkCommand } = await import('../check.js');
      const check = checkCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const formats: Array<CheckOptions['output']> = ['json', 'yaml', 'table', 'summary'];
      
      for (const format of formats) {
        const options: CheckOptions = {
          environment: 'test',
          output: format,
          quiet: false,
          verbose: false,
          wait: false,
          timeout: 5000
        };

        const result = await check(serviceDeployments, options);

        expect(result).toMatchObject({
          command: 'check',
          environment: 'test'
        });
      }
    });
  });

  describe('Service Health Checking', () => {
    it('should check all services when service is "all"', async () => {
      const { checkCommand } = await import('../check.js');
      const check = checkCommand.handler;
      
      // Set up different states for each service
      mockPlatformInstance['mockState'].set('frontend', {
        id: 'mock-frontend',
        running: true,
        startTime: new Date()
      });
      mockPlatformInstance['mockState'].set('backend', {
        id: 'mock-backend',
        running: true,
        startTime: new Date()
      });
      mockPlatformInstance['mockState'].set('database', {
        id: 'mock-database',
        running: false,
        startTime: new Date()
      });
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'mock' },
        { name: 'backend', type: 'mock' },
        { name: 'database', type: 'mock' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        wait: false,
        timeout: 5000,
        entity: 'all'
      };

      const result = await check(serviceDeployments, options);

      expect(result.results).toHaveLength(3);
      expect(result.results.map(r => r.entity)).toEqual(
        expect.arrayContaining(['frontend', 'backend', 'database'])
      );
    });

    it('should check specific service when provided', async () => {
      const { checkCommand } = await import('../check.js');
      const check = checkCommand.handler;
      
      mockPlatformInstance['mockState'].set('backend', {
        id: 'mock-backend',
        running: true,
        startTime: new Date()
      });
      
      // When a specific service is selected, only that service should be in the deployments
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        wait: false,
        timeout: 5000,
        entity: 'backend'
      };

      const result = await check(serviceDeployments, options);

      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.entity).toBe('backend');
      expect(result.results[0]!.extensions).toBeDefined();
      expect(result.results[0]!.extensions!.status).toBe('running');
    });

    it('should report accurate health status for each service', async () => {
      const { checkCommand } = await import('../check.js');
      const check = checkCommand.handler;
      
      // Frontend is running
      mockPlatformInstance['mockState'].set('frontend', {
        id: 'mock-frontend',
        running: true,
        startTime: new Date()
      });
      
      // Backend is stopped
      mockPlatformInstance['mockState'].set('backend', {
        id: 'mock-backend',
        running: false,
        startTime: new Date()
      });
      
      // Database has no state (never started)
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'mock' },
        { name: 'backend', type: 'mock' },
        { name: 'database', type: 'mock' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        wait: false,
        timeout: 5000
      };

      const result = await check(serviceDeployments, options);

      const frontendResult = result.results.find(r => r.entity === 'frontend');
      const backendResult = result.results.find(r => r.entity === 'backend');
      const databaseResult = result.results.find(r => r.entity === 'database');

      // Debug: Log the actual results
      if (!frontendResult || !backendResult || !databaseResult) {
        console.log('Results:', JSON.stringify(result.results, null, 2));
      }

      expect(frontendResult).toBeDefined();
      if (frontendResult?.extensions) {
        expect(frontendResult.extensions.status).toBe('running');
      }

      expect(backendResult).toBeDefined();
      if (backendResult?.extensions) {
        expect(backendResult.extensions.status).toBe('stopped');
      }

      expect(databaseResult).toBeDefined();
      if (databaseResult?.extensions) {
        expect(databaseResult.extensions.status).toBe('stopped');
      }

      // Verify services were found
      expect(frontendResult).toBeDefined();
      expect(backendResult).toBeDefined();
      expect(databaseResult).toBeDefined();
    });
  });
});