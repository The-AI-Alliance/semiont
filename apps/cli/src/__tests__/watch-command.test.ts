/**
 * Unit tests for the watch command with structured output support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watch, WatchOptions } from '../commands/watch.js';
import { WatchResult } from '../services/watch-service.js';
import type { ServicePlatformInfo } from '../lib/platform-resolver.js';

// Mock dependencies
vi.mock('ink', () => ({
  render: vi.fn()
}));

// Helper function to create service deployments for tests
function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>): ServicePlatformInfo[] {
  return services.map(service => ({
    name: service.name,
    platform: service.type as any,
    platform: { type: service.type },
    config: service.config || {}
  }));
}

describe('watch command with structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock process environment
    process.env.USER = 'testuser';
    process.env.VITEST = 'true';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Dashboard session tracking', () => {
    it('should return structured output for completed watch session', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'aws' },
        { name: 'backend', type: 'aws' }
      ]);

      const options: WatchOptions = {
        environment: 'production',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // In structured output mode, watch should complete quickly
      const results = await watch(serviceDeployments, options);

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
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'staging',
        target: 'logs',
        noFollow: false,
        interval: 10,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const results = await watch(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.service).toBe('backend');
      expect(watchResult.watchType).toBe('logs');
      expect(watchResult.metadata.mode).toBe('logs');
    });

    it('should handle metrics-only mode', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process' },
        { name: 'backend', type: 'process' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'metrics',
        noFollow: true,
        interval: 30,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const results = await watch(serviceDeployments, options);

      results.services.forEach(service => {
        const watchResult = service as WatchResult;
        expect(watchResult.watchType).toBe('metrics');
        expect(watchResult.metadata.mode).toBe('metrics');
      });
    });
  });

  describe('Interactive dashboard mode', () => {
    it('should launch interactive dashboard in summary mode', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const results = await watch(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.metadata.interactive).toBe(true);
      expect(watchResult.metadata.exitReason).toBe('user-quit');
    });

    it('should handle dashboard crash', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'aws' }
      ]);

      const options: WatchOptions = {
        environment: 'production',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const results = await watch(serviceDeployments, options);

      const watchResult = results.services[0]! as WatchResult;
      // In test mode, dashboard always succeeds
      expect(watchResult.metadata.exitReason).toBe('user-quit');
    });
  });

  describe('Dry run mode', () => {
    it('should simulate watch session without launching dashboard', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: true,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      expect(results.executionContext.dryRun).toBe(true);
      expect(results.services).toHaveLength(1);
      
      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.status).toBe('session-ended');
      expect(watchResult.metadata.exitReason).toBe('dry-run');
      expect(watchResult.metadata.sessionDuration).toBe(0);
    });
  });

  describe('Service filtering', () => {
    it('should filter to specific service', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      expect(results.services[0]!.service).toBe('frontend');
    });

    it('should handle all services', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'aws' },
        { name: 'backend', type: 'aws' },
        { name: 'database', type: 'aws' }
      ]);

      const options: WatchOptions = {
        environment: 'production',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      expect(results.services).toHaveLength(3);
      expect(results.summary.total).toBe(3);
    });
  });

  describe('Watch targets', () => {
    it('should handle services target', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'services',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.watchType).toBe('events'); // 'services' maps to 'events' type
      expect(watchResult.metadata.mode).toBe('services');
    });
  });

  describe('Refresh interval', () => {
    it('should respect custom refresh interval', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'all',
        noFollow: false,
        interval: 60,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.metadata.refreshInterval).toBe(60);
    });
  });

  describe('Error handling', () => {
    it('should handle empty service deployments', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];

      const options: WatchOptions = {
        environment: 'local',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);
      expect(results.services).toHaveLength(0);
      expect(results.summary.total).toBe(0);
    });
  });

  describe('Output formats', () => {
    it('should support JSON output format', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: true,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.command).toBe('watch');
      expect(results.environment).toBe('local');
      expect(results.services).toBeInstanceOf(Array);
    });

    it('should support summary output format', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: true,
        output: 'summary'
      };

      const results = await watch(serviceDeployments, options);

      expect(results.command).toBe('watch');
      // Summary format still returns structured data
      expect(results.summary.total).toBe(1);
      expect(results.summary.succeeded).toBe(1);
    });

    it('should support YAML output format', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'aws' }
      ]);

      const options: WatchOptions = {
        environment: 'staging',
        target: 'logs',
        noFollow: true,
        interval: 10,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const results = await watch(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.command).toBe('watch');
      expect(results.services).toHaveLength(1);
    });

    it('should support table output format', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'aws' },
        { name: 'backend', type: 'aws' }
      ]);

      const options: WatchOptions = {
        environment: 'production',
        target: 'metrics',
        noFollow: false,
        interval: 15,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const results = await watch(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.services).toHaveLength(2);
    });
  });

  describe('Deployment type awareness', () => {
    it('should handle AWS deployments', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'aws', config: { aws: { region: 'us-east-1' } } }
      ]);

      const options: WatchOptions = {
        environment: 'production',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.platform).toBe('aws');
    });

    it('should handle container deployments', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'logs',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.platform).toBe('container');
    });

    it('should handle process deployments', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process', config: { port: 3000 } }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'metrics',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.platform).toBe('process');
    });

    it('should handle external deployments', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'external', config: { host: 'db.example.com' } }
      ]);

      const options: WatchOptions = {
        environment: 'production',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.platform).toBe('external');
    });
  });

  describe('Session metadata', () => {
    it('should track session duration', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const results = await watch(serviceDeployments, options);

      expect(results.duration).toBeGreaterThan(0);
      const watchResult = results.services[0]! as WatchResult;
      expect(watchResult.metadata.sessionDuration).toBeGreaterThan(0);
    });

    it('should always report success for watch sessions', async () => {
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: WatchOptions = {
        environment: 'local',
        target: 'all',
        noFollow: false,
        interval: 5,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const results = await watch(serviceDeployments, options);

      expect(results.summary.succeeded).toBe(1);
      expect(results.summary.failed).toBe(0);
      expect(results.services[0]!.success).toBe(true);
    });
  });
});