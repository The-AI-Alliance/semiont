import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning, printError } from '../../../core/io/cli-logger.js';
import { loadEnvironmentConfig } from '../../../core/environment-loader.js';

/**
 * Provision handler for backend services on POSIX systems
 * 
 * Sets up the backend runtime directory structure, installs dependencies,
 * configures environment variables, and prepares the database.
 */
const provisionBackendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;
  
  // Get semiont repo path from options or environment
  const semiontRepo = options.semiontRepo || process.env.SEMIONT_REPO;
  if (!semiontRepo) {
    return {
      success: false,
      error: 'Semiont repository path is required. Use --semiont-repo or set SEMIONT_REPO environment variable',
      metadata: { serviceType: 'backend' }
    };
  }
  
  // Verify semiont repo exists and has backend
  const backendSourceDir = path.join(semiontRepo, 'apps', 'backend');
  if (!fs.existsSync(backendSourceDir)) {
    return {
      success: false,
      error: `Backend source not found at ${backendSourceDir}`,
      metadata: { serviceType: 'backend', semiontRepo }
    };
  }
  
  if (!service.quiet) {
    printInfo(`Provisioning backend service ${service.name}...`);
    printInfo(`Using semiont repo: ${semiontRepo}`);
  }
  
  // Create backend runtime directory structure
  const backendDir = path.join(service.projectRoot, 'backend');
  const logsDir = path.join(backendDir, 'logs');
  const tmpDir = path.join(backendDir, 'tmp');
  const envFile = path.join(backendDir, '.env.local');
  
  // Create directories
  fs.mkdirSync(backendDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  
  if (!service.quiet) {
    printInfo(`Created backend directory: ${backendDir}`);
  }
  
  // Load environment configuration to get database credentials
  const envConfig = loadEnvironmentConfig(service.environment);
  const dbConfig = envConfig.services?.database;
  
  // Build database URL from environment config
  let databaseUrl = 'postgresql://semiont:localpass@localhost:5432/semiont'; // fallback
  if (dbConfig?.environment) {
    const dbUser = dbConfig.environment.POSTGRES_USER || 'postgres';
    const dbPassword = dbConfig.environment.POSTGRES_PASSWORD || 'localpass';
    const dbName = dbConfig.environment.POSTGRES_DB || 'semiont';
    const dbPort = dbConfig.port || 5432;
    const dbHost = 'localhost'; // For local development, always use localhost
    databaseUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;
    
    if (!service.quiet) {
      printInfo(`Using database configuration from ${service.environment}.json:`);
      printInfo(`  Database: ${dbName} on ${dbHost}:${dbPort}`);
      printInfo(`  User: ${dbUser}`);
    }
  } else {
    if (!service.quiet) {
      printWarning('No database configuration found in environment file, using defaults');
    }
  }
  
  // Setup .env.local file
  const envExamplePath = path.join(backendSourceDir, '.env.example');
  
  // Check if .env.local already exists and backup if it does
  if (fs.existsSync(envFile)) {
    const backupPath = `${envFile}.backup.${Date.now()}`;
    fs.copyFileSync(envFile, backupPath);
    if (!service.quiet) {
      printWarning(`.env.local already exists, backing up to: ${path.basename(backupPath)}`);
      printInfo('Creating new .env.local with updated configuration...');
    }
  }
  
  // Always create/overwrite .env.local with correct configuration
  const envUpdates: Record<string, string> = {
    'NODE_ENV': 'development',
    'PORT': (service.config.port || 4000).toString(),
    'DATABASE_URL': databaseUrl,
    'LOG_DIR': logsDir,
    'TMP_DIR': tmpDir,
    'JWT_SECRET': 'local-development-secret-change-in-production',
    'FRONTEND_URL': 'http://localhost:3000',
    'BACKEND_URL': `http://localhost:${service.config.port || 4000}`,
    'ENABLE_LOCAL_AUTH': 'true'  // Enable local development authentication
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
      printSuccess('Created .env.local with configuration from environment file');
    }
  } else {
    // Create a basic .env.local
    const basicEnv = `# Backend Environment Configuration
NODE_ENV=development
PORT=${service.config.port || 4000}
DATABASE_URL=${databaseUrl}
LOG_DIR=${logsDir}
TMP_DIR=${tmpDir}
JWT_SECRET=local-development-secret-change-in-production
FRONTEND_URL=http://localhost:3000
BACKEND_URL=http://localhost:${service.config.port || 4000}
ENABLE_LOCAL_AUTH=true
`;
    fs.writeFileSync(envFile, basicEnv);
    
    if (!service.quiet) {
      printSuccess('Created .env.local with configuration from environment file');
    }
  }
  
  // Install npm dependencies
  if (!service.quiet) {
    printInfo('Installing npm dependencies...');
  }
  
  try {
    execSync('npm install', {
      cwd: backendSourceDir,
      stdio: service.verbose ? 'inherit' : 'pipe'
    });
    
    if (!service.quiet) {
      printSuccess('Dependencies installed successfully');
    }
  } catch (error) {
    printError(`Failed to install dependencies: ${error}`);
    return {
      success: false,
      error: `Failed to install dependencies: ${error}`,
      metadata: { serviceType: 'backend', backendDir }
    };
  }
  
  // Generate Prisma client if schema exists
  const prismaSchemaPath = path.join(backendSourceDir, 'prisma', 'schema.prisma');
  if (fs.existsSync(prismaSchemaPath)) {
    if (!service.quiet) {
      printInfo('Generating Prisma client...');
    }
    
    try {
      execSync('npx prisma generate', {
        cwd: backendSourceDir,
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      
      if (!service.quiet) {
        printSuccess('Prisma client generated');
      }
    } catch (error) {
      printWarning(`Failed to generate Prisma client: ${error}`);
    }
  }
  
  // Check if we should run migrations
  if (options.migrate !== false && fs.existsSync(prismaSchemaPath)) {
    if (!service.quiet) {
      printInfo('Running database migrations...');
    }
    
    try {
      // Load env vars for migration
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
      
      execSync('npx prisma migrate deploy', {
        cwd: backendSourceDir,
        env: { ...process.env, ...envVars },
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      
      if (!service.quiet) {
        printSuccess('Database migrations completed');
      }
    } catch (error) {
      printWarning(`Failed to run migrations: ${error}`);
      printInfo('You may need to run migrations manually: npx prisma migrate deploy');
    }
  }
  
  // Seed initial admin user if requested
  if (options.seedAdmin && fs.existsSync(prismaSchemaPath)) {
    if (!service.quiet) {
      printInfo('Creating initial admin user...');
    }
    
    try {
      // Load env vars for database connection
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
      
      // Get admin email from options or environment
      const adminEmail = options.adminEmail || process.env.ADMIN_EMAIL;
      if (!adminEmail) {
        printWarning('No admin email provided. Skipping admin user creation.');
        printInfo('Use --admin-email flag or set ADMIN_EMAIL environment variable');
      } else {
        // Extract domain from email
        const emailParts = adminEmail.split('@');
        if (emailParts.length !== 2) {
          printWarning(`Invalid admin email format: ${adminEmail}`);
        } else {
          const domain = emailParts[1];
          
          // Create a Node.js script to seed the admin user
          const seedScript = `
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const existingUser = await prisma.user.findUnique({
    where: { email: '${adminEmail}' }
  });
  
  if (existingUser) {
    if (!existingUser.isAdmin) {
      await prisma.user.update({
        where: { email: '${adminEmail}' },
        data: { isAdmin: true }
      });
      console.log('Updated existing user to admin: ${adminEmail}');
    } else {
      console.log('Admin user already exists: ${adminEmail}');
    }
  } else {
    await prisma.user.create({
      data: {
        email: '${adminEmail}',
        name: 'Admin User',
        provider: 'seeded',
        providerId: 'admin-seed-' + Date.now(),
        domain: '${domain}',
        isAdmin: true,
        isActive: true
      }
    });
    console.log('Created admin user: ${adminEmail}');
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
`;
          
          // Write seed script to temp file
          const seedScriptPath = path.join(tmpDir, 'seed-admin.js');
          fs.writeFileSync(seedScriptPath, seedScript);
          
          // Execute seed script
          execSync(`node ${seedScriptPath}`, {
            cwd: backendSourceDir,
            env: { ...process.env, ...envVars },
            stdio: service.verbose ? 'inherit' : 'pipe'
          });
          
          // Clean up temp script
          fs.unlinkSync(seedScriptPath);
          
          if (!service.quiet) {
            printSuccess(`Admin user seeded: ${adminEmail}`);
            printInfo('Note: This user will need to sign in with Google using this email');
          }
        }
      }
    } catch (error) {
      printWarning(`Failed to seed admin user: ${error}`);
      printInfo('You can manually grant admin access later');
    }
  }
  
  // Create README in backend directory
  const readmePath = path.join(backendDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    const readmeContent = `# Backend Runtime Directory

This directory contains runtime files for the backend service.

## Structure

- \`.env.local\` - Environment configuration (git-ignored)
- \`logs/\` - Application logs
- \`tmp/\` - Temporary files
- \`.pid\` - Process ID when running

## Configuration

Edit \`.env.local\` to configure:
- Database connection (DATABASE_URL)
- JWT secret (JWT_SECRET)
- Port (PORT)
- Other environment-specific settings

## Source Code

The backend source code is located at:
${backendSourceDir}

## Commands

- Start: \`semiont start --service backend --environment ${service.environment}\`
- Check: \`semiont check --service backend --environment ${service.environment}\`
- Stop: \`semiont stop --service backend --environment ${service.environment}\`
- Logs: \`tail -f logs/app.log\`
`;
    fs.writeFileSync(readmePath, readmeContent);
  }
  
  const metadata = {
    serviceType: 'backend',
    backendDir,
    envFile,
    logsDir,
    tmpDir,
    semiontRepo,
    backendSourceDir,
    configured: true
  };
  
  if (!service.quiet) {
    printSuccess(`✅ Backend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Backend details:');
    printInfo(`  Runtime directory: ${backendDir}`);
    printInfo(`  Source directory: ${backendSourceDir}`);
    printInfo(`  Environment file: ${envFile}`);
    printInfo(`  Logs directory: ${logsDir}`);
    printInfo('');
    printInfo('Next steps:');
    printInfo(`  1. Review and update ${envFile}`);
    printInfo(`  2. Ensure database is running`);
    printInfo(`  3. Start backend: semiont start --service backend --environment ${service.environment}`);
  }
  
  return {
    success: true,
    metadata,
    resources: {
      platform: 'posix',
      data: {
        path: backendDir,
        workingDirectory: backendSourceDir
      }
    }
  };
};

/**
 * Descriptor for backend POSIX provision handler
 */
export const backendProvisionDescriptor: HandlerDescriptor<PosixProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'posix',
  serviceType: 'backend',
  handler: provisionBackendService
};