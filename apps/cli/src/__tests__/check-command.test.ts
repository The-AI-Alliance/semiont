/**
 * Check Command Tests
 * 
 * Tests the check command's structured output functionality across
 * different deployment types and health check scenarios.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CheckOptions } from '../commands/check.js';
import type { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { createTestEnvironment, cleanupTestEnvironment } from './setup.js';

// Mock deployment-resolver to avoid filesystem access
vi.mock('../lib/deployment-resolver.js');

let testDir: string;
let originalCwd: string;

// Mock child_process for process checks
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    stdout: { 
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          callback(Buffer.from('12345\n'));
        }
      })
    },
    stderr: { on: vi.fn() },
    on: vi.fn((event, callback) => {
      if (event === 'exit') {
        // Simulate successful health check
        setTimeout(() => callback(0), 10);
      }
    })
  })),
  exec: vi.fn((_, callback) => {
    // Mock successful command execution
    callback(null, 'mock output', '');
  })
}));

// Mock container runtime
vi.mock('../lib/container-runtime.js', () => ({
  listContainers: vi.fn().mockResolvedValue(['semiont-frontend-test', 'semiont-backend-test'])
}));

// Mock HTTP module for health checks
vi.mock('http', () => ({
  get: vi.fn((_, callback) => {
    const res = {
      statusCode: 200,
      on: vi.fn()
    };
    callback(res);
    return { on: vi.fn() };
  }),
  default: {
    get: vi.fn((_, callback) => {
      const res = {
        statusCode: 200,
        on: vi.fn()
      };
      callback(res);
      return { on: vi.fn() };
    })
  }
}));

describe('Check Command', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Save current directory
    originalCwd = process.cwd();
    // Use a mock test directory instead of creating real files
    testDir = '/tmp/test-check-' + Date.now();
    process.env.SEMIONT_ROOT = testDir;
  });
  
  afterEach(() => {
    vi.clearAllMocks();
    // Restore original directory
    if (originalCwd) {
      process.chdir(originalCwd);
    }
    // Clean up environment variable
    delete process.env.SEMIONT_ROOT;
  });

  // Helper function to create service deployments for tests
  function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>): ServiceDeploymentInfo[] {
    return services.map(service => ({
      name: service.name,
      deploymentType: service.type as any,
      config: service.config || {}
    }));
  }

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful checks', async () => {

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { port: 3000 } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'check',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'check',
            service: 'frontend',
            deploymentType: 'container',
            success: true,
            lastCheck: expect.any(Date),
            healthStatus: expect.any(String),
            checks: expect.any(Array),
            resourceId: expect.objectContaining({
              container: expect.objectContaining({
                name: 'semiont-frontend-test'
              })
            })
          })
        ]),
        summary: {
          total: 1,
          succeeded: expect.any(Number),
          failed: expect.any(Number),
          warnings: expect.any(Number)
        },
        executionContext: expect.objectContaining({
          user: expect.any(String),
          workingDirectory: expect.any(String),
          dryRun: false
        })
      });
    });

    it('should handle dry run mode correctly', async () => {

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001 } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'services',
        verbose: true,
        dryRun: true,
        output: 'table'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });
    });

    it('should filter by section when specified', async () => {

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'services',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      // Should have checked services
      expect(result.services.length).toBeGreaterThan(0);
      result.services.forEach((service: any) => {
        expect(service.checks).toBeDefined();
      });
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type', async () => {

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'aws' }
      ]);

      const options: CheckOptions = {
        environment: 'production',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'aws',
        status: expect.any(String),
        resourceId: expect.objectContaining({
          aws: expect.any(Object)
        })
      });
    });

    it('should handle container deployment type', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue(['semiont-postgres-staging']);


      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container', config: { image: 'postgres:15' } }
      ]);

      const options: CheckOptions = {
        environment: 'staging',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'container',
        resourceId: expect.objectContaining({
          container: expect.objectContaining({
            name: 'semiont-postgres-staging'
          })
        })
      });
    });

    it('should handle process deployment type', async () => {

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process', config: { port: 3000, command: 'npm run dev' } }
      ]);

      const options: CheckOptions = {
        environment: 'local',
        section: 'all',
        verbose: true,
        dryRun: false,
        output: 'table'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'process',
        resourceId: expect.objectContaining({
          process: expect.any(Object)
        })
      });
    });

    it('should handle external deployment type', async () => {

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'external', config: { host: 'db.example.com', port: 5432 } }
      ]);

      const options: CheckOptions = {
        environment: 'production',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'external',
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: expect.any(String),
            status: expect.any(String)
          })
        ])
      });
    });

    it('should handle mock deployment type', async () => {

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'mock',
        healthStatus: 'healthy',
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'mock-service',
            status: 'pass'
          })
        ])
      });
    });
  });

  describe('Health Check Features', () => {
    it('should check container health status', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue(['semiont-backend-test']);


      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container', config: { port: 3001 } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'health',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      const service = result.services[0]! as any;
      expect(service.checks).toBeDefined();
      expect(service.checks.some((c: any) => c.name === 'container-running')).toBe(true);
    });

    it('should check process port availability', async () => {

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001 } }
      ]);

      const options: CheckOptions = {
        environment: 'local',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      const service = result.services[0]! as any; // CheckResult type
      
      expect(service).toBeDefined();
      expect(service.checks).toBeDefined();
      const processCheck = service.checks.find((c: any) => c.name === 'process-running');
      expect(processCheck).toBeDefined();
    });

    it('should check filesystem accessibility', async () => {
      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'filesystem', type: 'process', config: { path: '/tmp/test-data' } }
      ]);

      const options: CheckOptions = {
        environment: 'local',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      const service = result.services[0]! as any;
      expect(service.checks).toBeDefined();
      const fsCheck = service.checks.find((c: any) => c.name === 'filesystem-access');
      expect(fsCheck).toBeDefined();
      // Note: Status will depend on whether /tmp/test-data exists
    });

    it('should check external service connectivity', async () => {

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'external', config: { host: 'api.example.com', port: 443 } }
      ]);

      const options: CheckOptions = {
        environment: 'production',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      const service = result.services[0]! as any;
      expect(service.checks).toBeDefined();
      expect(service.healthStatus).toBeDefined();
    });
  });

  describe('Service Selection', () => {
    it('should check all services when not specified', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue([
        'semiont-postgres-test',
        'semiont-backend-test',
        'semiont-frontend-test'
      ]);


      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' },
        { name: 'frontend', type: 'container' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services).toHaveLength(3);
      const serviceNames = result.services.map((s: any) => s.service).sort();
      expect(serviceNames).toEqual(['backend', 'database', 'frontend']);
    });

    it('should check specific service when provided', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue(['semiont-backend-test']);


      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.service).toBe('backend');
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue(['semiont-backend-test']);


      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const formats: Array<'summary' | 'table' | 'json' | 'yaml'> = ['summary', 'table', 'json', 'yaml'];
      
      for (const format of formats) {
        const options: CheckOptions = {
          environment: 'test',
          section: 'all',
          verbose: false,
          dryRun: false,
          output: format
        };

        const result = await check(serviceDeployments, options);
        
        expect(result).toMatchObject({
          command: 'check',
          environment: 'test',
          services: expect.any(Array),
          summary: expect.objectContaining({
            total: expect.any(Number),
            succeeded: expect.any(Number),
            failed: expect.any(Number)
          })
        });
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle container not running', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue([]); // No containers running


      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect((result.services[0] as any).healthStatus).toBe('unhealthy');
      expect((result.services[0] as any).checks).toContainEqual(
        expect.objectContaining({
          name: 'container-running',
          status: 'fail'
        })
      );
    });

    it('should handle filesystem not accessible', async () => {
      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'filesystem', type: 'process', config: { path: '/nonexistent/path/should/not/exist' } }
      ]);

      const options: CheckOptions = {
        environment: 'local',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect((result.services[0] as any).healthStatus).toBe('unhealthy');
      expect((result.services[0] as any).checks).toContainEqual(
        expect.objectContaining({
          name: 'filesystem-access',
          status: 'fail'
        })
      );
    });
  });

  describe('MCP Service Health Checks', () => {
    beforeEach(() => {
      // Mock fs for MCP auth file operations
      vi.mock('fs/promises', async () => {
        const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
        return {
          ...actual,
          access: vi.fn().mockResolvedValue(undefined),
          readFile: vi.fn().mockResolvedValue(JSON.stringify({
            refresh_token: 'test-refresh-token',
            api_url: 'https://test.semiont.com',
            environment: 'test',
            created_at: new Date().toISOString()
          }))
        };
      });

      // Mock os.homedir
      vi.mock('os', () => ({
        homedir: vi.fn(() => '/home/test')
      }));
    });

    it('should check MCP provisioned status', async () => {
      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'process', config: { port: 8585, authMode: 'browser' } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json',
        service: 'mcp'
      };

      const result = await check(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'check',
        environment: 'test',
        services: expect.arrayContaining([
          expect.objectContaining({
            service: 'mcp',
            deploymentType: 'process',
            success: true,
            healthStatus: 'healthy',
            checks: expect.arrayContaining([
              expect.objectContaining({
                name: 'mcp-provisioned',
                status: 'pass',
                message: expect.stringContaining('provisioned')
              })
            ])
          })
        ])
      });
    });

    it('should warn about old refresh tokens', async () => {
      // Mock a token that's 26 days old
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 26);
      
      vi.mock('fs/promises', async () => {
        const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
        return {
          ...actual,
          access: vi.fn().mockResolvedValue(undefined),
          readFile: vi.fn().mockResolvedValue(JSON.stringify({
            refresh_token: 'test-refresh-token',
            api_url: 'https://test.semiont.com',
            environment: 'test',
            created_at: oldDate.toISOString()
          }))
        };
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'process', config: { port: 8585 } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'health',
        verbose: false,
        dryRun: false,
        output: 'json',
        service: 'mcp'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]).toMatchObject({
        service: 'mcp',
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'mcp-token-age',
            status: 'warn',
            message: expect.stringContaining('expires in')
          })
        ])
      });
    });

    it('should detect MCP not provisioned', async () => {
      // Mock missing auth file
      vi.mock('fs/promises', async () => {
        const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
        return {
          ...actual,
          access: vi.fn().mockRejectedValue(new Error('File not found'))
        };
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'process', config: { port: 8585 } }
      ]);

      const options: CheckOptions = {
        environment: 'production',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json',
        service: 'mcp'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]).toMatchObject({
        service: 'mcp',
        healthStatus: 'unhealthy',
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'mcp-provisioned',
            status: 'fail',
            message: expect.stringContaining('not provisioned')
          })
        ])
      });
    });

    it('should check MCP server running status', async () => {
      // Mock checkProcessOnPort to return true (MCP is running)
      vi.mock('../commands/check.js', async () => {
        const actual = await vi.importActual('../commands/check.js');
        return {
          ...actual,
          checkProcessOnPort: vi.fn().mockResolvedValue(true)
        };
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'process', config: { port: 8585 } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'health',
        verbose: false,
        dryRun: false,
        output: 'json',
        service: 'mcp'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]).toMatchObject({
        service: 'mcp',
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'mcp-server-running',
            status: 'pass',
            message: expect.stringContaining('running')
          })
        ])
      });
    });

    it('should handle missing refresh token in auth file', async () => {
      // Mock auth file without refresh_token
      vi.mock('fs/promises', async () => {
        const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
        return {
          ...actual,
          access: vi.fn().mockResolvedValue(undefined),
          readFile: vi.fn().mockResolvedValue(JSON.stringify({
            api_url: 'https://test.semiont.com',
            environment: 'test',
            created_at: new Date().toISOString()
            // refresh_token is missing
          }))
        };
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'process', config: { port: 8585 } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json',
        service: 'mcp'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]).toMatchObject({
        service: 'mcp',
        healthStatus: 'unhealthy',
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'mcp-provisioned',
            status: 'fail',
            message: expect.stringContaining('Missing refresh token')
          })
        ])
      });
    });
  });
});