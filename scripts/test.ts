#!/usr/bin/env -S npx tsx

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

// Set environment for config loading - tests should use test environment
process.env.SEMIONT_ENV = 'test';

// Load config dynamically since it might be CommonJS
const configModule = await import('../config/index.js');
const config = configModule.config;

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

interface CoverageSummary {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

interface DirectoryCoverage {
  name: string;
  statements: { covered: number; total: number; pct: number };
  branches: { covered: number; total: number; pct: number };
  functions: { covered: number; total: number; pct: number };
  lines: { covered: number; total: number; pct: number };
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
      // Capture output but only show summary lines
      process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Only show final summary lines and test suite completion
        const lines = text.split('\n');
        lines.forEach((line: string) => {
          if (line.includes('Test Files') || line.includes('Tests:') || 
              line.includes('Snapshots:') || line.includes('Time:') || 
              line.includes('Duration') || line.includes('✓') || 
              line.includes('✗') || line.includes('PASS') || 
              line.includes('FAIL') || line.trim().match(/^\s*✓\s+\w+/)) {
            console.log(line);
          }
        });
      });

      // Suppress stderr noise from intentional test errors
      process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Only show actual test failures, not intentional error logs
        if (text.includes('FAIL') || text.includes('Error:') && !text.includes('stderr |')) {
          console.error(text);
        }
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

async function parseFrontendTestResults(cwd: string): Promise<{ totalTests: number; passedTests: number; failedTests: number }> {
  try {
    const testResultsPath = path.resolve(cwd, 'test-results.json');
    const testResults = await fs.readFile(testResultsPath, 'utf-8');
    const results = JSON.parse(testResults);
    
    return {
      totalTests: results.numTotalTests || 0,
      passedTests: results.numPassedTests || 0,
      failedTests: results.numFailedTests || 0
    };
  } catch (error) {
    console.log('⚠️  Could not parse test results JSON, using basic parsing');
    return { totalTests: 0, passedTests: 0, failedTests: 0 };
  }
}

function formatEnhancedCoverageTable(data: { total: CoverageSummary; directories: DirectoryCoverage[] }, title: string): void {
  console.log(`\n📊 ${title} Coverage Summary`);
  
  // Overall totals first
  console.log('\n🎯 Overall Coverage');
  console.log('┌────────────┬─────────┐');
  console.log('│ Metric     │ Percent │');
  console.log('├────────────┼─────────┤');
  
  const formatRow = (name: string, pct: number) => {
    const pctStr = `${pct.toFixed(1)}%`;
    const paddedPctStr = pctStr.padStart(7);
    
    // Color coding based on coverage percentage
    let pctDisplay = '';
    if (pct >= 90) {
      pctDisplay = `\x1b[32m${paddedPctStr}\x1b[0m`; // Green for excellent
    } else if (pct >= 80) {
      pctDisplay = `\x1b[33m${paddedPctStr}\x1b[0m`; // Yellow for good
    } else {
      pctDisplay = `\x1b[31m${paddedPctStr}\x1b[0m`; // Red for needs improvement
    }
    
    console.log(`│ ${name.padEnd(10)} │${pctDisplay} │`);
  };
  
  formatRow('Statements', data.total.statements);
  formatRow('Branches', data.total.branches);
  formatRow('Functions', data.total.functions);
  formatRow('Lines', data.total.lines);
  
  console.log('└────────────┴─────────┘');
  
  // Overall assessment
  const avgCoverage = (data.total.statements + data.total.branches + data.total.functions + data.total.lines) / 4;
  let assessment = '';
  if (avgCoverage >= 90) {
    assessment = '🟢 Excellent coverage!';
  } else if (avgCoverage >= 80) {
    assessment = '🟡 Good coverage, room for improvement';
  } else {
    assessment = '🔴 Coverage needs improvement';
  }
  console.log(`${assessment} (Average: ${avgCoverage.toFixed(1)}%)`);

  // Directory breakdown
  if (data.directories.length > 0) {
    console.log('\n📁 Coverage by Directory');
    console.log('┌──────────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ Directory    │ Stmts    │ Branch   │ Funcs    │ Lines    │');
    console.log('├──────────────┼──────────┼──────────┼──────────┼──────────┤');
    
    const formatDirRow = (dir: DirectoryCoverage) => {
      const name = dir.name.length > 12 ? dir.name.substring(0, 12) : dir.name;
      const nameCell = name.padEnd(12);
      
      const formatMetric = (pct: number) => {
        const pctStr = `${pct.toFixed(1)}%`;
        const paddedPctStr = pctStr.padStart(8);
        if (pct >= 90) {
          return `\x1b[32m${paddedPctStr}\x1b[0m`;
        } else if (pct >= 80) {
          return `\x1b[33m${paddedPctStr}\x1b[0m`;
        } else {
          return `\x1b[31m${paddedPctStr}\x1b[0m`;
        }
      };
      
      console.log(`│ ${nameCell} │${formatMetric(dir.statements.pct)} │${formatMetric(dir.branches.pct)} │${formatMetric(dir.functions.pct)} │${formatMetric(dir.lines.pct)} │`);
    };
    
    data.directories.forEach(formatDirRow);
    console.log('└──────────────┴──────────┴──────────┴──────────┴──────────┘');
  }
}

async function parseCoverageFromSummaryJson(cwd: string): Promise<{ total: CoverageSummary; directories: DirectoryCoverage[] } | null> {
  try {
    const coverageSummaryPath = path.resolve(cwd, 'coverage/coverage-summary.json');
    const summaryData = JSON.parse(await fs.readFile(coverageSummaryPath, 'utf-8'));
    
    if (!summaryData.total) {
      return null;
    }

    // Get total coverage
    const total: CoverageSummary = {
      statements: summaryData.total.statements?.pct || 0,
      branches: summaryData.total.branches?.pct || 0,
      functions: summaryData.total.functions?.pct || 0,
      lines: summaryData.total.lines?.pct || 0
    };

    // Aggregate coverage by directory
    const directoriesMap = new Map<string, {
      statements: { covered: number; total: number };
      branches: { covered: number; total: number };
      functions: { covered: number; total: number };
      lines: { covered: number; total: number };
    }>();

    // Process each file entry (skip "total" key)
    for (const [filePath, fileData] of Object.entries(summaryData)) {
      if (filePath === 'total') continue;
      
      // Extract top-level directory from file path
      // Example: "/path/to/project/src/components/Header.tsx" -> "components"
      // Example: "/path/to/project/src/app/page.tsx" -> "app"
      const relativePath = filePath.replace(/.*\/src\//, ''); // Remove everything up to /src/
      const topLevelDir = relativePath.split('/')[0] || 'root';
      
      if (!directoriesMap.has(topLevelDir)) {
        directoriesMap.set(topLevelDir, {
          statements: { covered: 0, total: 0 },
          branches: { covered: 0, total: 0 },
          functions: { covered: 0, total: 0 },
          lines: { covered: 0, total: 0 }
        });
      }
      
      const dirData = directoriesMap.get(topLevelDir)!;
      const file = fileData as any;
      
      // Aggregate metrics
      dirData.statements.covered += file.statements?.covered || 0;
      dirData.statements.total += file.statements?.total || 0;
      dirData.branches.covered += file.branches?.covered || 0;
      dirData.branches.total += file.branches?.total || 0;
      dirData.functions.covered += file.functions?.covered || 0;
      dirData.functions.total += file.functions?.total || 0;
      dirData.lines.covered += file.lines?.covered || 0;
      dirData.lines.total += file.lines?.total || 0;
    }

    // Convert to DirectoryCoverage array with calculated percentages
    const directories: DirectoryCoverage[] = Array.from(directoriesMap.entries()).map(([name, data]) => ({
      name,
      statements: {
        covered: data.statements.covered,
        total: data.statements.total,
        pct: data.statements.total > 0 ? (data.statements.covered / data.statements.total) * 100 : 0
      },
      branches: {
        covered: data.branches.covered,
        total: data.branches.total,
        pct: data.branches.total > 0 ? (data.branches.covered / data.branches.total) * 100 : 0
      },
      functions: {
        covered: data.functions.covered,
        total: data.functions.total,
        pct: data.functions.total > 0 ? (data.functions.covered / data.functions.total) * 100 : 0
      },
      lines: {
        covered: data.lines.covered,
        total: data.lines.total,
        pct: data.lines.total > 0 ? (data.lines.covered / data.lines.total) * 100 : 0
      }
    })).sort((a, b) => a.name.localeCompare(b.name)); // Sort alphabetically

    return { total, directories };
  } catch (error) {
    return null;
  }
}

async function runFrontendTests(options: TestOptions): Promise<TestResult> {
  console.log('🎨 Running frontend tests...');
  
  const frontendExists = await checkDirectoryExists('../apps/frontend');
  if (!frontendExists) {
    console.log('⚠️  Frontend directory not found, skipping frontend tests');
    return { name: 'Frontend', success: false, duration: 0 };
  }

  // Set SEMIONT_ENV to 'test' for frontend tests
  process.env.SEMIONT_ENV = 'test';

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
  
  // Try to parse JSON results for better summary
  if (!options.verbose && result.success) {
    const testStats = await parseFrontendTestResults('../apps/frontend');
    if (testStats.totalTests > 0) {
      console.log(`✅ ${testStats.passedTests}/${testStats.totalTests} tests passed`);
      if (testStats.failedTests > 0) {
        console.log(`❌ ${testStats.failedTests} tests failed`);
      }
    }
    
    // Show coverage report if coverage was requested
    if (options.coverage) {
      // Parse and display coverage table from JSON
      const coverageData = await parseCoverageFromSummaryJson('../apps/frontend');
      if (coverageData) {
        formatEnhancedCoverageTable(coverageData, 'Frontend');
      }
      
      console.log(`\n📊 Coverage report generated at: apps/frontend/coverage/index.html`);
      console.log(`   Open in browser: file://${process.cwd()}/../apps/frontend/coverage/index.html`);
    }
  }
  
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

  // Set SEMIONT_ENV to 'test' for backend tests
  process.env.SEMIONT_ENV = 'test';

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
  
  // Show coverage report if coverage was requested
  if (options.coverage && result.success && !options.verbose) {
    // Parse and display coverage table from JSON
    const coverageData = await parseCoverageFromSummaryJson('../apps/backend');
    if (coverageData) {
      formatEnhancedCoverageTable(coverageData, 'Backend');
    }
    
    console.log(`\n📊 Coverage report generated at: apps/backend/coverage/index.html`);
    console.log(`   Open in browser: file://${process.cwd()}/../apps/backend/coverage/index.html`);
  }
  
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