import { startVitest, type UserConfig, type Vitest } from 'vitest/node';
import { resolve } from 'path';
import * as fs from 'fs';

export interface TestRunOptions {
  coverage?: boolean;
  watch?: boolean;
  testNamePattern?: string;
  reporters?: string[];
  outputFile?: string;
  silent?: boolean;
}

export interface TestResult {
  success: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  duration: number;
  coverageReport?: {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
    reportPath: string;
  } | undefined;
}

export class VitestRunner {
  private workDir: string;
  private vitest: Vitest | null = null;

  constructor(workDir: string) {
    this.workDir = resolve(workDir);
  }

  /**
   * Run tests programmatically using Vitest API
   */
  async runTests(options: TestRunOptions = {}): Promise<TestResult> {
    const startTime = Date.now();
    
    try {
      // Build Vitest configuration
      const config: UserConfig = {
        root: this.workDir,
        ...(options.coverage && {
          coverage: {
            enabled: true,
            provider: 'v8',
            reporter: ['html', 'json', 'text'],
            reportsDirectory: resolve(this.workDir, 'coverage')
          }
        }),
        reporters: options.reporters || ['default'],
        ...(options.outputFile && { outputFile: options.outputFile }),
        ...(options.testNamePattern && { testNamePattern: options.testNamePattern }),
        ...(options.silent !== undefined && { silent: options.silent })
      };

      // Start Vitest programmatically
      const vitest = await startVitest('test', [], {
        ...config,
        watch: options.watch || false
      });

      if (!vitest) {
        throw new Error('Failed to start Vitest');
      }

      this.vitest = vitest;

      // Run tests if not in watch mode
      if (!options.watch) {
        await vitest.start();
        await vitest.close();
      }

      // Get test results
      const files = vitest.state.getFiles();
      let totalTests = 0;
      let passedTests = 0;
      let failedTests = 0;
      let skippedTests = 0;

      for (const file of files) {
        const tasks = file.tasks || [];
        for (const task of tasks) {
          totalTests++;
          if (task.result?.state === 'pass') {
            passedTests++;
          } else if (task.result?.state === 'fail') {
            failedTests++;
          } else if (task.result?.state === 'skip') {
            skippedTests++;
          }
        }
      }

      const duration = Date.now() - startTime;

      // Parse coverage if enabled
      let coverageReport;
      if (options.coverage) {
        const coveragePath = resolve(this.workDir, 'coverage');
        const coverageJsonPath = resolve(coveragePath, 'coverage-final.json');
        
        if (fs.existsSync(coverageJsonPath)) {
          const coverageData = JSON.parse(fs.readFileSync(coverageJsonPath, 'utf-8'));
          
          // Calculate aggregate coverage metrics
          let totalStatements = 0;
          let coveredStatements = 0;
          let totalBranches = 0;
          let coveredBranches = 0;
          let totalFunctions = 0;
          let coveredFunctions = 0;
          let totalLines = 0;
          let coveredLines = 0;

          for (const file of Object.values(coverageData) as any[]) {
            const s = file.s || {};
            const b = file.b || {};
            const f = file.f || {};
            
            // Statements
            for (const count of Object.values(s) as number[]) {
              totalStatements++;
              if (count > 0) coveredStatements++;
            }
            
            // Branches
            for (const branch of Object.values(b) as number[][]) {
              for (const count of branch) {
                totalBranches++;
                if (count > 0) coveredBranches++;
              }
            }
            
            // Functions
            for (const count of Object.values(f) as number[]) {
              totalFunctions++;
              if (count > 0) coveredFunctions++;
            }
            
            // Lines (simplified - using statement coverage as proxy)
            totalLines = totalStatements;
            coveredLines = coveredStatements;
          }

          coverageReport = {
            statements: totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0,
            branches: totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 0,
            functions: totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 0,
            lines: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
            reportPath: resolve(coveragePath, 'index.html')
          };
        }
      }

      return {
        success: failedTests === 0,
        totalTests,
        passedTests,
        failedTests,
        skippedTests,
        duration,
        coverageReport
      };

    } catch (error) {
      console.error('Error running tests:', error);
      return {
        success: false,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Stop the Vitest instance (useful for watch mode)
   */
  async stop(): Promise<void> {
    if (this.vitest) {
      await this.vitest.close();
      this.vitest = null;
    }
  }

  /**
   * Run tests using Vitest CLI for specific patterns
   */
  async runTestsForPattern(pattern: string, options: TestRunOptions = {}): Promise<TestResult> {
    return this.runTests({
      ...options,
      testNamePattern: pattern
    });
  }

  /**
   * Get coverage summary as formatted string
   */
  formatCoverageReport(coverage: TestResult['coverageReport']): string {
    if (!coverage) return '';

    return `
📊 Coverage Summary:
   Statements: ${coverage.statements.toFixed(2)}%
   Branches:   ${coverage.branches.toFixed(2)}%
   Functions:  ${coverage.functions.toFixed(2)}%
   Lines:      ${coverage.lines.toFixed(2)}%
   
   Report: ${coverage.reportPath}
`;
  }
}