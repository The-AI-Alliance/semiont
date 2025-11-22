import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning, printError } from '../../../core/io/cli-logger.js';

/**
 * Provision handler for frontend services on POSIX systems
 * 
 * Sets up the frontend runtime directory structure, installs dependencies,
 * configures environment variables, and prepares the build.
 */
const provisionFrontendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;
  
  // Get semiont repo path from options or environment
  const semiontRepo = options.semiontRepo || process.env.SEMIONT_REPO;
  if (!semiontRepo) {
    return {
      success: false,
      error: 'Semiont repository path is required. Use --semiont-repo or set SEMIONT_REPO environment variable',
      metadata: { serviceType: 'frontend' }
    };
  }
  
  // Verify semiont repo exists and has frontend
  const frontendSourceDir = path.join(semiontRepo, 'apps', 'frontend');
  if (!fs.existsSync(frontendSourceDir)) {
    return {
      success: false,
      error: `Frontend source not found at ${frontendSourceDir}`,
      metadata: { serviceType: 'frontend', semiontRepo }
    };
  }
  
  if (!service.quiet) {
    printInfo(`Provisioning frontend service ${service.name}...`);
    printInfo(`Using semiont repo: ${semiontRepo}`);
  }
  
  // Create frontend runtime directory structure
  const frontendDir = path.join(service.projectRoot, 'frontend');
  const logsDir = path.join(frontendDir, 'logs');
  const tmpDir = path.join(frontendDir, 'tmp');
  // Write .env.local directly to the frontend source directory where it's needed
  const envFile = path.join(frontendSourceDir, '.env.local');
  
  // Create directories
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  
  if (!service.quiet) {
    printInfo(`Created frontend directory: ${frontendDir}`);
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
  
  // Always create/overwrite .env.local with correct configuration
  const envUpdates: Record<string, string> = {
    'NODE_ENV': 'development',
    'PORT': (service.config.port || 3000).toString(),
    'NEXT_PUBLIC_API_URL': `http://localhost:${service.config.backendPort || 4000}`,
    'NEXT_PUBLIC_SITE_NAME': service.config.siteName || 'Semiont Development',
    'NEXT_PUBLIC_FRONTEND_URL': `http://localhost:${service.config.port || 3000}`,
    'NEXTAUTH_URL': `http://localhost:${service.config.port || 3000}`,
    'NEXTAUTH_SECRET': nextAuthSecret,
    'ENABLE_LOCAL_AUTH': 'true',  // Enable local development authentication
    'LOG_DIR': logsDir,
    'TMP_DIR': tmpDir
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
    // Create a basic .env.local
    const basicEnv = `# Frontend Environment Configuration
NODE_ENV=development
PORT=${service.config.port || 3000}
NEXT_PUBLIC_API_URL=http://localhost:${service.config.backendPort || 4000}
NEXT_PUBLIC_SITE_NAME=${service.config.siteName || 'Semiont Development'}
NEXT_PUBLIC_FRONTEND_URL=http://localhost:${service.config.port || 3000}
NEXTAUTH_URL=http://localhost:${service.config.port || 3000}
NEXTAUTH_SECRET=${nextAuthSecret}
ENABLE_LOCAL_AUTH=true
LOG_DIR=${logsDir}
TMP_DIR=${tmpDir}
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
    const monorepoRoot = path.resolve(semiontRepo);
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
        // Install in frontend directory
        execSync('npm install', {
          cwd: frontendSourceDir,
          stdio: service.verbose ? 'inherit' : 'pipe'
        });
      }
    } else {
      // Fallback to frontend directory
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
      metadata: { serviceType: 'frontend', frontendDir }
    };
  }
  
  // Build frontend if in production mode
  if (service.environment === 'prod' || options.build) {
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
  
  // Create README in frontend directory
  const readmePath = path.join(frontendDir, 'README.md');
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
    frontendDir,
    envFile,
    logsDir,
    tmpDir,
    semiontRepo,
    frontendSourceDir,
    configured: true
  };
  
  if (!service.quiet) {
    printSuccess(`✅ Frontend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Frontend details:');
    printInfo(`  Runtime directory: ${frontendDir}`);
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
        path: frontendDir,
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