/**
 * Unit tests for the backup command with structured output support
 * 
 * These tests pass deployments directly to backup() instead of mocking service resolution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupCommand, BackupResult } from '../commands/backup.js';
const backup = backupCommand.handler;
import * as containerRuntime from '../platforms/container-runtime.js';
import { RDSClient, CreateDBSnapshotCommand } from '@aws-sdk/client-rds';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  createAWSDeployment,
  createContainerDeployment,
  createProcessDeployment,
  createExternalDeployment,
  createBackupOptions
} from './backup-test-helpers.js';

// Mock only external dependencies
vi.mock('../platforms/container-runtime.js');
vi.mock('@aws-sdk/client-rds');
vi.mock('fs/promises');
vi.mock('child_process');

describe('backup command with structured output', () => {
  const mockExecInContainer = vi.mocked(containerRuntime.execInContainer);
  const mockRDSClient = vi.mocked(RDSClient);
  const mockMkdir = vi.mocked(fs.mkdir);
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    process.env.USER = 'testuser';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AWS backups', () => {
    it('should create RDS snapshot and return structured output', async () => {
      const deployments = [
        createAWSDeployment('database', { identifier: 'semiont-prod-db' })
      ];
      
      const options = createBackupOptions({
        environment: 'production',
        name: 'test-backup',
        output: 'json'
      });

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

      const results = await backup(deployments, options);

      expect(results).toBeDefined();
      expect(results.command).toBe('backup');
      expect(results.environment).toBe('production');
      expect(results.services).toHaveLength(1);
      
      const dbResult = results.services[0]! as BackupResult;
      expect(dbResult.service).toBe('database');
      expect(dbResult.platform).toBe('aws');
      expect(dbResult.backupName).toBe('test-backup');
      expect(dbResult.backupType).toBe('full');
      expect(dbResult.compressed).toBe(false); // RDS handles compression internally
      
      expect(mockSend).toHaveBeenCalledWith(
        expect.any(CreateDBSnapshotCommand)
      );
    });

    it('should handle EFS automatic backups', async () => {
      const deployments = [
        createAWSDeployment('filesystem', { fileSystemId: 'fs-12345678' })
      ];
      
      const options = createBackupOptions({
        environment: 'staging',
        output: 'json'
      });

      const results = await backup(deployments, options);

      expect(results.services).toHaveLength(1);
      const efsResult = results.services[0]! as BackupResult;
      expect(efsResult.backupLocation).toBe('AWS EFS Backup Vault');
      expect(efsResult.backupType).toBe('incremental');
      expect(efsResult.metadata).toHaveProperty('automatic', true);
    });
  });

  describe('Container backups', () => {
    it('should create database dump from container', async () => {
      const deployments = [
        createContainerDeployment('database')
      ];
      
      const options = createBackupOptions({
        environment: 'local',
        name: 'local-backup',
        compress: false,
        output: 'yaml'
      });

      mockExecInContainer.mockResolvedValue(true);

      const results = await backup(deployments, options);

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0]! as BackupResult;
      expect(dbResult.platform).toBe('container');
      expect(dbResult.backupName).toBe('local-backup');
      expect(dbResult.compressed).toBe(false);
      
      expect(mockExecInContainer).toHaveBeenCalledWith(
        expect.stringContaining('postgres'),
        expect.arrayContaining(['pg_dumpall', '-U', 'postgres']),
        expect.any(Object)
      );
    });

    it('should backup container volumes', async () => {
      const deployments = [
        createContainerDeployment('filesystem', { path: '/data' })
      ];
      
      const options = createBackupOptions({
        environment: 'local',
        name: 'volume-backup',
        output: 'table'
      });

      mockExecInContainer.mockResolvedValue(true);

      const results = await backup(deployments, options);

      expect(results.services).toHaveLength(1);
      const fsResult = results.services[0]! as BackupResult;
      expect(fsResult.backupName).toBe('volume-backup');
      
      expect(mockExecInContainer).toHaveBeenCalledWith(
        expect.stringContaining('filesystem'),
        expect.arrayContaining(['tar', '-cf']),
        expect.any(Object)
      );
    });
  });

  describe('Process backups', () => {
    it('should backup local database using pg_dumpall', async () => {
      const deployments = [
        createProcessDeployment('database', {
          host: 'localhost',
          port: 5432,
          user: 'postgres',
          password: 'testpass'
        })
      ];
      
      const options = createBackupOptions({
        environment: 'local',
        name: 'postgres-backup',
        output: 'summary'
      });

      // Mock spawn for pg_dumpall
      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const backupPromise = backup(deployments, options);
      
      // Simulate successful pg_dumpall
      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);

      const results = await backupPromise;

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0]! as BackupResult;
      expect(dbResult.backupName).toBe('postgres-backup');
      
      expect(mockSpawn).toHaveBeenCalledWith(
        'pg_dumpall',
        expect.arrayContaining(['-h', 'localhost', '-U', 'postgres']),
        expect.any(Object)
      );
    });
  });

  describe('External service backups', () => {
    it('should provide guidance for external services', async () => {
      const deployments = [
        createExternalDeployment('database', {
          host: 'db.example.com',
          port: 5432
        })
      ];
      
      const options = createBackupOptions({
        environment: 'production',
        output: 'json'
      });

      const results = await backup(deployments, options);

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0]! as BackupResult;
      expect(dbResult.status).toBe('skipped');
      expect(dbResult.metadata).toHaveProperty('guidance');
    });
  });

  describe('Dry run mode', () => {
    it('should simulate backups without executing in dry run mode', async () => {
      const deployments = [
        createContainerDeployment('database'),
        createContainerDeployment('filesystem', { path: '/data' })
      ];
      
      const options = createBackupOptions({
        environment: 'local',
        dryRun: true,
        output: 'json'
      });

      const results = await backup(deployments, options);

      expect(results.executionContext.dryRun).toBe(true);
      expect(results.services).toHaveLength(2);
      
      for (const result of results.services) {
        const backupResult = result as BackupResult;
        expect(backupResult.status).toBe('dry-run');
        expect(backupResult.metadata.dryRun).toBe(true);
      }
      
      // Verify no actual operations were performed
      expect(mockExecInContainer).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should handle RDS snapshot failures', async () => {
      const deployments = [
        createAWSDeployment('database', { identifier: 'semiont-prod-db' })
      ];
      
      const options = createBackupOptions({
        environment: 'production',
        name: 'duplicate-name',
        output: 'json'
      });

      // Mock RDS client to throw error
      const mockSend = vi.fn().mockRejectedValue({
        name: 'DBSnapshotAlreadyExistsException',
        message: 'Snapshot already exists'
      });
      mockRDSClient.prototype.send = mockSend;

      const results = await backup(deployments, options);

      expect(results.services).toHaveLength(1);
      const dbResult = results.services[0]! as BackupResult;
      expect(dbResult.status).toBe('failed');
      expect(dbResult.error).toContain('Snapshot already exists');
    });

    it('should continue with other services if one fails', async () => {
      const deployments = [
        createContainerDeployment('database'),
        createContainerDeployment('filesystem', { path: '/data' })
      ];
      
      const options = createBackupOptions({
        environment: 'local',
        output: 'json'
      });

      // Make first backup fail, second succeed
      mockExecInContainer
        .mockRejectedValueOnce(new Error('Container not running'))
        .mockResolvedValueOnce(true);

      const results = await backup(deployments, options);

      expect(results.services).toHaveLength(2);
      expect(results.summary.total).toBe(2);
      expect(results.summary.failed).toBe(1);
      expect(results.summary.succeeded).toBe(1);
    });
  });

  describe('Compression option', () => {
    it('should respect compression settings', async () => {
      const deployments = [
        createProcessDeployment('database', {
          host: 'localhost',
          port: 5432,
          user: 'postgres'
        })
      ];
      
      const options = createBackupOptions({
        environment: 'local',
        compress: true,
        output: 'json'
      });

      const mockProcess = new EventEmitter() as any;
      mockSpawn.mockReturnValue(mockProcess);

      const backupPromise = backup(deployments, options);
      setTimeout(() => mockProcess.emit('close', 0), 10);

      const results = await backupPromise;

      const dbResult = results.services[0]! as BackupResult;
      expect(dbResult.compressed).toBe(true);
      expect(dbResult.backupLocation).toContain('.gz');
    });
  });

  describe('Backup naming', () => {
    it('should use provided backup name', async () => {
      const deployments = [
        createContainerDeployment('database')
      ];
      
      const options = createBackupOptions({
        environment: 'local',
        name: 'custom-backup-name',
        output: 'json'
      });

      mockExecInContainer.mockResolvedValue(true);

      const results = await backup(deployments, options);

      const dbResult = results.services[0]! as BackupResult;
      expect(dbResult.backupName).toBe('custom-backup-name');
    });

    it('should generate timestamp-based name if not provided', async () => {
      const deployments = [
        createContainerDeployment('database')
      ];
      
      const options = createBackupOptions({
        environment: 'local',
        name: undefined,
        output: 'json'
      });

      mockExecInContainer.mockResolvedValue(true);

      const results = await backup(deployments, options);

      const dbResult = results.services[0]! as BackupResult;
      expect(dbResult.backupName).toMatch(/database-\d{8}T\d{6}/);
    });
  });
});