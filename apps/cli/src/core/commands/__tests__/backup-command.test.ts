/**
 * Backup Command Tests
 * 
 * Tests the backup command logic using MockPlatformStrategy.
 * Focus: command orchestration, backup operations, data preservation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockPlatformInstance, createServiceDeployments, resetMockState } from './_mock-setup.js';

// Import mocks (side effects)
import './_mock-setup.js';

describe('Backup Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful backup', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database' },  // Uses 'mock' platform by default
        { name: 'backend' }     // Uses 'mock' platform by default
      ]);

      const options = {
        environment: 'production',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        outputPath: './backups',
        compress: true,
        encrypt: false
      };

      const result = await backup(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'backup',
        environment: 'production',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        summary: {
          total: 2,
          succeeded: 2,
          failed: 0
        }
      });
      
      // Check results separately for clearer assertions
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toMatchObject({
        entity: 'database',
        platform: 'mock',
        success: true
      });
      expect(result.results[1]).toMatchObject({
        entity: 'backend',
        platform: 'mock',
        success: true
      });
    });

    it('should handle dry run mode', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database' }  // Uses 'mock' platform
      ]);

      const options = {
        environment: 'staging',
        output: 'summary',
        quiet: false,
        verbose: false,
        dryRun: true,
        outputPath: './backups',
        compress: true,
        encrypt: false
      };

      const result = await backup(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'database',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });
    });

    it('should handle backup with custom output path', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database' }  // Uses 'mock' platform
      ]);

      const options = {
        environment: 'production',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        outputPath: '/custom/backup/path',
        compress: true,
        encrypt: false
      };

      const result = await backup(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'database',
        success: true
      });
    });

    it('should support encryption', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database' }  // Uses 'mock' platform
      ]);

      const options = {
        environment: 'production',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        outputPath: './backups',
        compress: true,
        encrypt: true
      };

      const result = await backup(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'database',
        success: true
      });
    });

    it('should handle backup failures gracefully', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      // Make MockPlatformStrategy fail for this test
      const originalBackup = mockPlatformInstance.backup;
      mockPlatformInstance.backup = vi.fn().mockRejectedValue(new Error('Backup failed'));

      const serviceDeployments = createServiceDeployments([
        { name: 'database' }  // Uses 'mock' platform
      ]);

      const options = {
        environment: 'test',
        output: 'json',
        quiet: true,
        verbose: false,
        dryRun: false,
        outputPath: './backups',
        compress: true,
        encrypt: false
      };

      const result = await backup(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'database',
        platform: 'mock',  // Now using mock platform consistently
        success: false,
        error: 'Backup failed'
      });

      expect(result.summary).toMatchObject({
        total: 1,
        succeeded: 0,
        failed: 1
      });

      // Restore original method
      mockPlatformInstance.backup = originalBackup;
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend' }  // Uses 'mock' platform
      ]);

      const formats = ['json', 'yaml', 'table', 'summary'];
      
      for (const format of formats) {
        const options = {
          environment: 'test',
          output: format,
          quiet: false,
          verbose: false,
          dryRun: false,
          outputPath: './backups',
          compress: true,
          encrypt: false
        };

        const result = await backup(serviceDeployments, options);

        expect(result).toMatchObject({
          command: 'backup',
          environment: 'test'
        });
      }
    });
  });

  describe('Service Selection', () => {
    it('should backup all services when all is true', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend' },  // Uses 'mock' platform
        { name: 'backend' },   // Uses 'mock' platform
        { name: 'database' }   // Uses 'mock' platform
      ]);

      const options = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        all: true,
        outputPath: './backups',
        compress: true,
        encrypt: false
      };

      const result = await backup(serviceDeployments, options);

      expect(result.results).toHaveLength(3);
      expect(result.results.map(r => r.entity)).toEqual(
        expect.arrayContaining(['frontend', 'backend', 'database'])
      );
    });

    it('should backup specific service when named', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      // When a specific service is selected, only that service should be in the deployments
      const serviceDeployments = createServiceDeployments([
        { name: 'database' }  // Uses 'mock' platform
      ]);

      const options = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        service: 'database',
        outputPath: './backups',
        compress: true,
        encrypt: false
      };

      const result = await backup(serviceDeployments, options);

      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.entity).toBe('database');
    });
  });

  describe('Retention and Compression', () => {
    it('should respect retention policy', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database' }  // Uses 'mock' platform
      ]);

      const options = {
        environment: 'production',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        retention: '7d',
        outputPath: './backups',
        compress: true,
        encrypt: false
      };

      const result = await backup(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'database',
        success: true
      });
    });

    it('should handle compression setting', async () => {
      const { backupCommand } = await import('../backup.js');
      const backup = backupCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database' }  // Uses 'mock' platform
      ]);

      const options = {
        environment: 'production',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        outputPath: './backups',
        compress: false,
        encrypt: false
      };

      const result = await backup(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'database',
        success: true
      });
    });
  });
});