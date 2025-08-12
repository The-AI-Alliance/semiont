/**
 * Unit tests for the watch command with structured output support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watch, WatchOptions } from '../commands/watch.js';
import { WatchResult, CommandResults } from '../lib/command-results.js';
import * as deploymentResolver from '../lib/deployment-resolver.js';
import * as services from '../lib/services.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock dependencies
vi.mock('../lib/deployment-resolver.js');
vi.mock('../lib/services.js');
vi.mock('child_process');
vi.mock('ink', () => ({
  render: vi.fn()
}));

describe('watch command with structured output', () => {
  const mockResolveServiceSelector = vi.mocked(services.resolveServiceSelector);
  const mockValidateServiceSelector = vi.mocked(services.validateServiceSelector);
  const mockResolveServiceDeployments = vi.mocked(deploymentResolver.resolveServiceDeployments);
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

  describe('Dashboard session tracking', () => {
    it('should return structured output for completed watch session', async () => {
      const options: WatchOptions = {
        environment: 'production',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 5,
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
          name: 'backend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {}
        }
      ]);

      // In structured output mode, watch should complete quickly
      const results = await watch(options);

      expect(results).toBeDefined();
      expect(results.command).toBe('watch');
      expect(results.environment).toBe('production');
      expect(results.services).toHaveLength(2);
      
      results.services.forEach(service => {
        const watchResult = service as WatchResult;
        expect(watchResult.status).toBe('session-ended');
        expect(watchResult.metadata).toHaveProperty('mode', 'all');
        expect(watchResult.metadata).toHaveProperty('refreshInterval', 5);
        expect(watchResult.metadata).toHaveProperty('exitReason');
        expect(watchResult.metadata).toHaveProperty('interactive', false);
      });
    });

    it('should handle logs-only mode', async () => {
      const options: WatchOptions = {
        environment: 'staging',
        service: 'backend',
        target: 'logs',
        noFollow: false,
        interval: 10,
        verbose: false,
        dryRun: false,
        output: 'yaml'
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

      const results = await watch(options);

      expect(results.services).toHaveLength(1);
      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.service).toBe('backend');
      expect(watchResult.watchType).toBe('logs');
      expect(watchResult.metadata.mode).toBe('logs');
    });

    it('should handle metrics-only mode', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'all',
        target: 'metrics',
        noFollow: true,
        interval: 30,
        verbose: false,
        dryRun: false,
        output: 'table'
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

      const results = await watch(options);

      results.services.forEach(service => {
        const watchResult = service as WatchResult;
        expect(watchResult.watchType).toBe('metrics');
        expect(watchResult.metadata.mode).toBe('metrics');
      });
    });
  });

  describe('Interactive dashboard mode', () => {
    it('should launch interactive dashboard in summary mode', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 5,
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
        }
      ]);

      // Mock spawn for dashboard process
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const watchPromise = watch(options);
      
      // Simulate dashboard exit after some time
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 100);

      const results = await watchPromise;

      expect(results.services).toHaveLength(1);
      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.metadata.interactive).toBe(true);
      expect(watchResult.metadata.exitReason).toBe('user-quit');
      
      // Verify dashboard was launched
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('should handle dashboard crash', async () => {
      const options: WatchOptions = {
        environment: 'production',
        service: 'frontend',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      mockResolveServiceSelector.mockResolvedValue(['frontend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {}
        }
      ]);

      // Mock spawn for dashboard process
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const watchPromise = watch(options);
      
      // Simulate dashboard crash
      setTimeout(() => {
        mockProcess.emit('close', 1);
      }, 100);

      const results = await watchPromise;

      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.metadata.exitReason).toBe('error-code-1');
    });
  });

  describe('Dry run mode', () => {
    it('should simulate watch session without launching dashboard', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: true,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      const results = await watch(options);

      expect(results.executionContext.dryRun).toBe(true);
      expect(results.services).toHaveLength(1);
      
      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.status).toBe('session-ended');
      expect(watchResult.metadata.exitReason).toBe('dry-run');
      expect(watchResult.metadata.sessionDuration).toBe(0);

      // Verify no actual dashboard was launched
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('Service filtering', () => {
    it('should filter to specific service', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'frontend',
        target: 'all',
        noFollow: false,
        interval: 5,
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

      const results = await watch(options);

      expect(results.services).toHaveLength(1);
      expect(results.services[0].service).toBe('frontend');
    });

    it('should handle all services', async () => {
      const options: WatchOptions = {
        environment: 'production',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 5,
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
          name: 'backend',
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

      const results = await watch(options);

      expect(results.services).toHaveLength(3);
      expect(results.summary.total).toBe(3);
    });
  });

  describe('Watch targets', () => {
    it('should handle services target', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'all',
        target: 'services',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      const results = await watch(options);

      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.watchType).toBe('events'); // 'services' maps to 'events' type
      expect(watchResult.metadata.mode).toBe('services');
    });
  });

  describe('Refresh interval', () => {
    it('should respect custom refresh interval', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 60,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      const results = await watch(options);

      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.metadata.refreshInterval).toBe(60);
    });
  });

  describe('Error handling', () => {
    it('should handle service resolution errors gracefully', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'invalid-service',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockValidateServiceSelector.mockRejectedValue(
        new Error('Invalid service selector: invalid-service')
      );

      await expect(watch(options)).rejects.toThrow('Invalid service selector');
    });
  });

  describe('Output formats', () => {
    it('should support JSON output format', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: true,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      const results = await watch(options);

      expect(results).toBeDefined();
      expect(results.command).toBe('watch');
      expect(results.environment).toBe('local');
      expect(results.services).toBeInstanceOf(Array);
    });

    it('should support summary output format', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: true,
        output: 'summary'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      const results = await watch(options);

      expect(results.command).toBe('watch');
      // Summary format still returns structured data
      expect(results.summary.total).toBe(1);
      expect(results.summary.succeeded).toBe(1);
    });

    it('should support YAML output format', async () => {
      const options: WatchOptions = {
        environment: 'staging',
        service: 'backend',
        target: 'logs',
        noFollow: true,
        interval: 10,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      mockResolveServiceSelector.mockResolvedValue(['backend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {}
        }
      ]);

      const results = await watch(options);

      expect(results).toBeDefined();
      expect(results.command).toBe('watch');
      expect(results.services).toHaveLength(1);
    });

    it('should support table output format', async () => {
      const options: WatchOptions = {
        environment: 'production',
        service: 'all',
        target: 'metrics',
        noFollow: false,
        interval: 15,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {}
        },
        {
          name: 'backend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {}
        }
      ]);

      const results = await watch(options);

      expect(results).toBeDefined();
      expect(results.services).toHaveLength(2);
    });
  });

  describe('Deployment type awareness', () => {
    it('should handle AWS deployments', async () => {
      const options: WatchOptions = {
        environment: 'production',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: { aws: { region: 'us-east-1' } }
        }
      ]);

      const results = await watch(options);

      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.deploymentType).toBe('aws');
    });

    it('should handle container deployments', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'backend',
        target: 'logs',
        noFollow: false,
        interval: 5,
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

      const results = await watch(options);

      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.deploymentType).toBe('container');
    });

    it('should handle process deployments', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'frontend',
        target: 'metrics',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['frontend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: { port: 3000 }
        }
      ]);

      const results = await watch(options);

      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.deploymentType).toBe('process');
    });

    it('should handle external deployments', async () => {
      const options: WatchOptions = {
        environment: 'production',
        service: 'database',
        target: 'all',
        noFollow: false,
        interval: 5,
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
          config: { host: 'db.example.com' }
        }
      ]);

      const results = await watch(options);

      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.deploymentType).toBe('external');
    });
  });

  describe('Session metadata', () => {
    it('should track session duration', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      // Mock spawn for dashboard process
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const watchPromise = watch(options);
      
      // Simulate dashboard running for 500ms
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 500);

      const results = await watchPromise;

      expect(results.duration).toBeGreaterThan(0);
      const watchResult = results.services[0] as WatchResult;
      expect(watchResult.metadata.sessionDuration).toBeGreaterThan(0);
    });

    it('should always report success for watch sessions', async () => {
      const options: WatchOptions = {
        environment: 'local',
        service: 'all',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      const results = await watch(options);

      expect(results.summary.succeeded).toBe(1);
      expect(results.summary.failed).toBe(0);
      expect(results.services[0].success).toBe(true);
    });
  });
});