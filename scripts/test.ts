#!/usr/bin/env -S npx tsx

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';

interface TestOptions {
  target?: 'frontend' | 'backend' | 'security' | 'all';
  coverage?: boolean;
  watch?: boolean;
  verbose?: boolean;
}

interface TestResult {
  name: string;
  success: boolean;
  duration: number;
  output?: string;
}

async function runCommand(command: string[], cwd: string, description: string, verbose: boolean = false): Promise<{ success: boolean; output: string; duration: number }> {
  return new Promise((resolve) => {
    console.log(`🧪 ${description}...`);
    if (verbose) {
      console.log(`💻 Running: ${command.join(' ')}`);
      console.log(`📁 Working directory: ${path.resolve(cwd)}`);
    }
    
    const startTime = Date.now();
    let output = '';
    
    const process: ChildProcess = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: verbose ? 'inherit' : ['inherit', 'pipe', 'pipe'],
      shell: true
    });

    if (!verbose) {
      // Capture output but only show it if there's an error or if user wants verbose
      process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Only show final summary lines in non-verbose mode
        const lines = text.split('\n');
        lines.forEach((line: string) => {
          if (line.includes('Tests:') || line.includes('Snapshots:') || 
              line.includes('Time:') || line.includes('✓') || 
              line.includes('✗') || line.includes('PASS') || 
              line.includes('FAIL') || line.trim().startsWith('Test Suites:')) {
            console.log(line);
          }
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Always show errors
        console.error(text);
      });
    }

    process.on('close', (code: number | null) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        console.log(`✅ ${description} completed`);
      } else {
        console.log(`❌ ${description} failed (exit code ${code})`);
        // Show output on failure if not in verbose mode
        if (!verbose && output) {
          console.log('\n--- Test Output ---');
          console.log(output);
          console.log('--- End Test Output ---\n');
        }
      }
      resolve({ success: code === 0, output, duration });
    });

    process.on('error', (error: Error) => {
      const duration = Date.now() - startTime;
      console.error(`❌ ${description} failed: ${error.message}`);
      resolve({ success: false, output: error.message, duration });
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

async function runFrontendTests(options: TestOptions): Promise<TestResult> {
  console.log('🎨 Running frontend tests...');
  
  const frontendExists = await checkDirectoryExists('../apps/frontend');
  if (!frontendExists) {
    console.log('⚠️  Frontend directory not found, skipping frontend tests');
    return { name: 'Frontend', success: false, duration: 0 };
  }

  // Determine test command based on options
  let testCommand = ['npm', 'run'];
  
  if (options.target === 'security') {
    testCommand.push('test:security');
  } else if (options.coverage) {
    testCommand.push('test:coverage');
  } else if (options.watch) {
    testCommand.push('test:watch');
  } else {
    testCommand.push('test');
  }

  const result = await runCommand(testCommand, '../apps/frontend', 'Frontend tests', options.verbose);
  
  return {
    name: 'Frontend',
    success: result.success,
    duration: result.duration,
    output: result.output
  };
}

async function runBackendTests(options: TestOptions): Promise<TestResult> {
  console.log('🚀 Running backend tests...');
  
  const backendExists = await checkDirectoryExists('../apps/backend');
  if (!backendExists) {
    console.log('⚠️  Backend directory not found, skipping backend tests');
    return { name: 'Backend', success: false, duration: 0 };
  }

  // Determine test command based on options
  let testCommand = ['npm', 'run'];
  
  if (options.target === 'security') {
    testCommand.push('test:security');
  } else if (options.coverage) {
    testCommand.push('test:coverage');
  } else if (options.watch) {
    testCommand.push('test:watch');
  } else {
    testCommand.push('test');
  }

  const result = await runCommand(testCommand, '../apps/backend', 'Backend tests', options.verbose);
  
  return {
    name: 'Backend',
    success: result.success,
    duration: result.duration,
    output: result.output
  };
}

async function generateTestReport(results: TestResult[]): Promise<void> {
  console.log('');
  console.log('📊 Test Results Summary');
  console.log('========================');
  
  let totalDuration = 0;
  let passedTests = 0;
  let failedTests = 0;
  
  results.forEach(result => {
    if (result.duration > 0) { // Only count tests that actually ran
      const icon = result.success ? '✅' : '❌';
      const duration = (result.duration / 1000).toFixed(1);
      console.log(`${icon} ${result.name}: ${duration}s`);
      
      totalDuration += result.duration;
      if (result.success) {
        passedTests++;
      } else {
        failedTests++;
      }
    }
  });
  
  console.log('');
  console.log(`📈 Overall: ${passedTests} passed, ${failedTests} failed`);
  console.log(`⏱️  Total time: ${(totalDuration / 1000).toFixed(1)}s`);
}

async function test(options: TestOptions) {
  console.log(`🧪 Starting ${config.site.siteName} test suite...`);
  
  if (options.watch) {
    console.log('👀 Running in watch mode...');
  }
  
  if (options.coverage) {
    console.log('📊 Running with coverage reporting...');
  }
  
  if (options.target === 'security') {
    console.log('🔒 Running security-focused tests...');
  }
  
  const startTime = Date.now();
  const results: TestResult[] = [];
  
  const shouldTestAll = !options.target || options.target === 'all';
  
  try {
    // Run frontend tests
    if (shouldTestAll || options.target === 'frontend') {
      const frontendResult = await runFrontendTests(options);
      results.push(frontendResult);
    }
    
    // Run backend tests
    if (shouldTestAll || options.target === 'backend') {
      const backendResult = await runBackendTests(options);
      results.push(backendResult);
    }
    
    // Security tests run on both if security target is specified
    if (options.target === 'security') {
      console.log('🔒 Running security tests on both frontend and backend...');
      
      const frontendSecurityResult = await runFrontendTests({ ...options, target: 'security' });
      frontendSecurityResult.name = 'Frontend Security';
      results.push(frontendSecurityResult);
      
      const backendSecurityResult = await runBackendTests({ ...options, target: 'security' });
      backendSecurityResult.name = 'Backend Security';
      results.push(backendSecurityResult);
    }
    
    // Generate test report (only if not in watch mode)
    if (!options.watch) {
      await generateTestReport(results);
      
      const overallSuccess = results.every(r => r.success || r.duration === 0);
      const totalDuration = Math.round((Date.now() - startTime) / 1000);
      
      if (overallSuccess) {
        console.log('');
        console.log('✅ All tests passed!');
        console.log(`⏱️  Total time: ${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`);
        console.log('');
        console.log('💡 Next steps:');
        console.log('   ./semiont update-images  # Deploy to AWS (tests passed!)');
      } else {
        console.log('');
        console.log('❌ Some tests failed');
        console.log('💡 Check the test output above for details');
        console.log('   Use --verbose for more detailed output');
        process.exit(1);
      }
    }
    
  } catch (error: any) {
    console.error('❌ Test error:', error.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`🧪 ${config.site.siteName} Test Suite`);
  console.log('');
  console.log('Usage: npx tsx test.ts [target] [options]');
  console.log('   or: ./semiont test [target] [options]');
  console.log('');
  console.log('Targets:');
  console.log('   frontend         Run frontend tests only');
  console.log('   backend          Run backend tests only');
  console.log('   security         Run security-focused tests on both apps');
  console.log('   all              Run all tests (default)');
  console.log('   (none)           Run all tests');
  console.log('');
  console.log('Options:');
  console.log('   --coverage       Run tests with coverage reporting');
  console.log('   --watch          Run tests in watch mode');
  console.log('   --verbose        Show detailed output');
  console.log('   --help, -h       Show this help');
  console.log('');
  console.log('Examples:');
  console.log('   ./semiont test                    # Run all tests');
  console.log('   ./semiont test frontend           # Run frontend tests only');
  console.log('   ./semiont test backend            # Run backend tests only');
  console.log('   ./semiont test security           # Run security tests on both apps');
  console.log('   ./semiont test --coverage         # Run all tests with coverage');
  console.log('   ./semiont test frontend --watch   # Watch frontend tests');
  console.log('');
  console.log('Test types available:');
  console.log('   🎨 Frontend: Jest with React Testing Library');
  console.log('   🚀 Backend: Jest with Supertest for API testing');
  console.log('   🔒 Security: Authentication, authorization, input validation');
  console.log('   📊 Coverage: Code coverage reports for both apps');
  console.log('');
  console.log('💡 Run tests before deploying to catch issues early.');
  console.log('   Use "./semiont test --coverage" for detailed coverage reports.');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  // Get target from first non-flag argument
  const target = args.find((arg: string) => !arg.startsWith('--')) as 'frontend' | 'backend' | 'security' | 'all' | undefined;
  
  // Validate target argument
  if (target && !['frontend', 'backend', 'security', 'all'].includes(target)) {
    console.error(`❌ Invalid target: ${target}`);
    console.log('💡 Valid targets: frontend, backend, security, all');
    showHelp();
    process.exit(1);
  }
  
  const options: TestOptions = {
    ...(target && { target }),
    coverage: args.includes('--coverage'),
    watch: args.includes('--watch'),
    verbose: args.includes('--verbose'),
  };
  
  await test(options);
}

main().catch(console.error);