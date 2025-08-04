#!/usr/bin/env -S npx tsx

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { config } from '../config';

interface BuildOptions {
  target?: 'frontend' | 'backend' | 'docker' | 'all';
  verbose?: boolean;
  skipInstall?: boolean;
  skipBuild?: boolean;
}

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

async function getFileHash(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex').substring(0, 8);
  } catch {
    return null;
  }
}

async function getDirectoryHash(dirPath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) return null;
    
    const files = await fs.readdir(dirPath, { recursive: true });
    const fileHashes: string[] = [];
    
    for (const file of files) {
      const fullPath = path.join(dirPath, file.toString());
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        const hash = await getFileHash(fullPath);
        if (hash) fileHashes.push(`${file}:${hash}`);
      }
    }
    
    return createHash('sha256').update(fileHashes.sort().join('|')).digest('hex').substring(0, 8);
  } catch {
    return null;
  }
}

async function runCommand(command: string[], cwd: string, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    log(`🔨 ${description}...`);
    log(`💻 Working directory: ${path.resolve(cwd)}`);
    log(`💻 Command: ${command.join(' ')}`);
    
    const startTime = Date.now();
    const process = spawn(command[0], command.slice(1), {
      cwd,
      stdio: 'inherit',
      shell: true
    });

    process.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        log(`✅ ${description} completed in ${duration}ms`);
      } else {
        log(`❌ ${description} failed (exit code ${code}) after ${duration}ms`);
      }
      resolve(code === 0);
    });

    process.on('error', (error) => {
      const duration = Date.now() - startTime;
      log(`❌ ${description} failed: ${error.message} after ${duration}ms`);
      resolve(false);
    });
  });
}

async function checkDirectoryExists(dirPath: string): Promise<boolean> {
  try {
    const resolvedPath = path.resolve(dirPath);
    await fs.access(resolvedPath);
    return true;
  } catch {
    return false;
  }
}

async function installDependencies(): Promise<boolean> {
  log('📦 Installing dependencies...');
  
  // Check inputs
  const packageJsonPath = path.resolve('../package.json');
  log(`📋 Input: ${packageJsonPath}`);
  
  const packageJsonHash = await getFileHash(packageJsonPath);
  if (!packageJsonHash) {
    log(`❌ CRITICAL: Cannot read package.json at ${packageJsonPath}`);
    return false;
  }
  log(`📋 Input hash: package.json = ${packageJsonHash}`);
  
  const lockFilePath = path.resolve('../package-lock.json');
  const lockFileHash = await getFileHash(lockFilePath);
  if (lockFileHash) {
    log(`📋 Input hash: package-lock.json = ${lockFileHash}`);
  } else {
    log(`⚠️  No package-lock.json found at ${lockFilePath}`);
  }
  
  // Run installation
  const success = await runCommand(['npm', 'install'], '..', 'Root workspace npm install');
  
  // Validate outputs
  const nodeModulesPath = path.resolve('../node_modules');
  const nodeModulesExists = await checkDirectoryExists(nodeModulesPath);
  
  if (!nodeModulesExists) {
    log(`❌ CRITICAL: node_modules not created at ${nodeModulesPath}`);
    return false;
  }
  
  const nodeModulesHash = await getDirectoryHash(nodeModulesPath);
  log(`📤 Output: ${nodeModulesPath} (${nodeModulesExists ? 'EXISTS' : 'MISSING'})`);
  if (nodeModulesHash) {
    log(`📤 Output hash: node_modules = ${nodeModulesHash}`);
  }
  
  // Check final lock file hash
  const finalLockFileHash = await getFileHash(lockFilePath);
  if (finalLockFileHash) {
    log(`📤 Output hash: final package-lock.json = ${finalLockFileHash}`);
    if (finalLockFileHash !== lockFileHash) {
      log(`⚠️  package-lock.json changed during install (${lockFileHash} -> ${finalLockFileHash})`);
    }
  }
  
  return success;
}

async function buildApplications(options: BuildOptions): Promise<boolean> {
  log('🏗️  Building applications...');
  
  let success = true;
  const shouldBuildAll = !options.target || options.target === 'all';
  
  // Build backend
  if (shouldBuildAll || options.target === 'backend') {
    const backendPath = path.resolve('../apps/backend');
    const backendExists = await checkDirectoryExists(backendPath);
    
    if (!backendExists) {
      log(`❌ CRITICAL: Backend directory not found at ${backendPath}`);
      return false;
    }
    
    // Check backend inputs
    const backendSrcHash = await getDirectoryHash(path.join(backendPath, 'src'));
    const backendPackageHash = await getFileHash(path.join(backendPath, 'package.json'));
    const backendTsConfigHash = await getFileHash(path.join(backendPath, 'tsconfig.json'));
    
    log(`📋 Backend inputs:`);
    log(`  📁 src/ = ${backendSrcHash || 'MISSING'}`);
    log(`  📄 package.json = ${backendPackageHash || 'MISSING'}`);
    log(`  📄 tsconfig.json = ${backendTsConfigHash || 'MISSING'}`);
    
    if (!backendSrcHash || !backendPackageHash) {
      log(`❌ CRITICAL: Missing required backend source files`);
      return false;
    }
    
    const backendSuccess = await runCommand(['npm', 'run', 'build'], '../apps/backend', 'Backend build');
    
    // Validate backend outputs
    const backendDistPath = path.join(backendPath, 'dist');
    const backendDistExists = await checkDirectoryExists(backendDistPath);
    const backendDistHash = await getDirectoryHash(backendDistPath);
    
    log(`📤 Backend outputs:`);
    log(`  📁 dist/ = ${backendDistExists ? 'EXISTS' : 'MISSING'} (${backendDistHash || 'NO_HASH'})`);
    
    if (!backendDistExists) {
      log(`❌ CRITICAL: Backend build did not produce dist/ directory`);
      return false;
    }
    
    success = success && backendSuccess;
  }
  
  // Build frontend
  if (shouldBuildAll || options.target === 'frontend') {
    const frontendPath = path.resolve('../apps/frontend');
    const frontendExists = await checkDirectoryExists(frontendPath);
    
    if (!frontendExists) {
      log(`❌ CRITICAL: Frontend directory not found at ${frontendPath}`);
      return false;
    }
    
    // Check frontend inputs  
    const frontendSrcHash = await getDirectoryHash(path.join(frontendPath, 'src'));
    const frontendPackageHash = await getFileHash(path.join(frontendPath, 'package.json'));
    const frontendNextConfigHash = await getFileHash(path.join(frontendPath, 'next.config.js'));
    const frontendTsConfigHash = await getFileHash(path.join(frontendPath, 'tsconfig.json'));
    
    log(`📋 Frontend inputs:`);
    log(`  📁 src/ = ${frontendSrcHash || 'MISSING'}`);
    log(`  📄 package.json = ${frontendPackageHash || 'MISSING'}`);
    log(`  📄 next.config.js = ${frontendNextConfigHash || 'MISSING'}`);
    log(`  📄 tsconfig.json = ${frontendTsConfigHash || 'MISSING'}`);
    
    if (!frontendSrcHash || !frontendPackageHash) {
      log(`❌ CRITICAL: Missing required frontend source files`);
      return false;
    }
    
    const frontendSuccess = await runCommand(['npm', 'run', 'build'], '../apps/frontend', 'Frontend build');
    
    // Validate frontend outputs
    const frontendNextPath = path.join(frontendPath, '.next');
    const frontendNextExists = await checkDirectoryExists(frontendNextPath);
    const frontendNextHash = await getDirectoryHash(frontendNextPath);
    
    log(`📤 Frontend outputs:`);
    log(`  📁 .next/ = ${frontendNextExists ? 'EXISTS' : 'MISSING'} (${frontendNextHash || 'NO_HASH'})`);
    
    if (!frontendNextExists) {
      log(`❌ CRITICAL: Frontend build did not produce .next/ directory`);
      return false;
    }
    
    success = success && frontendSuccess;
  }
  
  return success;
}

async function getDockerImageInfo(imageName: string): Promise<{ id: string; created: string; size: string } | null> {
  try {
    const { spawn } = await import('child_process');
    return new Promise((resolve) => {
      const process = spawn('docker', ['images', '--format', 'json', imageName], { stdio: 'pipe' });
      let output = '';
      
      process.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0 && output.trim()) {
          try {
            const imageInfo = JSON.parse(output.trim().split('\n')[0]);
            resolve({
              id: imageInfo.ID?.substring(0, 12) || 'unknown',
              created: imageInfo.CreatedAt || 'unknown',
              size: imageInfo.Size || 'unknown'
            });
          } catch {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });
  } catch {
    return null;
  }
}

async function buildDockerImages(): Promise<boolean> {
  log('🐳 Building Docker images...');
  
  let success = true;
  
  // Check if docker is available
  const dockerCheckSuccess = await runCommand(['docker', '--version'], '.', 'Docker version check');
  if (!dockerCheckSuccess) {
    log('❌ CRITICAL: Docker is not available, cannot build Docker images');
    return false;
  }
  
  const cacheBust = new Date().toISOString();
  log(`🔄 Cache bust value: ${cacheBust}`);
  
  // Build backend Docker image
  const backendPath = path.resolve('../apps/backend');
  const backendExists = await checkDirectoryExists(backendPath);
  
  if (backendExists) {
    // Check backend Docker inputs
    const dockerfilePath = path.join(backendPath, 'Dockerfile');
    const dockerfileHash = await getFileHash(dockerfilePath);
    const backendDistHash = await getDirectoryHash(path.join(backendPath, 'dist'));
    const backendPackageHash = await getFileHash(path.join(backendPath, 'package.json'));
    
    log(`📋 Backend Docker inputs:`);
    log(`  📄 Dockerfile = ${dockerfileHash || 'MISSING'}`);
    log(`  📁 dist/ = ${backendDistHash || 'MISSING'}`);
    log(`  📄 package.json = ${backendPackageHash || 'MISSING'}`);
    
    if (!dockerfileHash) {
      log(`❌ CRITICAL: Backend Dockerfile not found at ${dockerfilePath}`);
      return false;
    }
    
    if (!backendDistHash) {
      log(`❌ CRITICAL: Backend dist/ directory not found - run application build first`);
      return false;
    }
    
    const backendBuildSuccess = await runCommand([
      'docker', 'build', 
      '--platform', 'linux/amd64',
      '--build-arg', `CACHE_BUST=${cacheBust}`,
      '-t', 'semiont-backend:latest',
      '../apps/backend'
    ], '.', 'Backend Docker build');
    
    // Validate backend Docker output
    const backendImageInfo = await getDockerImageInfo('semiont-backend:latest');
    if (backendImageInfo) {
      log(`📤 Backend Docker output:`);
      log(`  🐳 Image ID: ${backendImageInfo.id}`);
      log(`  📅 Created: ${backendImageInfo.created}`);
      log(`  📦 Size: ${backendImageInfo.size}`);
    } else {
      log(`❌ CRITICAL: Backend Docker image 'semiont-backend:latest' not found after build`);
      return false;
    }
    
    success = success && backendBuildSuccess;
  } else {
    log(`❌ CRITICAL: Backend directory not found at ${backendPath}`);
    return false;
  }
  
  // Build frontend Docker image
  const frontendPath = path.resolve('../apps/frontend');
  const frontendExists = await checkDirectoryExists(frontendPath);
  
  if (frontendExists) {
    // Check frontend Docker inputs
    const dockerfilePath = path.join(frontendPath, 'Dockerfile');
    const dockerfileHash = await getFileHash(dockerfilePath);
    const frontendNextHash = await getDirectoryHash(path.join(frontendPath, '.next'));
    const frontendPackageHash = await getFileHash(path.join(frontendPath, 'package.json'));
    
    log(`📋 Frontend Docker inputs:`);
    log(`  📄 Dockerfile = ${dockerfileHash || 'MISSING'}`);
    log(`  📁 .next/ = ${frontendNextHash || 'MISSING'}`);
    log(`  📄 package.json = ${frontendPackageHash || 'MISSING'}`);
    
    if (!dockerfileHash) {
      log(`❌ CRITICAL: Frontend Dockerfile not found at ${dockerfilePath}`);
      return false;
    }
    
    if (!frontendNextHash) {
      log(`❌ CRITICAL: Frontend .next/ directory not found - run application build first`);
      return false;
    }
    
    const buildArgs = [
      `NEXT_PUBLIC_API_URL=https://${config.site.domain}`,
      `NEXT_PUBLIC_SITE_NAME=${config.site.siteName}`,
      `NEXT_PUBLIC_DOMAIN=${config.site.domain}`,
      `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=${config.site.oauthAllowedDomains.join(',')}`,
      `CACHE_BUST=${cacheBust}`
    ];
    
    log(`📋 Frontend build args:`);
    buildArgs.forEach(arg => log(`  🔧 ${arg}`));
    
    const frontendBuildSuccess = await runCommand([
      'docker', 'build',
      '--platform', 'linux/amd64',
      ...buildArgs.flatMap(arg => ['--build-arg', arg]),
      '-t', 'semiont-frontend:latest',
      '../apps/frontend'
    ], '.', 'Frontend Docker build');
    
    // Validate frontend Docker output
    const frontendImageInfo = await getDockerImageInfo('semiont-frontend:latest');
    if (frontendImageInfo) {
      log(`📤 Frontend Docker output:`);
      log(`  🐳 Image ID: ${frontendImageInfo.id}`);
      log(`  📅 Created: ${frontendImageInfo.created}`);
      log(`  📦 Size: ${frontendImageInfo.size}`);
    } else {
      log(`❌ CRITICAL: Frontend Docker image 'semiont-frontend:latest' not found after build`);
      return false;
    }
    
    success = success && frontendBuildSuccess;
  } else {
    log(`❌ CRITICAL: Frontend directory not found at ${frontendPath}`);
    return false;
  }
  
  return success;
}

async function validateBuild(): Promise<boolean> {
  console.log('🔍 Validating build outputs...');
  
  let success = true;
  
  // Check backend build output
  const backendDistExists = await checkDirectoryExists('../apps/backend/dist');
  if (backendDistExists) {
    console.log('✅ Backend dist directory found');
  } else {
    console.log('⚠️  Backend dist directory not found');
    success = false;
  }
  
  // Check frontend build output
  const frontendNextExists = await checkDirectoryExists('../apps/frontend/.next');
  if (frontendNextExists) {
    console.log('✅ Frontend .next directory found');
  } else {
    console.log('⚠️  Frontend .next directory not found');
    success = false;
  }
  
  // Check Docker images
  try {
    const dockerImages = await runCommand(['docker', 'images', '--format', 'table {{.Repository}}:{{.Tag}}'], '.', 'List Docker images');
    if (dockerImages) {
      console.log('✅ Docker images check completed');
    }
  } catch (error) {
    console.log('⚠️  Could not verify Docker images');
  }
  
  return success;
}

async function build(options: BuildOptions) {
  log(`🚀 Starting ${config.site.siteName} build process...`);
  log(`🎯 Target: ${options.target || 'all'}`);
  log(`⚙️  Options: skipInstall=${options.skipInstall}, skipBuild=${options.skipBuild}, verbose=${options.verbose}`);
  
  const startTime = Date.now();
  let overallSuccess = true;
  
  const shouldBuildAll = !options.target || options.target === 'all';
  
  try {
    // Step 1: Install dependencies
    if (!options.skipInstall) {
      const installSuccess = await installDependencies();
      overallSuccess = overallSuccess && installSuccess;
      
      if (!installSuccess) {
        console.log('❌ Dependency installation failed, aborting build');
        return;
      }
    } else {
      console.log('⏭️  Skipping dependency installation');
    }
    
    // Step 2: Build applications  
    if (!options.skipBuild && (shouldBuildAll || options.target === 'frontend' || options.target === 'backend')) {
      const buildSuccess = await buildApplications(options);
      overallSuccess = overallSuccess && buildSuccess;
      
      if (!buildSuccess) {
        console.log('❌ Application build failed, aborting Docker builds');
        return;
      }
    } else if (options.skipBuild) {
      console.log('⏭️  Skipping application builds');
    }
    
    // Step 3: Build Docker images
    if (shouldBuildAll || options.target === 'docker') {
      const dockerSuccess = await buildDockerImages();
      overallSuccess = overallSuccess && dockerSuccess;
    }
    
    // Step 4: Validate build outputs
    const validationSuccess = await validateBuild();
    overallSuccess = overallSuccess && validationSuccess;
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    
    if (overallSuccess) {
      log('');
      log('✅ Build completed successfully!');
      log(`⏱️  Total time: ${Math.floor(duration / 60)}m ${duration % 60}s`);
      log('');
      log('💡 Next steps:');
      log('   ./semiont test           # Run tests (REQUIRED before deployment)');
      log('   ./semiont update-images  # Push images to ECR and deploy');
      log('   ./semiont status         # Check deployment status');
    } else {
      log('');
      log('❌ Build FAILED with critical errors');
      log('💡 Check the CRITICAL error messages above for details');
      log('   Build process is designed to fail fast on missing inputs/outputs');
      process.exit(1);
    }
    
  } catch (error: any) {
    console.error('❌ Build error:', error.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`🔨 ${config.site.siteName} Build Tool`);
  console.log('');
  console.log('Usage: npx tsx build.ts [target] [options]');
  console.log('   or: ./semiont build [target] [options]');
  console.log('');
  console.log('Targets:');
  console.log('   frontend         Build frontend application only');
  console.log('   backend          Build backend application only');
  console.log('   docker           Build Docker images only');
  console.log('   all              Build everything (default)');
  console.log('   (none)           Build everything');
  console.log('');
  console.log('Options:');
  console.log('   --skip-install   Skip npm install step');
  console.log('   --skip-build     Skip application build step (go straight to Docker)');
  console.log('   --verbose        Show detailed output');
  console.log('   --help, -h       Show this help');
  console.log('');
  console.log('Examples:');
  console.log('   ./semiont build                    # Build everything');
  console.log('   ./semiont build frontend           # Build frontend only');
  console.log('   ./semiont build backend            # Build backend only');
  console.log('   ./semiont build docker             # Build Docker images only');
  console.log('   ./semiont build all --skip-install # Build everything, skip npm install');
  console.log('');
  console.log('Build process steps:');
  console.log('   1. 📦 Install dependencies (npm install in root workspace)');
  console.log('   2. 🏗️  Build applications (npm run build for frontend/backend)');
  console.log('   3. 🐳 Build Docker images (with cache-busting and build args)');
  console.log('   4. 🔍 Validate build outputs (check dist directories and images)');
  console.log('');
  console.log('💡 This prepares everything needed between a clean and deploy operation.');
  console.log('   After building, use "./semiont update-images" to deploy to AWS.');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  // Get target from first non-flag argument
  const target = args.find((arg: string) => !arg.startsWith('--')) as 'frontend' | 'backend' | 'docker' | 'all' | undefined;
  
  // Validate target argument
  if (target && !['frontend', 'backend', 'docker', 'all'].includes(target)) {
    console.error(`❌ Invalid target: ${target}`);
    console.log('💡 Valid targets: frontend, backend, docker, all');
    showHelp();
    process.exit(1);
  }
  
  const options: BuildOptions = {
    target,
    verbose: args.includes('--verbose'),
    skipInstall: args.includes('--skip-install'),
    skipBuild: args.includes('--skip-build'),
  };
  
  await build(options);
}

main().catch(console.error);