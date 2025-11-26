import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning, printError } from '../../../core/io/cli-logger.js';
import { getFrontendPaths } from './frontend-paths.js';
import type { FrontendServiceConfig } from '@semiont/core';

/**
 * Provision handler for frontend services on POSIX systems
 * 
 * Sets up the frontend runtime directory structure, installs dependencies,
 * configures environment variables, and prepares the build.
 */
const provisionFrontendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;

  // Get frontend paths
  const paths = getFrontendPaths(context);
  const { sourceDir: frontendSourceDir, logsDir, tmpDir, envLocalFile: envFile } = paths;

  // Verify frontend source directory exists
  if (!fs.existsSync(frontendSourceDir)) {
    return {
      success: false,
      error: `Frontend source not found at ${frontendSourceDir}`,
      metadata: { serviceType: 'frontend' }
    };
  }

  if (!service.quiet) {
    printInfo(`Provisioning frontend service ${service.name}...`);
    printInfo(`Using source directory: ${frontendSourceDir}`);
  }

  // Create directories
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  
  if (!service.quiet) {
    printInfo(`Created runtime directories in: ${frontendSourceDir}`);
  }
  
  // Setup .env.local file
  const envExamplePath = path.join(frontendSourceDir, '.env.example');
  
  // Check if .env.local already exists and backup if it does
  if (fs.existsSync(envFile)) {
    const backupPath = `${envFile}.backup.${Date.now()}`;
    fs.copyFileSync(envFile, backupPath);
    if (!service.quiet) {
      printWarning(`.env.local already exists, backing up to: ${path.basename(backupPath)}`);
      printInfo('Creating new .env.local with updated configuration...');
    }
  }
  
  // Always generate a new secure NEXTAUTH_SECRET
  const nextAuthSecret = crypto.randomBytes(32).toString('base64');

  // Get values from service config (already validated by schema)
  // Type narrowing: we know this is a frontend service
  const config = service.config as FrontendServiceConfig;
  const frontendUrl = config.url;
  const port = config.port;
  const semiontEnv = service.environment;
  const siteName = config.siteName;

  // Get backend publicURL from environment config
  const backendService = service.environmentConfig.services['backend'];
  if (!backendService) {
    return {
      success: false,
      error: 'Backend service not found in environment configuration',
      metadata: { serviceType: 'frontend' }
    };
  }
  const backendUrl = backendService.publicURL;
  if (!backendUrl) {
    return {
      success: false,
      error: 'Backend publicURL not configured',
      metadata: { serviceType: 'frontend' }
    };
  }
  if (!siteName) {
    return {
      success: false,
      error: 'Frontend siteName not configured',
      metadata: { serviceType: 'frontend' }
    };
  }

  // Get OAuth allowed domains from environment config
  const oauthAllowedDomains = service.environmentConfig.site?.oauthAllowedDomains || [];

  // Get local auth setting from environment config
  const enableLocalAuth = service.environmentConfig.app?.security?.enableLocalAuth || false;

  // Always create/overwrite .env.local with minimal configuration
  // Most config now comes from the semiont config system
  const envUpdates: Record<string, string> = {
    'NODE_ENV': 'development',
    'PORT': port.toString(),
    'NEXTAUTH_URL': frontendUrl,
    'NEXTAUTH_SECRET': nextAuthSecret,
    'SEMIONT_ENV': semiontEnv,
    'NEXT_PUBLIC_API_URL': backendUrl,
    'NEXT_PUBLIC_SITE_NAME': siteName,
    'NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS': oauthAllowedDomains.join(','),
    'NEXT_PUBLIC_ENABLE_LOCAL_AUTH': enableLocalAuth.toString()
  };
  
  if (fs.existsSync(envExamplePath)) {
    // Use .env.example as template
    let envContent = fs.readFileSync(envExamplePath, 'utf-8');
    
    // Parse and update env file
    const lines = envContent.split('\n');
    const updatedLines = lines.map(line => {
      if (line.startsWith('#') || !line.includes('=')) {
        return line;
      }
      const [key] = line.split('=');
      if (envUpdates[key]) {
        return `${key}=${envUpdates[key]}`;
      }
      return line;
    });
    
    // Add any missing keys
    for (const [key, value] of Object.entries(envUpdates)) {
      if (!updatedLines.some(line => line.startsWith(`${key}=`))) {
        updatedLines.push(`${key}=${value}`);
      }
    }
    
    fs.writeFileSync(envFile, updatedLines.join('\n'));
    
    if (!service.quiet) {
      printSuccess('Created .env.local with updated configuration');
      printSuccess(`Generated secure NEXTAUTH_SECRET (32 bytes)`);
    }
  } else {
    // Create .env.local from scratch
    const basicEnv = `# Frontend Environment Configuration
NODE_ENV=development
PORT=${port}
NEXTAUTH_URL=${frontendUrl}
NEXTAUTH_SECRET=${nextAuthSecret}

# Semiont Configuration System
SEMIONT_ENV=${semiontEnv}

# Backend API URL (from backend.publicURL in environment config)
NEXT_PUBLIC_API_URL=${backendUrl}

# Site name (from frontend.siteName in environment config)
NEXT_PUBLIC_SITE_NAME=${siteName}

# OAuth allowed domains (comma-separated)
NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=${oauthAllowedDomains.join(',')}

# Enable local development authentication
NEXT_PUBLIC_ENABLE_LOCAL_AUTH=${enableLocalAuth.toString()}
`;
    fs.writeFileSync(envFile, basicEnv);

    if (!service.quiet) {
      printSuccess('Created .env.local with updated configuration');
      printSuccess(`Generated secure NEXTAUTH_SECRET (32 bytes)`);
    }
  }
  
  // Install npm dependencies
  if (!service.quiet) {
    printInfo('Installing npm dependencies...');
  }
  
  try {
    // For monorepo, install from the root
    const monorepoRoot = path.dirname(path.dirname(frontendSourceDir));
    const rootPackageJsonPath = path.join(monorepoRoot, 'package.json');
    
    if (fs.existsSync(rootPackageJsonPath)) {
      // Check if this is a monorepo with workspaces
      const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8'));
      if (rootPackageJson.workspaces) {
        // Install from monorepo root
        execSync('npm install', {
          cwd: monorepoRoot,
          stdio: service.verbose ? 'inherit' : 'pipe'
        });
      } else {
        execSync('npm install', {
          cwd: frontendSourceDir,
          stdio: service.verbose ? 'inherit' : 'pipe'
        });
      }
    } else {
      execSync('npm install', {
        cwd: frontendSourceDir,
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
    }
    
    if (!service.quiet) {
      printSuccess('Dependencies installed successfully');
    }
  } catch (error) {
    printError(`Failed to install dependencies: ${error}`);
    return {
      success: false,
      error: `Failed to install dependencies: ${error}`,
      metadata: { serviceType: 'frontend', frontendSourceDir }
    };
  }
  
  // Build frontend if in production mode
  if (service.environment === 'prod') {
    if (!service.quiet) {
      printInfo('Building frontend for production...');
    }
    
    try {
      // Load env vars for build
      const envVars: Record<string, string> = {};
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf-8');
        envContent.split('\n').forEach(line => {
          if (!line.startsWith('#') && line.includes('=')) {
            const [key, ...valueParts] = line.split('=');
            envVars[key.trim()] = valueParts.join('=').trim();
          }
        });
      }
      
      execSync('npm run build', {
        cwd: frontendSourceDir,
        env: { ...process.env, ...envVars },
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      
      if (!service.quiet) {
        printSuccess('Frontend built successfully');
      }
    } catch (error) {
      printWarning(`Failed to build frontend: ${error}`);
      printInfo('You may need to build manually: npm run build');
    }
  }
  
  // Create README in frontend source directory
  const readmePath = path.join(frontendSourceDir, 'RUNTIME.md');
  if (!fs.existsSync(readmePath)) {
    const readmeContent = `# Frontend Runtime Directory

This directory contains runtime files for the frontend service.

## Structure

- \`.env.local\` - Environment configuration (git-ignored)
- \`logs/\` - Application logs
- \`tmp/\` - Temporary files
- \`.pid\` - Process ID when running

## Configuration

Edit \`.env.local\` to configure:
- API URL (NEXT_PUBLIC_API_URL)
- Port (PORT)
- Other environment-specific settings

## Source Code

The frontend source code is located at:
${frontendSourceDir}

## Commands

- Start: \`semiont start --service frontend --environment ${service.environment}\`
- Check: \`semiont check --service frontend --environment ${service.environment}\`
- Stop: \`semiont stop --service frontend --environment ${service.environment}\`
- Logs: \`tail -f logs/app.log\`
`;
    fs.writeFileSync(readmePath, readmeContent);
  }
  
  const metadata = {
    serviceType: 'frontend',
    frontendSourceDir,
    envFile,
    logsDir,
    tmpDir,
    configured: true
  };
  
  if (!service.quiet) {
    printSuccess(`✅ Frontend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Frontend details:');
    printInfo(`  Source directory: ${frontendSourceDir}`);
    printInfo(`  Environment file: ${envFile}`);
    printInfo(`  Logs directory: ${logsDir}`);
    printInfo('');
    printInfo('Next steps:');
    printInfo(`  1. Review and update ${envFile}`);
    printInfo(`  2. Ensure backend is running`);
    printInfo(`  3. Start frontend: semiont start --service frontend --environment ${service.environment}`);
  }
  
  return {
    success: true,
    metadata,
    resources: {
      platform: 'posix',
      data: {
        path: frontendSourceDir,
        workingDirectory: frontendSourceDir
      }
    }
  };
};

/**
 * Descriptor for frontend POSIX provision handler
 */
export const frontendProvisionDescriptor: HandlerDescriptor<PosixProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'posix',
  serviceType: 'frontend',
  handler: provisionFrontendService
};