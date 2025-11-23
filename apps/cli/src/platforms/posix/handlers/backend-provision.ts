import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning, printError } from '../../../core/io/cli-logger.js';
import { getBackendPaths } from './backend-paths.js';
import { getNodeEnvForEnvironment } from '@semiont/core';

/**
 * Provision handler for backend services on POSIX systems
 *
 * Sets up the backend runtime directory structure, installs dependencies,
 * configures environment variables, and prepares the database.
 */
const provisionBackendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;

  // Get backend paths
  const paths = getBackendPaths(context);
  if (!paths) {
    return {
      success: false,
      error: 'Semiont repository path is required. Use --semiont-repo or set SEMIONT_REPO environment variable',
      metadata: { serviceType: 'backend' }
    };
  }

  const { sourceDir: backendSourceDir, envFile, logsDir, tmpDir } = paths;

  // Verify backend source exists
  if (!fs.existsSync(backendSourceDir)) {
    return {
      success: false,
      error: `Backend source not found at ${backendSourceDir}`,
      metadata: { serviceType: 'backend' }
    };
  }

  if (!service.quiet) {
    printInfo(`Provisioning backend service ${service.name}...`);
    const semiontRepo = options.semiontRepo || process.env.SEMIONT_REPO;
    printInfo(`Using semiont repo: ${semiontRepo}`);
  }

  // Create directories
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  if (!service.quiet) {
    printInfo(`Created runtime directories in: ${backendSourceDir}`);
  }

  // Get environment configuration from service
  const envConfig = service.environmentConfig;
  const dbConfig = envConfig.services?.database;

  if (!dbConfig?.environment) {
    throw new Error('Database configuration not found in environment file');
  }

  const dbUser = dbConfig.environment.POSTGRES_USER;
  if (!dbUser) {
    throw new Error('POSTGRES_USER not configured');
  }

  const dbPassword = dbConfig.environment.POSTGRES_PASSWORD;
  if (!dbPassword) {
    throw new Error('POSTGRES_PASSWORD not configured');
  }

  const dbName = dbConfig.environment.POSTGRES_DB;
  if (!dbName) {
    throw new Error('POSTGRES_DB not configured');
  }

  const dbPort = dbConfig.port;
  if (!dbPort) {
    throw new Error('Database port not configured');
  }

  const dbHost = 'localhost';
  const databaseUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

  if (!service.quiet) {
    printInfo(`Using database configuration from ${service.environment}.json:`);
    printInfo(`  Database: ${dbName} on ${dbHost}:${dbPort}`);
    printInfo(`  User: ${dbUser}`);
  }
  
  // Check if .env already exists and backup if it does
  if (fs.existsSync(envFile)) {
    const backupPath = `${envFile}.backup.${Date.now()}`;
    fs.copyFileSync(envFile, backupPath);
    if (!service.quiet) {
      printWarning(`.env already exists, backing up to: ${path.basename(backupPath)}`);
      printInfo('Creating new .env with updated configuration...');
    }
  }
  
  // Get URLs from environment config
  const frontendService = service.environmentConfig.services?.frontend;
  if (!frontendService?.url) {
    throw new Error('Frontend URL not configured in environment');
  }
  const frontendUrl = frontendService.url;

  const backendUrl = service.config.publicURL;
  if (!backendUrl) {
    throw new Error('Backend publicURL not configured');
  }

  const port = service.config.port;
  if (!port) {
    throw new Error('Backend port not configured');
  }

  const siteDomain = service.environmentConfig.site.domain;
  if (!siteDomain) {
    throw new Error('Site domain not configured');
  }

  // Read OAuth allowed domains from site config
  const oauthAllowedDomains = service.environmentConfig.site.oauthAllowedDomains;
  if (!oauthAllowedDomains || oauthAllowedDomains.length === 0) {
    throw new Error('OAuth allowed domains not configured in site config');
  }

  const allowedDomains = oauthAllowedDomains.join(',');

  // Get NODE_ENV from environment config
  const nodeEnv = getNodeEnvForEnvironment(service.environmentConfig);

  // Get enableLocalAuth from app config, default to true for development
  const enableLocalAuth = service.environmentConfig.app?.security?.enableLocalAuth ??
    (nodeEnv === 'development');

  // Get JWT secret from config or generate a secure one
  const jwtSecret = service.environmentConfig.app?.security?.jwtSecret ??
    crypto.randomBytes(32).toString('base64');

  const envUpdates: Record<string, string> = {
    'NODE_ENV': nodeEnv,
    'PORT': port.toString(),
    'DATABASE_URL': databaseUrl,
    'LOG_DIR': logsDir,
    'TMP_DIR': tmpDir,
    'JWT_SECRET': jwtSecret,
    'FRONTEND_URL': frontendUrl,
    'BACKEND_URL': backendUrl,
    'ENABLE_LOCAL_AUTH': enableLocalAuth.toString(),
    'SITE_DOMAIN': siteDomain,
    'OAUTH_ALLOWED_DOMAINS': allowedDomains
  };
  
  // Create .env from the single source of truth
  let envContent = '# Backend Environment Configuration\n';
  for (const [key, value] of Object.entries(envUpdates)) {
    envContent += `${key}=${value}\n`;
  }
  
  fs.writeFileSync(envFile, envContent);
  
  if (!service.quiet) {
    printSuccess('Created .env with configuration from environment file');
  }
  
  // Install npm dependencies
  if (!service.quiet) {
    printInfo('Installing npm dependencies...');
  }
  
  try {
    const semiontRepo = context.options?.semiontRepo || process.env.SEMIONT_REPO;
    if (!semiontRepo) {
      throw new Error('SEMIONT_REPO not configured');
    }

    const monorepoRoot = path.resolve(semiontRepo);
    const rootPackageJsonPath = path.join(monorepoRoot, 'package.json');

    if (fs.existsSync(rootPackageJsonPath)) {
      const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8'));
      if (rootPackageJson.workspaces) {
        execSync('npm install', {
          cwd: monorepoRoot,
          stdio: service.verbose ? 'inherit' : 'pipe'
        });
      } else {
        execSync('npm install', {
          cwd: backendSourceDir,
          stdio: service.verbose ? 'inherit' : 'pipe'
        });
      }
    } else {
      execSync('npm install', {
        cwd: backendSourceDir,
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
      metadata: { serviceType: 'backend', backendSourceDir }
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
      
      const adminEmail = options.adminEmail || process.env.ADMIN_EMAIL;
      if (!adminEmail) {
        throw new Error('Admin email not provided. Use --admin-email flag or set ADMIN_EMAIL environment variable');
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
          
          // Write seed script to backend source temp directory
          const seedScriptPath = path.join(backendSourceDir, 'seed-admin-temp.js');
          fs.writeFileSync(seedScriptPath, seedScript);
          
          // Execute seed script using npx to ensure node_modules are available
          if (!service.quiet) {
            printInfo(`Seeding admin user ${adminEmail}...`);
          }
          
          try {
            const output = execSync(`npx tsx ${seedScriptPath}`, {
              cwd: backendSourceDir,
              env: { ...process.env, ...envVars },
              stdio: service.verbose ? 'inherit' : 'pipe'
            });
            
            if (!service.quiet && !service.verbose && output) {
              printInfo(output.toString().trim());
            }
          } catch (seedError) {
            printError(`Failed to seed admin user: ${seedError}`);
            printInfo('You can manually create an admin user later by running:');
            printInfo(`  cd ${backendSourceDir}`);
            printInfo(`  npx tsx -e "const {PrismaClient} = require('@prisma/client'); const p = new PrismaClient(); p.user.create({data:{email:'${adminEmail}',name:'Admin',provider:'seeded',providerId:'admin-'+Date.now(),domain:'${domain}',isAdmin:true,isActive:true}}).then(()=>p.$disconnect())"`)
            throw seedError;
          }
          
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
  
  // Create README in backend source directory
  const readmePath = path.join(backendSourceDir, 'RUNTIME.md');
  if (!fs.existsSync(readmePath)) {
    const readmeContent = `# Backend Runtime Directory

This directory contains runtime files for the backend service.

## Structure

- \`.env\` - Environment configuration (git-ignored)
- \`logs/\` - Application logs
- \`tmp/\` - Temporary files
- \`.pid\` - Process ID when running

## Configuration

Edit \`.env\` to configure:
- Database connection (DATABASE_URL)
- Backend URL (BACKEND_URL)
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
    backendSourceDir,
    envFile,
    logsDir,
    tmpDir,
    configured: true
  };
  
  if (!service.quiet) {
    printSuccess(`✅ Backend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Backend details:');
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
        path: backendSourceDir,
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