
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config/dist/index.js';

interface CleanOptions {
  docker?: boolean;
  node?: boolean;
  cdk?: boolean;
  nextjs?: boolean;
  all?: boolean;
  verbose?: boolean;
}

async function runCommand(command: string[], cwd: string, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`🧹 ${description}...`);
    console.log(`💻 Running: ${command.join(' ')}`);
    
    const process: ChildProcess = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: 'inherit',
      shell: true
    });

    process.on('close', (code: number | null) => {
      if (code === 0) {
        console.log(`✅ ${description} completed`);
      } else {
        console.log(`⚠️  ${description} completed with warnings (code ${code})`);
      }
      resolve(code === 0);
    });

    process.on('error', (error: Error) => {
      console.error(`❌ ${description} failed: ${error.message}`);
      resolve(false);
    });
  });
}

async function removeDirectory(dirPath: string, description: string): Promise<boolean> {
  try {
    const resolvedPath = path.resolve(dirPath);
    console.log(`🗑️  Removing ${description}: ${resolvedPath}`);
    
    // Check if directory exists
    try {
      await fs.access(resolvedPath);
    } catch {
      console.log(`ℹ️  ${description} doesn't exist, skipping`);
      return true;
    }
    
    await fs.rm(resolvedPath, { recursive: true, force: true });
    console.log(`✅ Removed ${description}`);
    return true;
  } catch (error: any) {
    console.error(`❌ Failed to remove ${description}: ${error.message}`);
    return false;
  }
}

async function cleanCDK(): Promise<boolean> {
  console.log('🏗️  Cleaning CDK artifacts...');
  
  let success = true;
  
  // Remove CDK output directory
  success = await removeDirectory('../config/cdk/cdk.out', 'CDK output directory') && success;
  
  // Remove CDK context cache
  success = await removeDirectory('../config/cdk/cdk.context.json', 'CDK context cache') && success;
  
  // Remove CDK staging directory
  success = await removeDirectory('../config/cdk/.cdk.staging', 'CDK staging directory') && success;
  
  return success;
}

async function cleanNode(): Promise<boolean> {
  console.log('📦 Cleaning Node.js artifacts...');
  
  let success = true;
  
  // Root workspace
  success = await removeDirectory('../node_modules', 'Root node_modules') && success;
  success = await removeDirectory('../package-lock.json', 'Root package-lock.json') && success;
  
  // Frontend
  success = await removeDirectory('../apps/frontend/node_modules', 'Frontend node_modules') && success;
  success = await removeDirectory('../apps/frontend/package-lock.json', 'Frontend package-lock.json') && success;
  
  // Backend
  success = await removeDirectory('../apps/backend/node_modules', 'Backend node_modules') && success;
  success = await removeDirectory('../apps/backend/package-lock.json', 'Backend package-lock.json') && success;
  
  // CDK
  success = await removeDirectory('../config/cdk/node_modules', 'CDK node_modules') && success;
  success = await removeDirectory('../config/cdk/package-lock.json', 'CDK package-lock.json') && success;
  
  // Scripts
  success = await removeDirectory('./node_modules', 'Scripts node_modules') && success;
  success = await removeDirectory('./package-lock.json', 'Scripts package-lock.json') && success;
  
  return success;
}

async function cleanNextJS(): Promise<boolean> {
  console.log('⚡ Cleaning Next.js artifacts...');
  
  let success = true;
  
  // Next.js build cache
  success = await removeDirectory('../apps/frontend/.next', 'Next.js build cache') && success;
  
  // Next.js standalone output
  success = await removeDirectory('../apps/frontend/out', 'Next.js static export') && success;
  
  // Next.js coverage reports
  success = await removeDirectory('../apps/frontend/coverage', 'Frontend coverage reports') && success;
  
  // Backend build artifacts
  success = await removeDirectory('../apps/backend/dist', 'Backend dist directory') && success;
  success = await removeDirectory('../apps/backend/coverage', 'Backend coverage reports') && success;
  
  // TypeScript build info
  success = await removeDirectory('../apps/frontend/tsconfig.tsbuildinfo', 'Frontend TS build info') && success;
  success = await removeDirectory('../apps/backend/tsconfig.tsbuildinfo', 'Backend TS build info') && success;
  
  return success;
}

async function cleanDocker(): Promise<boolean> {
  console.log('🐳 Cleaning Docker artifacts...');
  
  let success = true;
  
  // Clean up unused Docker images, containers, networks, and build cache
  success = await runCommand(['docker', 'system', 'prune', '-f'], '.', 'Docker system prune') && success;
  
  // Clean up unused Docker images more aggressively
  success = await runCommand(['docker', 'image', 'prune', '-a', '-f'], '.', 'Docker image prune') && success;
  
  // Clean up Docker build cache
  success = await runCommand(['docker', 'builder', 'prune', '-f'], '.', 'Docker builder cache prune') && success;
  
  return success;
}

async function runNpmClean(): Promise<boolean> {
  console.log('🧽 Running npm clean scripts...');
  
  let success = true;
  
  // Run clean script in frontend if it exists
  try {
    const frontendPackage = JSON.parse(await fs.readFile('../apps/frontend/package.json', 'utf8'));
    if (frontendPackage.scripts?.clean) {
      success = await runCommand(['npm', 'run', 'clean'], '../apps/frontend', 'Frontend npm clean') && success;
    }
  } catch (error) {
    console.log('ℹ️  Frontend package.json not found or no clean script');
  }
  
  // Run clean script in backend if it exists
  try {
    const backendPackage = JSON.parse(await fs.readFile('../apps/backend/package.json', 'utf8'));
    if (backendPackage.scripts?.clean) {
      success = await runCommand(['npm', 'run', 'clean'], '../apps/backend', 'Backend npm clean') && success;
    }
  } catch (error) {
    console.log('ℹ️  Backend package.json not found or no clean script');
  }
  
  // Run clean script in root workspace if it exists
  try {
    const rootPackage = JSON.parse(await fs.readFile('../package.json', 'utf8'));
    if (rootPackage.scripts?.clean) {
      success = await runCommand(['npm', 'run', 'clean'], '..', 'Root workspace npm clean') && success;
    }
  } catch (error) {
    console.log('ℹ️  Root package.json not found or no clean script');
  }
  
  return success;
}

async function clean(options: CleanOptions) {
  console.log(`🧹 Starting ${config.site.siteName} cleanup...`);
  
  const startTime = Date.now();
  let overallSuccess = true;
  
  // Determine what to clean based on options
  const shouldCleanAll = options.all || (!options.docker && !options.node && !options.cdk && !options.nextjs);
  
  try {
    if (shouldCleanAll || options.nextjs) {
      const success = await cleanNextJS();
      overallSuccess = overallSuccess && success;
    }
    
    if (shouldCleanAll || options.cdk) {
      const success = await cleanCDK();
      overallSuccess = overallSuccess && success;
    }
    
    if (shouldCleanAll || options.node) {
      // Run npm clean scripts first
      const npmSuccess = await runNpmClean();
      overallSuccess = overallSuccess && npmSuccess;
      
      // Then remove node_modules
      const nodeSuccess = await cleanNode();
      overallSuccess = overallSuccess && nodeSuccess;
    }
    
    if (shouldCleanAll || options.docker) {
      const success = await cleanDocker();
      overallSuccess = overallSuccess && success;
    }
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    
    if (overallSuccess) {
      console.log('');
      console.log('✅ Cleanup completed successfully!');
      console.log(`⏱️  Total time: ${Math.floor(duration / 60)}m ${duration % 60}s`);
      console.log('');
      console.log('💡 Next steps:');
      console.log('   npm install              # Reinstall dependencies');
      console.log('   ./semiont deploy         # Redeploy with fresh build');
    } else {
      console.log('');
      console.log('⚠️  Cleanup completed with some warnings');
      console.log('💡 Check the messages above for details');
    }
    
  } catch (error: any) {
    console.error('❌ Cleanup error:', error.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`🧹 ${config.site.siteName} Cleanup Tool`);
  console.log('');
  console.log('Usage: npx tsx clean.ts [options]');
  console.log('   or: ./semiont clean [options]');
  console.log('');
  console.log('Options:');
  console.log('   --docker      Clean Docker images, containers, and build cache');
  console.log('   --node        Clean node_modules and package-lock.json files');
  console.log('   --cdk         Clean CDK output and context cache');
  console.log('   --nextjs      Clean Next.js and build artifacts');
  console.log('   --all         Clean everything (default if no specific options)');
  console.log('   --verbose     Show detailed output');
  console.log('   --help, -h    Show this help');
  console.log('');
  console.log('Examples:');
  console.log('   ./semiont clean                    # Clean everything');
  console.log('   ./semiont clean --docker           # Clean Docker only');
  console.log('   ./semiont clean --node --nextjs    # Clean Node and Next.js');
  console.log('   ./semiont clean --cdk               # Clean CDK cache only');
  console.log('');
  console.log('What gets cleaned:');
  console.log('   🐳 Docker: images, containers, networks, build cache');
  console.log('   📦 Node: node_modules, package-lock.json (all workspaces)');
  console.log('   🏗️  CDK: cdk.out, context cache, staging directories');
  console.log('   ⚡ Next.js: .next, dist, coverage, TS build info');
  console.log('');
  console.log('⚠️  Warning: This will remove build artifacts and caches.');
  console.log('   You will need to run "npm install" after cleaning.');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  const options: CleanOptions = {
    docker: args.includes('--docker'),
    node: args.includes('--node'),
    cdk: args.includes('--cdk'),
    nextjs: args.includes('--nextjs'),
    all: args.includes('--all'),
    verbose: args.includes('--verbose'),
  };
  
  await clean(options);
}

main().catch(console.error);