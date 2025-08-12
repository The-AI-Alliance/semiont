/**
 * Unit tests for the backup command with structured output support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backup, BackupOptions } from '../commands/backup.js';
import { BackupResult, CommandResults } from '../lib/command-results.js';
import * as deploymentResolver from '../lib/deployment-resolver.js';
import * as services from '../lib/services.js';
import * as containerRuntime from '../lib/container-runtime.js';
import { RDSClient, CreateDBSnapshotCommand } from '@aws-sdk/client-rds';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock dependencies
vi.mock('../lib/deployment-resolver.js');
vi.mock('../lib/services.js');
vi.mock('../lib/container-runtime.js');
vi.mock('@aws-sdk/client-rds');
vi.mock('fs/promises');
vi.mock('child_process');

describe('backup command with structured output', () => {
  const mockResolveServiceSelector = vi.mocked(services.resolveServiceSelector);
  const mockValidateServiceSelector = vi.mocked(services.validateServiceSelector);
  const mockResolveServiceDeployments = vi.mocked(deploymentResolver.resolveServiceDeployments);
  const mockExecInContainer = vi.mocked(containerRuntime.execInContainer);
  const mockRDSClient = vi.mocked(RDSClient);
  const mockMkdir = vi.mocked(fs.mkdir);
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mocks for service resolution
    mockValidateServiceSelector.mockResolvedValue(undefined);
    mockResolveServiceSelector.mockResolvedValue(['database', 'frontend']);
    
    // Mock file system operations
    mockMkdir.mockResolvedValue(undefined);
    
    // Mock process environment
    process.env.USER = 'testuser';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AWS backups', () => {
    it('should create RDS snapshot and return structured output', async () => {
      const options: BackupOptions = {
        environment: 'production',
        service: 'database',
        name: 'test-backup',
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'database',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {
            aws: { region: 'us-east-1' },
            identifier: 'semiont-prod-db'
          }
        }
      ]);

      // Mock RDS client
      const mockSend = vi.fn().mockResolvedValue({
        DBSnapshot: {
          DBSnapshotIdentifier: 'test-backup',
          SnapshotCreateTime: new Date(),
          Status: 'creating',
          AllocatedStorage: 100,
          Engine: 'postgres'
        }
      });
      mockRDSClient.prototype.send = mockSend;

      const results = await backup(options);

      expect(results).toBeDefined();
      expect(results.command).toBe('backup');
      expect(results.environment).toBe('production');
      expect(results.services).toHaveLength(1);
      
      const dbResult = results.services[0] as BackupResult;
      expect(dbResult.service).toBe('database');
      expect(dbResult.deploymentType).toBe('aws');
      expect(dbResult.backupName).toContain('database');
      expect(dbResult.backupType).toBe('full');
      expect(dbResult.compressed).toBe(true);
      
      // Verify RDS snapshot was created
      expect(mockSend).toHaveBeenCalledWith(
        expect.any(CreateDBSnapshotCommand)
      );
    });

    it('should handle EFS automatic backups', async () => {
      const options: BackupOptions = {
        environment: 'staging',
        service: 'filesystem',
        name: undefined,
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: false,
        output: 'json'
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

      const results = await backup(options);

      expect(results.services).toHaveLength(1);
      const efsResult = results.services[0] as BackupResult;
      expect(efsResult.backupLocation).toBe('AWS EFS Backup Vault');
      expect(efsResult.backupType).toBe('incremental');
      expect(efsResult.retentionPolicy).toBe('AWS managed');
      expect(efsResult.metadata).toHaveProperty('automatic', true);
    });
  });

  describe('Container backups', () => {
    it('should create database dump from container', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'database',
        name: 'local-backup',
        outputPath: './backups',
        compress: false,
        verbose: false,
        dryRun: false,
        output: 'yaml'
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

      const results = await backup(options);

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0] as BackupResult;
      expect(dbResult.deploymentType).toBe('container');
      expect(dbResult.backupName).toBe('local-backup');
      expect(dbResult.compressed).toBe(false);
      
      // Verify container exec was called for pg_dumpall
      expect(mockExecInContainer).toHaveBeenCalledWith(
        'semiont-postgres-local',
        'pg_dumpall -U postgres',
        expect.any(Object)
      );
    });

    it('should backup container volumes', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'filesystem',
        name: 'volume-backup',
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      mockResolveServiceSelector.mockResolvedValue(['filesystem']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'filesystem',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      mockExecInContainer.mockResolvedValue(true);

      const results = await backup(options);

      expect(results.services).toHaveLength(1);
      const volResult = results.services[0] as BackupResult;
      expect(volResult.backupName).toBe('volume-backup');
      
      // Verify tar command was executed
      expect(mockExecInContainer).toHaveBeenCalledWith(
        expect.stringContaining('filesystem'),
        expect.stringContaining('tar'),
        expect.any(Object)
      );
    });
  });

  describe('Process backups', () => {
    it('should backup local database using pg_dumpall', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'database',
        name: 'local-db-backup',
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceSelector.mockResolvedValue(['database']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'database',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: {}
        }
      ]);

      // Mock spawn for pg_dumpall
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(mockProcess);

      const backupPromise = backup(options);
      
      // Simulate successful backup
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);

      const results = await backupPromise;

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0] as BackupResult;
      expect(dbResult.deploymentType).toBe('process');
      expect(dbResult.backupName).toBe('local-db-backup');
      
      // Verify pg_dumpall was called
      expect(mockSpawn).toHaveBeenCalledWith(
        'pg_dumpall',
        expect.arrayContaining(['-h', 'localhost', '-U', 'postgres']),
        expect.any(Object)
      );
    });

    it('should backup application files with tar', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'frontend',
        name: 'app-backup',
        outputPath: './backups',
        compress: false,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      mockResolveServiceSelector.mockResolvedValue(['frontend']);
      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'frontend',
          deploymentType: 'process',
          deployment: { type: 'process' },
          config: {}
        }
      ]);

      // Mock spawn for tar
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const backupPromise = backup(options);
      
      // Simulate successful tar
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);

      const results = await backupPromise;

      expect(results.services).toHaveLength(1);
      const appResult = results.services[0] as BackupResult;
      expect(appResult.backupName).toBe('app-backup');
      
      // Verify tar was called with exclusions
      expect(mockSpawn).toHaveBeenCalledWith(
        'tar',
        expect.arrayContaining([
          '--exclude=node_modules',
          '--exclude=.git',
          '--exclude=dist',
          '--exclude=build'
        ]),
        expect.any(Object)
      );
    });
  });

  describe('External service backups', () => {
    it('should provide guidance for external services', async () => {
      const options: BackupOptions = {
        environment: 'production',
        service: 'database',
        name: undefined,
        outputPath: './backups',
        compress: true,
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
            port: 5432
          }
        }
      ]);

      const results = await backup(options);

      expect(results.services).toHaveLength(1);
      const extResult = results.services[0] as BackupResult;
      expect(extResult.deploymentType).toBe('external');
      expect(extResult.status).toBe('guidance-only');
      expect(extResult.metadata).toHaveProperty('external', true);
    });
  });

  describe('Dry run mode', () => {
    it('should simulate backups without executing in dry run mode', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'all',
        name: undefined,
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: true,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'database',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        },
        {
          name: 'frontend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      const results = await backup(options);

      expect(results.executionContext.dryRun).toBe(true);
      expect(results.services).toHaveLength(2);
      
      results.services.forEach(service => {
        const backupResult = service as BackupResult;
        expect(backupResult.status).toBe('dry-run');
        expect(backupResult.metadata).toHaveProperty('dryRun', true);
        expect(backupResult.backupSize).toBe(0);
      });

      // Verify no actual backup operations were performed
      expect(mockExecInContainer).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockRDSClient.prototype.send).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should handle service resolution errors gracefully', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'invalid-service',
        name: undefined,
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockValidateServiceSelector.mockRejectedValue(
        new Error('Invalid service selector: invalid-service')
      );

      await expect(backup(options)).rejects.toThrow('Invalid service selector');
    });

    it('should handle RDS snapshot failures', async () => {
      const options: BackupOptions = {
        environment: 'production',
        service: 'database',
        name: 'duplicate-name',
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'database',
          deploymentType: 'aws',
          deployment: { type: 'aws' },
          config: {
            aws: { region: 'us-east-1' },
            identifier: 'semiont-prod-db'
          }
        }
      ]);

      // Mock RDS client to throw error
      const mockSend = vi.fn().mockRejectedValue({
        name: 'DBSnapshotAlreadyExistsException',
        message: 'Snapshot already exists'
      });
      mockRDSClient.prototype.send = mockSend;

      const results = await backup(options);

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0] as BackupResult;
      expect(dbResult.success).toBe(false);
      expect(dbResult.status).toBe('failed');
      expect(dbResult.error).toContain('Snapshot already exists');
    });

    it('should continue with other services if one fails', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'all',
        name: undefined,
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockResolveServiceDeployments.mockResolvedValue([
        {
          name: 'database',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        },
        {
          name: 'frontend',
          deploymentType: 'container',
          deployment: { type: 'container' },
          config: {}
        }
      ]);

      // Make first backup fail, second succeed
      mockExecInContainer
        .mockRejectedValueOnce(new Error('Container not running'))
        .mockResolvedValueOnce(true);

      const results = await backup(options);

      expect(results.services).toHaveLength(2);
      expect(results.summary.total).toBe(2);
      expect(results.summary.succeeded).toBe(1);
      expect(results.summary.failed).toBe(1);
      
      const [dbResult, frontendResult] = results.services as BackupResult[];
      expect(dbResult.success).toBe(false);
      expect(frontendResult.success).toBe(true);
    });
  });

  describe('Output formats', () => {
    it('should support JSON output format', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'database',
        name: 'json-test',
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: true,
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

      const results = await backup(options);

      expect(results).toBeDefined();
      expect(results.command).toBe('backup');
      expect(results.environment).toBe('local');
      expect(results.services).toBeInstanceOf(Array);
    });

    it('should support summary output format', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'database',
        name: 'summary-test',
        outputPath: './backups',
        compress: true,
        verbose: false,
        dryRun: true,
        output: 'summary'
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

      const results = await backup(options);

      expect(results.command).toBe('backup');
      // Summary format still returns structured data
      expect(results.summary.total).toBe(1);
    });
  });

  describe('Compression option', () => {
    it('should respect compression settings', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'database',
        name: 'compressed-backup',
        outputPath: './backups',
        compress: true,
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

      const results = await backup(options);

      const dbResult = results.services[0] as BackupResult;
      expect(dbResult.compressed).toBe(true);
    });

    it('should handle uncompressed backups', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'database',
        name: 'uncompressed-backup',
        outputPath: './backups',
        compress: false,
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

      const results = await backup(options);

      const dbResult = results.services[0] as BackupResult;
      expect(dbResult.compressed).toBe(false);
    });
  });

  describe('Backup naming', () => {
    it('should use provided backup name', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'database',
        name: 'custom-backup-name',
        outputPath: './backups',
        compress: true,
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

      const results = await backup(options);

      const dbResult = results.services[0] as BackupResult;
      expect(dbResult.backupName).toBe('custom-backup-name');
    });

    it('should generate timestamp-based name if not provided', async () => {
      const options: BackupOptions = {
        environment: 'local',
        service: 'database',
        name: undefined,
        outputPath: './backups',
        compress: true,
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

      const results = await backup(options);

      const dbResult = results.services[0] as BackupResult;
      expect(dbResult.backupName).toMatch(/database-\d{8}T\d{6}/);
    });
  });
});