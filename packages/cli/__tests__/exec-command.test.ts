/**
 * Unit tests for the exec command with structured output support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec, ExecOptions } from '../commands/exec.js';
import { ExecResult, CommandResults } from '../lib/command-results.js';
import * as deploymentResolver from '../lib/deployment-resolver.js';
import * as services from '../lib/services.js';
import * as containerRuntime from '../lib/container-runtime.js';
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock dependencies
vi.mock('../lib/deployment-resolver.js');
vi.mock('../lib/services.js');
vi.mock('../lib/container-runtime.js');
vi.mock('@aws-sdk/client-ecs');
vi.mock('child_process');

describe('exec command with structured output', () => {
  const mockResolveServiceSelector = vi.mocked(services.resolveServiceSelector);
  const mockValidateServiceSelector = vi.mocked(services.validateServiceSelector);
  const mockResolveServiceDeployments = vi.mocked(deploymentResolver.resolveServiceDeployments);
  const mockExecInContainer = vi.mocked(containerRuntime.execInContainer);
  const mockECSClient = vi.mocked(ECSClient);
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mocks for service resolution
    mockValidateServiceSelector.mockResolvedValue(undefined);
    mockResolveServiceSelector.mockResolvedValue(['backend']);
    
    // Mock process environment
    process.env.USER = 'testuser';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AWS exec', () => {
    it('should execute commands in ECS tasks and return structured output', async () => {
      const options: ExecOptions = {
        environment: 'production',
        service: 'backend',
        command: '/bin/sh',
        interactive: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {
            aws: { region: 'us-east-1' }
          }
        }
      ]);

      // Mock ECS client
      const mockSend = vi.fn().mockResolvedValue({
        taskArns: ['arn:aws:ecs:us-east-1:123456789012:task/semiont-production/abcd1234']
      });
      mockECSClient.prototype.send = mockSend;

      // Mock spawn for AWS CLI
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(options);
      
      // Simulate successful exec
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);

      const results = await execPromise;

      expect(results).toBeDefined();
      expect(results.command).toBe('exec');
      expect(results.environment).toBe('production');
      expect(results.services).toHaveLength(1);
      
      const execResult = results.services[0] as ExecResult;
      expect(execResult.service).toBe('backend');
      expect(execResult.deploymentType).toBe('aws');
      expect(execResult.command).toBe('/bin/sh');
      expect(execResult.interactive).toBe(true);
      
      // Verify ECS list tasks was called
      expect(mockSend).toHaveBeenCalledWith(
        expect.any(ListTasksCommand)
      );
      
      // Verify AWS CLI was invoked
      expect(mockSpawn).toHaveBeenCalledWith(
        'aws',
        expect.arrayContaining(['ecs', 'execute-command']),
        expect.any(Object)
      );
    });

    it('should handle RDS exec attempts appropriately', async () => {
      const options: ExecOptions = {
        environment: 'staging',
        service: 'database',
        command: 'psql',
        interactive: false,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['database']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'database',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {
            aws: { region: 'us-east-1' }
          }
        }
      ]);

      const results = await exec(options);

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0] as ExecResult;
      expect(dbResult.success).toBe(false);
      expect(dbResult.error).toContain('RDS exec not supported');
    });

    it('should handle EFS exec attempts appropriately', async () => {
      const options: ExecOptions = {
        environment: 'production',
        service: 'filesystem',
        command: 'ls',
        interactive: false,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      mockResolveServiceSelector.mockResolvedValue(['filesystem']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'filesystem',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {}
        }
      ]);

      const results = await exec(options);

      expect(results.services).toHaveLength(1);
      const fsResult = results.services[0] as ExecResult;
      expect(fsResult.success).toBe(false);
      expect(fsResult.error).toContain('EFS exec not supported');
    });
  });

  describe('Container exec', () => {
    it('should execute commands in containers', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'backend',
        command: 'ls -la',
        interactive: false,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      mockExecInContainer.mockResolvedValue(true);

      const results = await exec(options);

      expect(results.services).toHaveLength(1);
      const execResult = results.services[0] as ExecResult;
      expect(execResult.deploymentType).toBe('container');
      expect(execResult.command).toBe('ls -la');
      expect(execResult.success).toBe(true);
      
      // Verify container exec was called
      expect(mockExecInContainer).toHaveBeenCalledWith(
        'semiont-backend-local',
        'ls -la',
        expect.objectContaining({
          interactive: false,
          verbose: false
        })
      );
    });

    it('should handle database container exec', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'database',
        command: 'psql -U postgres',
        interactive: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['database']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'database',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      mockExecInContainer.mockResolvedValue(true);

      const results = await exec(options);

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0] as ExecResult;
      expect(dbResult.deploymentType).toBe('container');
      
      // Verify correct container name for database
      expect(mockExecInContainer).toHaveBeenCalledWith(
        'semiont-postgres-local',
        'psql -U postgres',
        expect.any(Object)
      );
    });
  });

  describe('Process exec', () => {
    it('should execute commands in process context', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'frontend',
        command: '/bin/sh',
        interactive: true,
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

      // Mock spawn for shell
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(options);
      
      // Simulate successful execution
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);

      const results = await execPromise;

      expect(results.services).toHaveLength(1);
      const execResult = results.services[0] as ExecResult;
      expect(execResult.deploymentType).toBe('process');
      expect(execResult.success).toBe(true);
      
      // Verify spawn was called with appropriate shell
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringMatching(/bash|cmd/),
        expect.objectContaining({
          stdio: 'inherit',
          shell: true,
          cwd: 'apps/frontend'
        })
      );
    });

    it('should connect to local PostgreSQL database', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'database',
        command: '/bin/sh',
        interactive: true,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      mockResolveServiceSelector.mockResolvedValue(['database']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'database',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: { password: 'testpass' }
        }
      ]);

      // Mock spawn for psql
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(options);
      
      // Simulate successful connection
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);

      const results = await execPromise;

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0] as ExecResult;
      expect(dbResult.deploymentType).toBe('process');
      
      // Verify psql was called
      expect(mockSpawn).toHaveBeenCalledWith(
        'psql',
        expect.arrayContaining(['-h', 'localhost', '-U', 'postgres']),
        expect.objectContaining({
          env: expect.objectContaining({
            PGPASSWORD: 'testpass'
          })
        })
      );
    });

    it('should handle filesystem location opening', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'filesystem',
        command: '/bin/sh',
        interactive: false,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['filesystem']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'filesystem',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: { path: './data' }
        }
      ]);

      // Mock spawn for file explorer
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(options);
      
      // Simulate successful open
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);

      const results = await execPromise;

      expect(results.services).toHaveLength(1);
      const fsResult = results.services[0] as ExecResult;
      expect(fsResult.deploymentType).toBe('process');
      
      // Verify appropriate command was used (varies by platform)
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringMatching(/open|explorer|ls/),
        expect.any(Array),
        expect.any(Object)
      );
    });
  });

  describe('External service exec', () => {
    it('should provide guidance for external services', async () => {
      const options: ExecOptions = {
        environment: 'production',
        service: 'database',
        command: 'psql',
        interactive: false,
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
            user: 'dbuser',
            name: 'appdb'
          }
        }
      ]);

      const results = await exec(options);

      expect(results.services).toHaveLength(1);
      const extResult = results.services[0] as ExecResult;
      expect(extResult.deploymentType).toBe('external');
      expect(extResult.success).toBe(false);
      expect(extResult.error).toContain('Cannot exec into external database');
      expect(extResult.metadata).toHaveProperty('error');
    });
  });

  describe('Dry run mode', () => {
    it('should simulate exec without executing in dry run mode', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'backend',
        command: 'rm -rf /',
        interactive: false,
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

      const results = await exec(options);

      expect(results.executionContext.dryRun).toBe(true);
      expect(results.services).toHaveLength(1);
      
      const execResult = results.services[0] as ExecResult;
      expect(execResult.status).toBe('dry-run');
      expect(execResult.metadata).toHaveProperty('dryRun', true);
      expect(execResult.exitCode).toBe(0);
      expect(execResult.output).toBe('[DRY RUN] Command not executed');

      // Verify no actual exec operations were performed
      expect(mockExecInContainer).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockECSClient.prototype.send).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should handle service resolution errors gracefully', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'invalid-service',
        command: '/bin/sh',
        interactive: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockValidateServiceSelector.mockRejectedValue(
        new Error('Invalid service selector: invalid-service')
      );

      await expect(exec(options)).rejects.toThrow('Invalid service selector');
    });

    it('should handle single service requirement', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'all',
        command: '/bin/sh',
        interactive: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['frontend', 'backend', 'database']);

      await expect(exec(options)).rejects.toThrow(
        'Can only execute commands in one service at a time'
      );
    });

    it('should handle ECS task not found', async () => {
      const options: ExecOptions = {
        environment: 'production',
        service: 'backend',
        command: '/bin/sh',
        interactive: false,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {
            aws: { region: 'us-east-1' }
          }
        }
      ]);

      // Mock ECS client returning no tasks
      const mockSend = vi.fn().mockResolvedValue({
        taskArns: []
      });
      mockECSClient.prototype.send = mockSend;

      const results = await exec(options);

      expect(results.services).toHaveLength(1);
      const execResult = results.services[0] as ExecResult;
      expect(execResult.success).toBe(false);
      expect(execResult.error).toContain('No running backend tasks found');
    });

    it('should handle container exec failures', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'backend',
        command: 'invalid-command',
        interactive: false,
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

      mockExecInContainer.mockResolvedValue(false);

      const results = await exec(options);

      expect(results.services).toHaveLength(1);
      const execResult = results.services[0] as ExecResult;
      expect(execResult.success).toBe(false);
      expect(execResult.error).toContain('Container exec failed');
    });

    it('should handle spawn errors for process exec', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'frontend',
        command: '/bin/sh',
        interactive: true,
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
        }
      ]);

      // Mock spawn error
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(options);
      
      // Simulate error
      setTimeout(() => {
        mockProcess.emit('error', new Error('Command not found'));
      }, 10);

      const results = await execPromise;

      expect(results.services).toHaveLength(1);
      const execResult = results.services[0] as ExecResult;
      expect(execResult.success).toBe(false);
      expect(execResult.error).toContain('Command not found');
    });
  });

  describe('Output formats', () => {
    it('should support JSON output format', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'backend',
        command: 'echo "test"',
        interactive: false,
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

      const results = await exec(options);

      expect(results).toBeDefined();
      expect(results.command).toBe('exec');
      expect(results.environment).toBe('local');
      expect(results.services).toBeInstanceOf(Array);
    });

    it('should support summary output format', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'backend',
        command: 'ls',
        interactive: false,
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

      const results = await exec(options);

      expect(results.command).toBe('exec');
      // Summary format still returns structured data
      expect(results.summary.total).toBe(1);
    });
  });

  describe('Interactive vs non-interactive', () => {
    it('should handle interactive mode', async () => {
      const options: ExecOptions = {
        environment: 'production',
        service: 'backend',
        command: '/bin/sh',
        interactive: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'backend',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {
            aws: { region: 'us-east-1' }
          }
        }
      ]);

      // Mock ECS client
      const mockSend = vi.fn().mockResolvedValue({
        taskArns: ['arn:aws:ecs:us-east-1:123456789012:task/semiont-production/abcd1234']
      });
      mockECSClient.prototype.send = mockSend;

      // Mock spawn for AWS CLI
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(options);
      
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);

      const results = await execPromise;

      const execResult = results.services[0] as ExecResult;
      expect(execResult.interactive).toBe(true);
      
      // Verify --interactive flag was passed to AWS CLI
      expect(mockSpawn).toHaveBeenCalledWith(
        'aws',
        expect.arrayContaining(['--interactive']),
        expect.any(Object)
      );
    });

    it('should handle non-interactive mode', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'backend',
        command: 'echo "test"',
        interactive: false,
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

      mockExecInContainer.mockResolvedValue(true);

      const results = await exec(options);

      const execResult = results.services[0] as ExecResult;
      expect(execResult.interactive).toBe(false);
      
      // Verify interactive: false was passed
      expect(mockExecInContainer).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          interactive: false
        })
      );
    });
  });

  describe('Command defaults', () => {
    it('should use /bin/sh as default command', async () => {
      const options: ExecOptions = {
        environment: 'local',
        service: 'backend',
        command: '/bin/sh',
        interactive: true,
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

      const results = await exec(options);

      const execResult = results.services[0] as ExecResult;
      expect(execResult.command).toBe('/bin/sh');
    });
  });
});