/**
 * Test Service Types and Interfaces
 * 
 * Defines the test operation for services - running various test suites
 * and collecting test results, coverage, and performance metrics.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of a test operation
 */
export interface TestResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  testTime: Date;
  suite: string; // Test suite name (unit, integration, e2e, smoke, etc.)
  tests?: {
    // Test execution details
    total?: number; // Total number of tests
    passed?: number; // Tests that passed
    failed?: number; // Tests that failed
    skipped?: number; // Tests that were skipped
    pending?: number; // Tests that are pending
    duration?: number; // Total test duration in milliseconds
    
    // Test types
    unit?: {
      total: number;
      passed: number;
      failed: number;
      duration: number;
    };
    integration?: {
      total: number;
      passed: number;
      failed: number;
      duration: number;
    };
    e2e?: {
      total: number;
      passed: number;
      failed: number;
      duration: number;
    };
    smoke?: {
      total: number;
      passed: number;
      failed: number;
      duration: number;
    };
  };
  coverage?: {
    // Code coverage metrics
    enabled: boolean;
    lines?: number; // Line coverage percentage
    branches?: number; // Branch coverage percentage
    functions?: number; // Function coverage percentage
    statements?: number; // Statement coverage percentage
    files?: {
      total: number;
      covered: number;
      uncovered: string[]; // List of uncovered files
    };
  };
  failures?: {
    // Details about test failures
    test: string; // Test name
    suite: string; // Test suite
    error: string; // Error message
    stack?: string; // Stack trace
    expected?: any; // Expected value
    actual?: any; // Actual value
    diff?: string; // Diff between expected and actual
  }[];
  performance?: {
    // Performance test results
    metrics?: {
      name: string;
      value: number;
      unit: string;
      threshold?: number;
      passed: boolean;
    }[];
    benchmarks?: {
      name: string;
      ops: number; // Operations per second
      deviation: number; // Standard deviation
      samples: number; // Number of samples
    }[];
  };
  artifacts?: {
    // Test artifacts produced
    reports?: string[]; // Test report files
    screenshots?: string[]; // Screenshot files (for e2e tests)
    videos?: string[]; // Video recordings (for e2e tests)
    logs?: string[]; // Log files
    coverage?: string; // Coverage report location
  };
  environment?: {
    // Test environment information
    framework?: string; // Test framework (jest, mocha, pytest, etc.)
    runner?: string; // Test runner
    version?: string; // Framework version
    parallel?: boolean; // Whether tests run in parallel
    workers?: number; // Number of parallel workers
    seed?: string; // Random seed for test ordering
  };
  resources?: PlatformResources;  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Options for test operation
 */
export interface TestOptions {
  suite?: string; // Which test suite to run
  pattern?: string; // File pattern for tests
  grep?: string; // Test name pattern
  coverage?: boolean; // Generate coverage report
  watch?: boolean; // Watch mode
  parallel?: boolean; // Run tests in parallel
  timeout?: number; // Test timeout
  bail?: boolean; // Stop on first failure
  verbose?: boolean; // Verbose output
  env?: Record<string, string>; // Environment variables
}