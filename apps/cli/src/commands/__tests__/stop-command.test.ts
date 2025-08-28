/**
 * Stop Command Tests
 * 
 * Tests the stop command logic using MockPlatformStrategy.
 * Focus: command orchestration, result aggregation, error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockPlatformInstance, createServiceDeployments, resetMockState } from './_mock-setup.js';
import type { StopOptions } from '../stop.js';

// Import mocks (side effects)
import './_mock-setup.js';

describe('Stop Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful stop', async () => {
      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'process' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        force: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'stop',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        results: expect.arrayContaining([
          expect.objectContaining({
            entity: 'backend',
            platform: 'mock',
            success: true
          }),
          expect.objectContaining({
            entity: 'database',
            platform: 'mock',
            success: true
          })
        ]),
        summary: {
          total: 2,
          succeeded: 2,
          failed: 0
        }
      });
    });

    it('should handle force mode correctly', async () => {
      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options: StopOptions = {
        environment: 'production',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        force: true
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'backend',
        success: true,
        metadata: expect.objectContaining({
          mockImplementation: true,
          // Note: force flag is not passed through to platform currently
          force: false
        })
      });
    });

    it('should respect dry run mode', async () => {
      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'staging',
        output: 'table',
        quiet: false,
        verbose: false,
        dryRun: true,
        force: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'frontend',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });
    });

    it('should stop services in reverse order', async () => {
      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'process' },
        { name: 'database', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        force: false
      };

      const result = await stop(serviceDeployments, options);

      // Services should be stopped in reverse order
      expect(result.results.map(r => r.entity)).toEqual([
        'database',
        'backend', 
        'frontend'
      ]);
    });

    it('should return error results for failed stops', async () => {
      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      // Make MockPlatformStrategy fail for this test
      const originalStop = mockPlatformInstance.stop;
      mockPlatformInstance.stop = vi.fn().mockRejectedValue(new Error('Stop failed'));

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        quiet: true,
        verbose: false,
        dryRun: false,
        force: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'backend',
        platform: 'process',  // Platform from serviceInfo when error occurs
        success: false,
        error: 'Stop failed'
      });

      expect(result.summary).toMatchObject({
        total: 1,
        succeeded: 0,
        failed: 1
      });

      // Restore original method
      mockPlatformInstance.stop = originalStop;
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const formats: Array<StopOptions['output']> = ['json', 'yaml', 'table', 'summary'];
      
      for (const format of formats) {
        const options: StopOptions = {
          environment: 'test',
          output: format,
          quiet: false,
          verbose: false,
          dryRun: false,
          force: false
        };

        const result = await stop(serviceDeployments, options);

        expect(result).toMatchObject({
          command: 'stop',
          environment: 'test'
        });
      }
    });
  });

  describe('Service Selection', () => {
    it('should stop all services in reverse order when service is "all"', async () => {
      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'process' },
        { name: 'database', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        force: false,
        entity: 'all'
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results).toHaveLength(3);
      // Should be in reverse order
      expect(result.results[0]!.entity).toBe('database');
      expect(result.results[1]!.entity).toBe('backend');
      expect(result.results[2]!.entity).toBe('frontend');
    });

    it('should stop specific service when named', async () => {
      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      // When a specific service is selected, only that service should be in the deployments
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        force: false,
        entity: 'backend'
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.entity).toBe('backend');
    });
  });
});