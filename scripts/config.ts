#!/usr/bin/env -S npx tsx

/**
 * Configuration Management CLI
 * 
 * Helps users view, validate, and manage Semiont configuration
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { config, displayConfiguration, getEnvironment } from '../config';
import { ConfigurationError } from '../config/schemas/validation';
import { logger } from './lib/logger';

const CONFIG_DIR = path.join(process.cwd(), 'config');

const program = new Command();

program
  .name('semiont-config')
  .description('Semiont configuration management')
  .version('1.0.0');

// Show current configuration
program
  .command('show')
  .description('Display current configuration (sensitive data masked)')
  .action(() => {
    try {
      console.log('\n📋 Current Semiont Configuration:\n');
      displayConfiguration();
      console.log('\n✅ Configuration is valid\n');
    } catch (error) {
      if (error instanceof ConfigurationError) {
        logger.error('Configuration validation failed', { 
          error: error.message,
          field: error.field 
        });
      } else {
        logger.error('Failed to load configuration', { error });
      }
      process.exit(1);
    }
  });

// Validate configuration
program
  .command('validate')
  .description('Validate current configuration')
  .action(() => {
    try {
      // Config is validated on import, so if we get here it's valid
      console.log('\n✅ Configuration is valid!\n');
      
      // Show summary
      console.log('Configuration Summary:');
      console.log(`  Site Name: ${config.site.siteName}`);
      console.log(`  Domain: ${config.site.domain}`);
      console.log(`  AWS Region: ${config.aws.region}`);
      console.log(`  Environment: ${getEnvironment()}`);
      console.log(`  OAuth Providers: ${config.site.oauthProviders.filter(p => p.enabled).map(p => p.name).join(', ')}`);
      console.log();
    } catch (error) {
      if (error instanceof ConfigurationError) {
        console.error('\n❌ Configuration validation failed:\n');
        console.error(`  Error: ${error.message}`);
        if (error.field) {
          console.error(`  Field: ${error.field}`);
        }
        console.error('\n  Please check your configuration files in the config/ directory\n');
      } else {
        console.error('\n❌ Failed to load configuration:', error);
      }
      process.exit(1);
    }
  });

// Initialize configuration
program
  .command('init')
  .description('Initialize configuration from example')
  .action(() => {
    const siteConfigPath = path.join(CONFIG_DIR, 'base', 'site.config.ts');
    const examplePath = path.join(CONFIG_DIR, 'base', 'site.config.example.ts');
    
    if (fs.existsSync(siteConfigPath)) {
      console.log('\n⚠️  Configuration already exists at config/base/site.config.ts');
      console.log('   Delete or rename the existing file to reinitialize.\n');
      return;
    }
    
    if (!fs.existsSync(examplePath)) {
      console.error('\n❌ Example configuration not found at config/base/site.config.example.ts\n');
      process.exit(1);
    }
    
    try {
      fs.copyFileSync(examplePath, siteConfigPath);
      console.log('\n✅ Configuration initialized!');
      console.log('\n   Next steps:');
      console.log('   1. Edit config/base/site.config.ts with your values');
      console.log('   2. Run "npm run config:validate" to validate');
      console.log('   3. Deploy with "npm run deploy"\n');
    } catch (error) {
      console.error('\n❌ Failed to initialize configuration:', error);
      process.exit(1);
    }
  });

// Export configuration for CDK
program
  .command('export')
  .description('Export configuration as environment variables for CDK')
  .action(() => {
    try {
      // Export as shell environment variables
      console.log('# Semiont Configuration Export');
      console.log(`export SITE_NAME="${config.site.siteName}"`);
      console.log(`export DOMAIN="${config.site.domain}"`);
      console.log(`export ADMIN_EMAIL="${config.site.adminEmail}"`);
      console.log(`export OAUTH_ALLOWED_DOMAINS="${config.site.oauthAllowedDomains.join(',')}"`);
      console.log(`export AWS_REGION="${config.aws.region}"`);
      console.log(`export AWS_ACCOUNT_ID="${config.aws.accountId}"`);
      console.log(`export CERTIFICATE_ARN="${config.aws.certificateArn}"`);
      console.log(`export ROOT_DOMAIN="${config.aws.rootDomain}"`);
      console.log(`export HOSTED_ZONE_ID="${config.aws.hostedZoneId}"`);
      console.log(`export DATABASE_NAME="${config.aws.database.name}"`);
      console.log(`export SEMIONT_ENV="${getEnvironment()}"`);
    } catch (error) {
      logger.error('Failed to export configuration', { error });
      process.exit(1);
    }
  });

// Environment-specific info
program
  .command('env')
  .description('Show current environment and active overrides')
  .action(() => {
    console.log('\n🌍 Environment Information:\n');
    console.log(`  Current Environment: ${getEnvironment()}`);
    console.log(`  Configuration Loaded From:`);
    console.log(`    - Base: config/base/*.config.ts`);
    console.log(`    - Overrides: config/environments/${getEnvironment()}.ts`);
    console.log();
    console.log('  Active Feature Flags:');
    Object.entries(config.app.features).forEach(([key, value]) => {
      console.log(`    - ${key}: ${value}`);
    });
    console.log();
  });

program.parse(process.argv);