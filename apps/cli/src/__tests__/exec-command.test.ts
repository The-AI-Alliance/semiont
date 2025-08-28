/**
 * Unit tests for the exec command with structured output support
 * 
 * These tests pass deployments directly to exec() instead of mocking service resolution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec } from '../commands/exec.js';
import { ExecResult } from '../commands/exec.js';
import * as containerRuntime from '../platforms/container-runtime.js';
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  createAWSDeployment,
  createContainerDeployment,
  createProcessDeployment,
  createExternalDeployment,
  createExecOptions
} from './exec-test-helpers.js';

// Mock only external dependencies
vi.mock('../platforms/container-runtime.js');
vi.mock('@aws-sdk/client-ecs');
vi.mock('child_process');
vi.mock('../platforms/platform-resolver.js', async () => {
  const actual = await vi.importActual('../platforms/platform-resolver.js');
  return {
    ...actual,
    loadEnvironmentConfig: vi.fn(() => ({
      aws: { region: 'us-east-1', accountId: '123456789012' },
      services: {},
      platform: {}
    }))
  };
});

describe('exec command with structured output', () => {
  const mockExecInContainer = vi.mocked(containerRuntime.execInContainer);
  const mockECSClient = vi.mocked(ECSClient);
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.USER = 'testuser';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AWS exec', () => {
    it('should execute commands in ECS tasks and return structured output', async () => {
      const deployment = createAWSDeployment('backend', {
        aws: { region: 'us-east-1' }
      });
      
      const options = createExecOptions({
        environment: 'production',
        command: '/bin/sh',
        interactive: true,
        output: 'json'
      });

      // Mock ECS client
      const mockSend = vi.fn().mockResolvedValue({
        taskArns: ['arn:aws:ecs:us-east-1:123456789012:task/semiont-production/abcd1234']
      });
      mockECSClient.prototype.send = mockSend;

      // Mock spawn for AWS CLI
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(deployment, options);
      
      // Simulate successful exec
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);
      const results = await execPromise;
      expect(results).toBeDefined();
      expect(results.command).toBe('exec');
      expect(results.environment).toBe('production');
      expect(results.services).toHaveLength(1);
      
      const execResult = results.services[0]! as ExecResult;
      
      // Debug: Log the actual result to see what went wrong
      if (execResult.status !== 'success') {
        console.log('ExecResult:', JSON.stringify(execResult, null, 2));
      }
      
      expect(execResult.service).toBe('backend');
      expect(execResult.platform).toBe('aws');
      expect(execResult.command).toBe('/bin/sh');
      expect(execResult.interactive).toBe(true);
      expect(execResult.status).toBe('success');
      
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
      const deployment = createAWSDeployment('database', {
        aws: { region: 'us-east-1' }
      });
      
      const options = createExecOptions({
        environment: 'staging',
        command: 'psql',
        interactive: false,
        output: 'json'
      });
      const results = await exec(deployment, options);
      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0]! as ExecResult;
      expect(dbResult.status).toBe('failed');
      expect(dbResult.error).toContain('RDS exec not supported');
    });

    it('should handle EFS exec attempts appropriately', async () => {
      const deployment = createAWSDeployment('filesystem');
      
      const options = createExecOptions({
        environment: 'production',
        command: 'ls',
        interactive: false,
        output: 'yaml'
      });
      const results = await exec(deployment, options);
      expect(results.services).toHaveLength(1);
      const fsResult = results.services[0]! as ExecResult;
      expect(fsResult.status).toBe('failed');
      expect(fsResult.error).toContain('EFS exec not supported');
    });

    it('should handle ECS task not found', async () => {
      const deployment = createAWSDeployment('backend', {
        aws: { region: 'us-east-1' }
      });
      
      const options = createExecOptions({
        environment: 'production',
        command: '/bin/sh',
        interactive: false,
        output: 'json'
      });

      // Mock ECS client returning no tasks
      const mockSend = vi.fn().mockResolvedValue({
        taskArns: []
      });
      mockECSClient.prototype.send = mockSend;
      const results = await exec(deployment, options);
      expect(results.services).toHaveLength(1);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.status).toBe('failed');
      expect(execResult.error).toContain('No running backend tasks found');
    });
  });

  describe('Container exec', () => {
    it('should execute commands in containers', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'ls -la',
        interactive: false,
        output: 'table'
      });

      mockExecInContainer.mockResolvedValue(true);
      const results = await exec(deployment, options);
      expect(results.services).toHaveLength(1);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.platform).toBe('container');
      expect(execResult.command).toBe('ls -la');
      expect(execResult.status).toBe('success');
      
      // Verify container exec was called with array of commands
      expect(mockExecInContainer).toHaveBeenCalledWith(
        'semiont-backend-local',
        ['ls -la'],
        expect.objectContaining({
          interactive: false,
          verbose: false
        })
      );
    });

    it('should handle database container exec', async () => {
      const deployment = createContainerDeployment('database');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'psql -U postgres',
        interactive: true,
        output: 'json'
      });

      mockExecInContainer.mockResolvedValue(true);
      const results = await exec(deployment, options);
      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0]! as ExecResult;
      expect(dbResult.platform).toBe('container');
      expect(dbResult.status).toBe('success');
      
      // Verify correct container name for database
      expect(mockExecInContainer).toHaveBeenCalledWith(
        'semiont-postgres-local',
        ['psql -U postgres'],
        expect.any(Object)
      );
    });

    it('should handle container exec failures', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'invalid-command',
        interactive: false,
        output: 'json'
      });

      mockExecInContainer.mockResolvedValue(false);
      const results = await exec(deployment, options);
      expect(results.services).toHaveLength(1);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.status).toBe('failed');
      expect(execResult.error).toContain('Container exec failed');
    });

    it('should handle container exec exceptions', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'test-cmd',
        interactive: false,
        output: 'json'
      });

      mockExecInContainer.mockRejectedValue(new Error('Container not running'));
      const results = await exec(deployment, options);
      expect(results.services).toHaveLength(1);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.status).toBe('failed');
      expect(execResult.error).toContain('Container not running');
    });
  });

  describe('Process exec', () => {
    it('should execute commands in process context', async () => {
      const deployment = createProcessDeployment('frontend', { port: 3000 });
      
      const options = createExecOptions({
        environment: 'local',
        command: '/bin/sh',
        interactive: true,
        output: 'json'
      });

      // Mock spawn for shell
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(deployment, options);
      
      // Simulate successful execution
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);
      const results = await execPromise;
      expect(results.services).toHaveLength(1);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.platform).toBe('process');
      expect(execResult.status).toBe('success');
      
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
      const deployment = createProcessDeployment('database', { password: 'testpass' });
      
      const options = createExecOptions({
        environment: 'local',
        command: '/bin/sh',
        interactive: true,
        output: 'summary'
      });

      // Mock spawn for psql
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(deployment, options);
      
      // Simulate successful connection
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);
      const results = await execPromise;
      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0]! as ExecResult;
      expect(dbResult.platform).toBe('process');
      expect(dbResult.status).toBe('success');
      
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
      const deployment = createProcessDeployment('filesystem', { path: './data' });
      
      const options = createExecOptions({
        environment: 'local',
        command: '/bin/sh',
        interactive: false,
        output: 'json'
      });

      // Mock spawn for file explorer
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(deployment, options);
      
      // Simulate successful open
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);
      const results = await execPromise;
      expect(results.services).toHaveLength(1);
      const fsResult = results.services[0]! as ExecResult;
      expect(fsResult.platform).toBe('process');
      expect(fsResult.status).toBe('success');
      
      // Verify appropriate command was used (varies by platform)
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringMatching(/open|explorer|ls/),
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('should handle spawn errors for process exec', async () => {
      const deployment = createProcessDeployment('frontend');
      
      const options = createExecOptions({
        environment: 'local',
        command: '/bin/sh',
        interactive: true,
        output: 'json'
      });

      // Mock spawn error
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(deployment, options);
      
      // Simulate error
      setTimeout(() => {
        mockProcess.emit('error', new Error('Command not found'));
      }, 10);
      const results = await execPromise;
      expect(results.services).toHaveLength(1);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.status).toBe('failed');
      expect(execResult.error).toContain('Command not found');
    });

    it('should handle non-zero exit codes', async () => {
      const deployment = createProcessDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'exit 1',
        interactive: false,
        output: 'json'
      });

      // Mock spawn with non-zero exit
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(deployment, options);
      
      // Simulate exit code 1
      setTimeout(() => {
        mockProcess.emit('close', 1);
      }, 10);
      const results = await execPromise;
      expect(results.services).toHaveLength(1);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.status).toBe('failed');
      expect(execResult.error).toContain('Command failed with code 1');
    });
  });

  describe('External service exec', () => {
    it('should provide guidance for external database', async () => {
      const deployment = createExternalDeployment('database', {
        host: 'db.example.com',
        port: 5432,
        user: 'dbuser',
        name: 'appdb'
      });
      
      const options = createExecOptions({
        environment: 'production',
        command: 'psql',
        interactive: false,
        output: 'json'
      });
      const results = await exec(deployment, options);
      expect(results.services).toHaveLength(1);
      const extResult = results.services[0]! as ExecResult;
      expect(extResult.platform).toBe('external');
      expect(extResult.status).toBe('failed');
      expect(extResult.error).toContain('Cannot exec into external database');
      expect(extResult.metadata).toHaveProperty('error');
    });

    it('should provide guidance for external filesystem', async () => {
      const deployment = createExternalDeployment('filesystem', {
        path: '/mnt/storage'
      });
      
      const options = createExecOptions({
        environment: 'production',
        command: 'ls',
        interactive: false,
        output: 'json'
      });
      const results = await exec(deployment, options);
      expect(results.services).toHaveLength(1);
      const fsResult = results.services[0]! as ExecResult;
      expect(fsResult.platform).toBe('external');
      expect(fsResult.status).toBe('failed');
      expect(fsResult.error).toContain('Cannot exec into external filesystem');
    });
  });

  describe('Dry run mode', () => {
    it('should simulate exec without executing in dry run mode', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'rm -rf /',
        interactive: false,
        dryRun: true,
        output: 'json'
      });
      const results = await exec(deployment, options);
      expect(results.executionContext.dryRun).toBe(true);
      expect(results.services).toHaveLength(1);
      
      const execResult = results.services[0]! as ExecResult;
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

  describe('Output formats', () => {
    it('should support JSON output format', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'echo "test"',
        interactive: false,
        dryRun: true,
        output: 'json'
      });
      const results = await exec(deployment, options);
      expect(results).toBeDefined();
      expect(results.command).toBe('exec');
      expect(results.environment).toBe('local');
      expect(results.services).toBeInstanceOf(Array);
    });

    it('should support summary output format', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'ls',
        interactive: false,
        dryRun: true,
        output: 'summary'
      });
      const results = await exec(deployment, options);
      expect(results.command).toBe('exec');
      // Summary format still returns structured data
      expect(results.summary.total).toBe(1);
    });

    it('should support table output format', async () => {
      const deployment = createProcessDeployment('frontend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'echo test',
        interactive: false,
        dryRun: true,
        output: 'table'
      });
      const results = await exec(deployment, options);
      expect(results.command).toBe('exec');
      expect(results.services).toHaveLength(1);
    });

    it('should support yaml output format', async () => {
      const deployment = createAWSDeployment('backend');
      
      const options = createExecOptions({
        environment: 'production',
        command: 'date',
        interactive: false,
        dryRun: true,
        output: 'yaml'
      });
      const results = await exec(deployment, options);
      expect(results.command).toBe('exec');
      expect(results.services).toHaveLength(1);
    });
  });

  describe('Interactive vs non-interactive', () => {
    it('should handle interactive mode', async () => {
      const deployment = createAWSDeployment('backend', {
        aws: { region: 'us-east-1' }
      });
      
      const options = createExecOptions({
        environment: 'production',
        command: '/bin/sh',
        interactive: true,
        output: 'json'
      });

      // Mock ECS client
      const mockSend = vi.fn().mockResolvedValue({
        taskArns: ['arn:aws:ecs:us-east-1:123456789012:task/semiont-production/abcd1234']
      });
      mockECSClient.prototype.send = mockSend;

      // Mock spawn for AWS CLI
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const execPromise = exec(deployment, options);
      
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);
      const results = await execPromise;
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.interactive).toBe(true);
      
      // Verify --interactive flag was passed to AWS CLI
      expect(mockSpawn).toHaveBeenCalledWith(
        'aws',
        expect.arrayContaining(['--interactive']),
        expect.any(Object)
      );
    });

    it('should handle non-interactive mode', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'echo "test"',
        interactive: false,
        output: 'json'
      });

      mockExecInContainer.mockResolvedValue(true);
      const results = await exec(deployment, options);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.interactive).toBe(false);
      
      // Verify interactive: false was passed
      expect(mockExecInContainer).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          interactive: false
        })
      );
    });
  });

  describe('Command defaults', () => {
    it('should use /bin/sh as default command', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: '/bin/sh',
        interactive: true,
        dryRun: true,
        output: 'json'
      });
      const results = await exec(deployment, options);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.command).toBe('/bin/sh');
    });

    it('should handle custom commands', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'npm run test',
        interactive: false,
        dryRun: true,
        output: 'json'
      });
      const results = await exec(deployment, options);
      const execResult = results.services[0]! as ExecResult;
      expect(execResult.command).toBe('npm run test');
    });
  });

  describe('Verbose mode', () => {
    it('should respect verbose flag', async () => {
      const deployment = createContainerDeployment('backend');
      
      const options = createExecOptions({
        environment: 'local',
        command: 'ls',
        interactive: false,
        verbose: true,
        output: 'summary'
      });

      mockExecInContainer.mockResolvedValue(true);
      await exec(deployment, options);
      // Verify verbose was passed through
      expect(mockExecInContainer).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          verbose: true
        })
      );
    });
  });
});