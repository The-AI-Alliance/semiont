/**
 * Stop Command Tests
 * 
 * Tests the stop command's structured output functionality across
 * different deployment types (aws, container, process, external).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StopOptions } from '../stop.js';
import type { ServicePlatformInfo } from '../../platforms/platform-resolver.js';

// Mock the container runtime to avoid actual Docker calls
vi.mock('../platforms/container-runtime.js', () => ({
  stopContainer: vi.fn().mockResolvedValue(true),
  runContainer: vi.fn().mockResolvedValue(true),
  listContainers: vi.fn().mockResolvedValue([]),
  execInContainer: vi.fn().mockResolvedValue(true),
  detectContainerRuntime: vi.fn().mockResolvedValue('docker')
}));

// Mock child_process to avoid spawning real processes
vi.mock('child_process', () => ({
  execSync: vi.fn((command) => {
    if (command.includes('docker version')) {
      return 'Docker version 20.10.0';
    }
    if (command.includes('podman version')) {
      throw new Error('podman not found');
    }
    return '';
  }),
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn((event, callback) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
    }),
    stdout: { 
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          callback(Buffer.from('12345\n'));
        }
      })
    },
    stderr: { on: vi.fn() }
  }))
}));

describe('Stop Command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Helper function to create service deployments for tests
  function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>): ServicePlatformInfo[] {
    return services.map(service => ({
      name: service.name,
      platform: service.type as any,
      config: service.config || {}
    }));
  }

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful stop', async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);


      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'stop',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        results: expect.arrayContaining([
          expect.objectContaining({
            command: 'stop',
            entity: 'backend',
            platform: 'container',
            success: true,
            stopTime: expect.any(Date),
            status: 'stopped'
          }),
          expect.objectContaining({
            command: 'stop',
            entity: 'database',
            platform: 'container',
            success: true
          })
        ]),
        summary: expect.objectContaining({
          total: 2,
          succeeded: 2,
          failed: 0
        })
      });
    });

    it('should handle dry run mode correctly', async () => {

      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process', config: { port: 3000 } }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'table',
        force: false,
        verbose: true,
        dryRun: true
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });
    });

    it('should handle force stop mode', async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);


      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        force: true,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        command: 'stop',
        entity: 'database',
        forcedTermination: true
      });
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type', async () => {
      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'aws' }
      ]);

      const options: StopOptions = {
        environment: 'production',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        platform: 'aws',
        entity: 'backend',
        status: 'not-implemented'
      });
    });

    it('should handle container deployment type', async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);


      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container', config: { image: 'postgres:14' } }
      ]);

      const options: StopOptions = {
        environment: 'staging',
        output: 'summary',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        platform: 'container',
        entity: 'database',
        command: 'stop'
      });
    });

    it('should handle process deployment type', async () => {

      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001 } }
      ]);

      const options: StopOptions = {
        environment: 'local',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        platform: 'process',
        entity: 'backend',
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            port: 3001
          })
        })
      });
    });

    it('should handle external deployment type', async () => {

      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'external', config: { host: 'db.example.com', port: 5432, name: 'prod_db' } }
      ]);

      const options: StopOptions = {
        environment: 'production',
        output: 'table',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        platform: 'external',
        entity: 'database',
        status: 'external',
        metadata: expect.objectContaining({
          host: 'db.example.com',
          port: 5432,
          reason: 'External services cannot be stopped remotely'
        })
      });
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);


      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const formats = ['summary', 'json', 'yaml', 'table'] as const;
      
      for (const format of formats) {
        const options: StopOptions = {
          environment: 'test',
          output: format,
          force: false,
          verbose: false,
          dryRun: true
        };

        const result = await stop(serviceDeployments, options);
        
        expect(result).toBeDefined();
        expect(result.command).toBe('stop');
      }
    });
  });

  describe('Service Selection', () => {
    it('should stop all services in reverse order when service is "all"', async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);


      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      // Note: Services are passed in normal order, stop.ts will reverse them
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' },
        { name: 'frontend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: true
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      
      // Services should be stopped in reverse order: frontend, backend, database
      expect(result.results[0]!.entity).toBe('frontend');
      expect(result.results[1]!.entity).toBe('backend');
      expect(result.results[2]!.entity).toBe('database');
    });

    it('should stop specific service when named', async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);


      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.entity).toBe('backend');
    });
  });

  describe('Error Handling', () => {
    it('should handle failed stop operations', async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);


      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'summary',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        success: false,
        status: 'failed'
      });

      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
    });

    it('should continue on error when force is true', async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any)
        .mockResolvedValueOnce(true)  // First service succeeds
        .mockResolvedValueOnce(false) // Second service fails
        .mockResolvedValueOnce(true); // Third service succeeds


      const { stopCommand } = await import('../stop.js');
      const stop = stopCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' },
        { name: 'frontend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'table',
        force: true,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.results).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      expect(result.summary.succeeded).toBe(2);
      expect(result.summary.failed).toBe(1);
    });
  });
});