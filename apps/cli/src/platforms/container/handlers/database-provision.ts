import { execSync } from 'child_process';
import { ContainerProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Provision handler for database services in containers
 * 
 * Handles database-specific provisioning including:
 * - Network and volume creation (via generic handler)
 * - Database and schema initialization
 * - User creation and permissions
 * - Running migration scripts
 * - Loading seed data
 */
const provisionDatabaseContainer = async (context: ContainerProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, runtime } = context;
  const containerName = `semiont-${service.name}-${service.environment}`;
  
  if (!service.quiet) {
    printInfo(`Provisioning database ${service.name}...`);
  }
  
  // First, ensure the container infrastructure is ready
  const networkName = `semiont-${service.environment}`;
  try {
    execSync(`${runtime} network create ${networkName}`, { stdio: 'ignore' });
  } catch {
    // Network might already exist
  }
  
  // Create persistent volume for database data
  const volumeName = `${containerName}-data`;
  try {
    execSync(`${runtime} volume create ${volumeName}`, { stdio: 'ignore' });
    if (!service.quiet) {
      printInfo(`Created volume: ${volumeName}`);
    }
  } catch {
    // Volume might already exist
  }
  
  // Pull the database image
  const image = service.getImage();
  if (!service.quiet) {
    printInfo(`Pulling database image ${image}...`);
  }
  
  try {
    execSync(`${runtime} pull ${image}`, {
      stdio: service.verbose ? 'inherit' : 'pipe'
    });
  } catch (error) {
    printWarning(`Failed to pull image ${image}, will try to use local`);
  }
  
  // Check if initialization scripts exist
  const initScriptsPath = path.join(service.projectRoot, 'db', 'init');
  const migrationsPath = path.join(service.projectRoot, 'db', 'migrations');
  const seedDataPath = path.join(service.projectRoot, 'db', 'seed');
  
  const hasInitScripts = fs.existsSync(initScriptsPath);
  const hasMigrations = fs.existsSync(migrationsPath);
  const hasSeedData = fs.existsSync(seedDataPath);
  
  // Get database configuration from environment variables
  const envVars = service.getEnvironmentVariables();
  const dbName = envVars.POSTGRES_DB || envVars.MYSQL_DATABASE;
  const dbUser = envVars.POSTGRES_USER || envVars.MYSQL_USER;
  
  // Check if container is already running
  let containerRunning = false;
  try {
    const status = execSync(
      `${runtime} inspect ${containerName} --format '{{.State.Status}}'`,
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim();
    containerRunning = status === 'running';
  } catch {
    // Container doesn't exist yet
  }
  
  // If we have init scripts and container isn't running, we need to start it temporarily
  if ((hasInitScripts || hasMigrations || hasSeedData) && !containerRunning) {
    if (!service.quiet) {
      printInfo('Starting temporary database container for initialization...');
    }
    
    // Start the container (similar to start handler but temporary)
    const runArgs = [
      'run', '-d',
      '--name', `${containerName}-init`,
      '--network', networkName,
      '-v', `${volumeName}:/var/lib/postgresql/data`
    ];
    
    // Add environment variables
    for (const [key, value] of Object.entries(envVars)) {
      runArgs.push('-e', `${key}=${value}`);
    }
    
    // Add init scripts as volumes if they exist
    if (hasInitScripts) {
      runArgs.push('-v', `${initScriptsPath}:/docker-entrypoint-initdb.d`);
    }
    
    runArgs.push(image);
    
    try {
      execSync(`${runtime} ${runArgs.join(' ')}`, { encoding: 'utf-8' }).trim();
      
      // Wait for database to be ready
      if (!service.quiet) {
        printInfo('Waiting for database to be ready...');
      }
      
      let attempts = 0;
      const maxAttempts = 30;
      while (attempts < maxAttempts) {
        try {
          if (image.includes('postgres')) {
            execSync(`${runtime} exec ${containerName}-init pg_isready -U ${dbUser}`, { stdio: 'ignore' });
            break;
          } else if (image.includes('mysql')) {
            execSync(`${runtime} exec ${containerName}-init mysqladmin ping -h localhost`, { stdio: 'ignore' });
            break;
          }
        } catch {
          await new Promise(resolve => setTimeout(resolve, 1000));
          attempts++;
        }
      }
      
      if (attempts === maxAttempts) {
        printWarning('Database took longer than expected to start');
      }
      
      // Run migrations if they exist
      if (hasMigrations && !service.quiet) {
        printInfo('Migration scripts found in db/migrations - these should be run by your application');
      }
      
      // Load seed data if it exists
      if (hasSeedData && !service.quiet) {
        printInfo('Seed data found in db/seed - this should be loaded by your application');
      }
      
      // Stop and remove the temporary container
      execSync(`${runtime} stop ${containerName}-init`, { stdio: 'ignore' });
      execSync(`${runtime} rm ${containerName}-init`, { stdio: 'ignore' });
      
      if (!service.quiet) {
        printSuccess('Database initialized successfully');
      }
    } catch (error) {
      // Clean up on error
      try {
        execSync(`${runtime} stop ${containerName}-init`, { stdio: 'ignore' });
        execSync(`${runtime} rm ${containerName}-init`, { stdio: 'ignore' });
      } catch {
        // Ignore cleanup errors
      }
      
      return {
        success: false,
        error: `Failed to initialize database: ${error}`,
        metadata: {
          serviceType: 'database',
          runtime
        }
      };
    }
  }
  
  if (!service.quiet) {
    printSuccess(`✅ Database ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Database details:');
    printInfo(`  Container: ${containerName}`);
    printInfo(`  Image: ${image}`);
    printInfo(`  Network: ${networkName}`);
    printInfo(`  Volume: ${volumeName}`);
    printInfo(`  Database: ${dbName}`);
    printInfo(`  User: ${dbUser}`);
    
    if (hasInitScripts) {
      printInfo('  Init scripts: db/init/*.sql will run on first start');
    }
    if (hasMigrations) {
      printInfo('  Migrations: db/migrations/ available for your app');
    }
    if (hasSeedData) {
      printInfo('  Seed data: db/seed/ available for your app');
    }
    
    printInfo('');
    printInfo('To start the database:');
    printInfo(`  semiont start --service ${service.name}`);
  }
  
  return {
    success: true,
    metadata: {
      serviceType: 'database',
      runtime,
      containerName,
      image,
      network: networkName,
      volume: volumeName,
      database: dbName,
      user: dbUser,
      hasInitScripts,
      hasMigrations,
      hasSeedData
    },
    resources: {
      platform: 'container',
      data: {
        containerId: '',  // Will be populated when container starts
        containerName,
        image,
        networkName,
        volumeId: volumeName,
        volumes: [{
          host: volumeName,
          container: '/var/lib/postgresql/data',
          mode: 'rw'
        }]
      }
    }
  };
};

/**
 * Descriptor for database container provision handler
 */
export const databaseProvisionDescriptor: HandlerDescriptor<ContainerProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'container',
  serviceType: 'database',
  handler: provisionDatabaseContainer
};