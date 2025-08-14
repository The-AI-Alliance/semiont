/**
 * Tests for the new command infrastructure
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { CommandBuilder } from '../lib/command-definition.js';
import { createArgParser } from '../lib/arg-parser.js';
import { loadCommand } from '../lib/command-loader.js';
import type { BaseCommandOptions } from '../lib/command-types.js';

describe('Command Infrastructure', () => {
  describe('CommandBuilder', () => {
    it('should build a complete command definition', () => {
      const TestSchema = z.object({
        environment: z.string(),
        verbose: z.boolean().default(false),
        output: z.enum(['summary', 'json']).default('summary'),
        dryRun: z.boolean().default(false),
      });
      
      const command = new CommandBuilder<z.infer<typeof TestSchema>>()
        .name('test')
        .description('Test command')
        .schema(TestSchema)
        .args({
          args: {
            '--environment': { type: 'string', description: 'Environment' },
            '--verbose': { type: 'boolean', description: 'Verbose' },
          },
          aliases: { '-e': '--environment', '-v': '--verbose' },
        })
        .handler(async () => ({
          command: 'test',
          environment: 'test',
          timestamp: new Date(),
          duration: 0,
          services: [],
          summary: { total: 0, succeeded: 0, failed: 0, warnings: 0 },
          executionContext: { user: 'test', workingDirectory: '.', dryRun: false },
        }))
        .build();
      
      expect(command.name).toBe('test');
      expect(command.description).toBe('Test command');
      expect(command.requiresEnvironment).toBe(true); // default
      expect(command.requiresServices).toBe(true); // default
      expect(command.handler).toBeDefined();
    });
    
    it('should throw if required fields are missing', () => {
      const builder = new CommandBuilder<BaseCommandOptions>();
      
      expect(() => builder.build()).toThrow('Command name is required');
      
      builder.name('test');
      expect(() => builder.build()).toThrow('Command description is required');
      
      builder.description('Test');
      expect(() => builder.build()).toThrow('Command schema is required');
    });
  });
  
  describe('Argument Parser', () => {
    it('should parse command arguments correctly', () => {
      const TestSchema = z.object({
        environment: z.string(),
        verbose: z.boolean().default(false),
        force: z.boolean().default(false),
        output: z.enum(['summary', 'json', 'yaml']).default('summary'),
        dryRun: z.boolean().default(false),
      });
      
      const command = new CommandBuilder<z.infer<typeof TestSchema>>()
        .name('test')
        .description('Test')
        .schema(TestSchema)
        .args({
          args: {
            '--environment': { type: 'string', description: 'Env', required: true },
            '--verbose': { type: 'boolean', description: 'Verbose' },
            '--force': { type: 'boolean', description: 'Force' },
            '--output': { type: 'string', description: 'Output' },
          },
          aliases: {
            '-e': '--environment',
            '-v': '--verbose',
            '-f': '--force',
            '-o': '--output',
          },
        })
        .handler(async () => ({} as any))
        .build();
      
      const parser = createArgParser(command);
      
      // Test with long form arguments
      const result1 = parser(['--environment', 'production', '--verbose', '--output', 'json']);
      expect(result1.environment).toBe('production');
      expect(result1.verbose).toBe(true);
      expect(result1.output).toBe('json');
      expect(result1.force).toBe(false); // default
      
      // Test with aliases
      const result2 = parser(['-e', 'staging', '-v', '-f']);
      expect(result2.environment).toBe('staging');
      expect(result2.verbose).toBe(true);
      expect(result2.force).toBe(true);
      expect(result2.output).toBe('summary'); // default
    });
    
    it('should handle kebab-case to camelCase conversion', () => {
      const TestSchema = z.object({
        environment: z.string().default('local'),
        dryRun: z.boolean().default(false),
        skipTests: z.boolean().default(false),
        output: z.string().default('summary'),
        verbose: z.boolean().default(false),
      });
      
      const command = new CommandBuilder<z.infer<typeof TestSchema>>()
        .name('test')
        .description('Test')
        .schema(TestSchema)
        .args({
          args: {
            '--dry-run': { type: 'boolean', description: 'Dry run' },
            '--skip-tests': { type: 'boolean', description: 'Skip tests' },
          },
        })
        .handler(async () => ({} as any))
        .build();
      
      const parser = createArgParser(command);
      const result = parser(['--dry-run', '--skip-tests']);
      
      expect(result.dryRun).toBe(true);
      expect(result.skipTests).toBe(true);
    });
    
    it('should handle no-prefix boolean inversions', () => {
      const TestSchema = z.object({
        environment: z.string().default('local'),
        compress: z.boolean().default(true),
        output: z.string().default('summary'),
        verbose: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      });
      
      const command = new CommandBuilder<z.infer<typeof TestSchema>>()
        .name('test')
        .description('Test')
        .schema(TestSchema)
        .args({
          args: {
            '--no-compress': { type: 'boolean', description: 'Skip compression' },
          },
        })
        .handler(async () => ({} as any))
        .build();
      
      const parser = createArgParser(command);
      const result = parser(['--no-compress']);
      
      expect(result.compress).toBe(false); // Inverted
    });
    
    it('should validate with Zod schema', () => {
      const TestSchema = z.object({
        environment: z.string(),
        port: z.number().min(1).max(65535),
        output: z.enum(['json', 'yaml']),
        verbose: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      });
      
      const command = new CommandBuilder<z.infer<typeof TestSchema>>()
        .name('test')
        .description('Test')
        .schema(TestSchema)
        .args({
          args: {
            '--environment': { type: 'string', description: 'Env' },
            '--port': { type: 'number', description: 'Port' },
            '--output': { type: 'string', description: 'Output', choices: ['json', 'yaml'] },
          },
        })
        .handler(async () => ({} as any))
        .build();
      
      const parser = createArgParser(command);
      
      // Valid arguments
      const result = parser(['--environment', 'test', '--port', '3000', '--output', 'json']);
      expect(result.port).toBe(3000);
      expect(result.output).toBe('json');
      
      // Invalid enum value
      expect(() => parser(['--environment', 'test', '--port', '3000', '--output', 'invalid']))
        .toThrow(/Invalid arguments/);
      
      // Port out of range (Zod validation)
      expect(() => parser(['--environment', 'test', '--port', '99999', '--output', 'json']))
        .toThrow(/Invalid arguments/);
    });
  });
  
  describe('Command Loader', () => {
    it('should load init command', async () => {
      const command = await loadCommand('init');
      
      expect(command.name).toBe('init');
      expect(command.description).toBe('Initialize a new Semiont project');
      expect(command.requiresEnvironment).toBe(false);
      expect(command.requiresServices).toBe(false);
      expect(command.handler).toBeDefined();
      expect(command.examples).toContain('semiont init');
    });
    
    it('should cache loaded commands', async () => {
      const command1 = await loadCommand('init');
      const command2 = await loadCommand('init');
      
      expect(command1).toBe(command2); // Same reference
    });
    
    it('should throw for non-existent commands', async () => {
      await expect(loadCommand('non-existent-command'))
        .rejects.toThrow("Command 'non-existent-command' not found");
    });
  });
});