// Service architecture types

export type ServiceName = 'backend' | 'frontend' | 'database' | 'filesystem' | 'mcp' | 'agent';
export type DeploymentType = 'aws' | 'container' | 'process' | 'external';
export type Environment = 'dev' | 'staging' | 'prod' | 'ci' | 'local';

export interface Config {
  projectRoot: string;
  environment: Environment;
  verbose: boolean;
  quiet: boolean;
  dryRun?: boolean;
}

export interface ServiceConfig {
  deploymentType: DeploymentType;
  port?: number;
  command?: string;
  image?: string;
  host?: string;
  path?: string;
  name?: string;
  user?: string;
  password?: string;
  [key: string]: any;
}

export interface StartResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  startTime: Date;
  endpoint?: string;
  pid?: number;
  containerId?: string;
  error?: string;
  metadata?: Record<string, any>;
}

export interface StopResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  stopTime: Date;
  gracefulShutdown?: boolean;
  error?: string;
  metadata?: Record<string, any>;
}

export interface CheckResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  checkTime: Date;
  status: 'running' | 'stopped' | 'unhealthy' | 'unknown';
  stateVerified: boolean; // Did saved state match reality?
  stateMismatch?: {
    expected: any;
    actual: any;
    reason: string;
  };
  health?: {
    endpoint?: string;
    statusCode?: number;
    responseTime?: number;
    healthy: boolean;
    details?: Record<string, any>;
  };
  resources?: {
    pid?: number;
    containerId?: string;
    port?: number;
    cpu?: number;
    memory?: number;
    uptime?: number;
  };
  logs?: {
    recent?: string[];
    errors?: number;
    warnings?: number;
  };
  error?: string;
  metadata?: Record<string, any>;
}

export interface UpdateResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  updateTime: Date;
  previousVersion?: string;
  newVersion?: string;
  strategy: 'restart' | 'rolling' | 'blue-green' | 'recreate' | 'none';
  downtime?: number; // milliseconds
  error?: string;
  metadata?: Record<string, any>;
}

export interface ProvisionResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  provisionTime: Date;
  resources?: {
    // Infrastructure resources created
    clusterId?: string;
    instanceId?: string;
    bucketName?: string;
    volumeId?: string;
    networkId?: string;
    securityGroupIds?: string[];
    roleArn?: string;
    // Credentials and access info
    credentials?: {
      accessKeyId?: string;
      secretPath?: string;
      connectionString?: string;
    };
  };
  dependencies?: string[]; // Other services this depends on
  cost?: {
    estimatedMonthly?: number;
    currency?: string;
  };
  error?: string;
  metadata?: Record<string, any>;
}

export interface PublishResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  publishTime: Date;
  artifacts?: {
    // Published artifacts
    imageTag?: string;
    imageUrl?: string;
    packageName?: string;
    packageVersion?: string;
    bundleUrl?: string;
    staticSiteUrl?: string;
    // Registry/repository info
    registry?: string;
    repository?: string;
    branch?: string;
    commitSha?: string;
  };
  version?: {
    previous?: string;
    current?: string;
    tag?: string;
  };
  destinations?: {
    registry?: string;
    bucket?: string;
    cdn?: string;
    repository?: string;
  };
  rollback?: {
    supported: boolean;
    command?: string;
    artifactId?: string;
  };
  error?: string;
  metadata?: Record<string, any>;
}

export interface BackupResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  backupTime: Date;
  backupId: string; // Unique identifier for this backup
  backup?: {
    // Backup artifacts and metadata
    size?: number; // Size in bytes
    location?: string; // Where the backup is stored
    format?: 'tar' | 'sql' | 'json' | 'binary' | 'snapshot';
    compression?: 'gzip' | 'bzip2' | 'xz' | 'none';
    encrypted?: boolean;
    checksum?: string; // For integrity verification
    // Backup content types
    database?: {
      type: 'postgresql' | 'mysql' | 'sqlite' | 'mongodb';
      schema?: boolean;
      data?: boolean;
      tables?: string[];
    };
    filesystem?: {
      paths?: string[];
      excludePatterns?: string[];
      preservePermissions?: boolean;
    };
    configuration?: {
      envFiles?: string[];
      configMaps?: string[];
      secrets?: boolean; // Whether secrets were backed up
    };
    application?: {
      source?: boolean;
      assets?: boolean;
      logs?: boolean;
    };
  };
  retention?: {
    expiresAt?: Date;
    policy?: string; // e.g., "daily", "weekly", "monthly"
    autoCleanup?: boolean;
  };
  restore?: {
    supported: boolean;
    command?: string;
    requirements?: string[]; // Prerequisites for restoration
  };
  cost?: {
    storage?: number; // Storage cost
    transfer?: number; // Transfer cost
    currency?: string;
  };
  error?: string;
  metadata?: Record<string, any>;
}

export interface ExecResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  execTime: Date;
  command: string; // The command that was executed
  execution?: {
    // Execution context
    workingDirectory?: string;
    user?: string; // User context (e.g., root, app, www-data)
    shell?: string; // Shell used (bash, sh, etc.)
    interactive?: boolean; // Was it an interactive session?
    tty?: boolean; // Was a TTY allocated?
    
    // Process information
    pid?: number; // Process ID of executed command
    exitCode?: number; // Exit code of the command
    signal?: string; // Termination signal if killed
    duration?: number; // Execution time in milliseconds
    
    // Environment
    environment?: Record<string, string>; // Environment variables
    containerId?: string; // For container exec
    instanceId?: string; // For cloud exec (ECS, EC2)
    sessionId?: string; // For SSM or other session-based exec
  };
  output?: {
    stdout?: string; // Standard output
    stderr?: string; // Standard error
    combined?: string; // Combined output (if captured together)
    truncated?: boolean; // Was output truncated due to size?
    maxBytes?: number; // Maximum bytes captured
  };
  streaming?: {
    supported: boolean; // Can stream output in real-time?
    websocketUrl?: string; // WebSocket URL for streaming
    streamId?: string; // Stream identifier
  };
  security?: {
    authenticated?: boolean; // Was authentication required?
    authorization?: string; // Authorization method used
    sudoRequired?: boolean; // Did command require sudo?
    audit?: boolean; // Was execution audited/logged?
  };
  error?: string;
  metadata?: Record<string, any>;
}

// Service interface - will grow with each migration phase
export interface Service {
  readonly name: ServiceName;
  readonly deployment: DeploymentType;
  
  start(): Promise<StartResult>;
  stop(): Promise<StopResult>;
  check(): Promise<CheckResult>;
  update(): Promise<UpdateResult>;
  provision(): Promise<ProvisionResult>;
  publish(): Promise<PublishResult>;
  backup(): Promise<BackupResult>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  test(options?: TestOptions): Promise<TestResult>;
  restore(backupId: string, options?: RestoreOptions): Promise<RestoreResult>;
}

// Options for exec command
export interface ExecOptions {
  workingDirectory?: string;
  user?: string;
  shell?: string;
  interactive?: boolean;
  tty?: boolean;
  env?: Record<string, string>;
  timeout?: number;
  captureOutput?: boolean;
  stream?: boolean;
}

export interface TestResult {
  service: ServiceName;
  deployment: DeploymentType;
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
    parallel?: boolean; // Were tests run in parallel?
    workers?: number; // Number of parallel workers
    seed?: string; // Random seed for test ordering
  };
  error?: string;
  metadata?: Record<string, any>;
}

// Options for test command
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

export interface RestoreResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  restoreTime: Date;
  backupId: string; // ID of backup that was restored
  restore?: {
    // Restoration details
    source?: string; // Source location of backup
    destination?: string; // Where data was restored to
    size?: number; // Size of restored data
    duration?: number; // Time taken to restore (ms)
    
    // What was restored
    database?: {
      tables?: number; // Number of tables restored
      records?: number; // Number of records restored
      schemas?: boolean; // Were schemas restored?
      indexes?: boolean; // Were indexes rebuilt?
      constraints?: boolean; // Were constraints restored?
    };
    filesystem?: {
      files?: number; // Number of files restored
      directories?: number; // Number of directories
      permissions?: boolean; // Were permissions preserved?
      symlinks?: boolean; // Were symlinks preserved?
    };
    configuration?: {
      envFiles?: string[]; // Environment files restored
      configFiles?: string[]; // Config files restored
      secrets?: boolean; // Were secrets restored?
    };
    application?: {
      version?: string; // Application version restored
      state?: boolean; // Was application state restored?
      cache?: boolean; // Was cache restored?
    };
  };
  validation?: {
    // Post-restore validation
    checksumVerified?: boolean; // Was integrity verified?
    dataComplete?: boolean; // Is all data present?
    servicesRestarted?: boolean; // Were services restarted?
    healthCheck?: boolean; // Did health check pass?
    testsPassed?: boolean; // Did smoke tests pass?
  };
  rollback?: {
    // Rollback information
    supported: boolean; // Can we rollback this restore?
    previousBackupId?: string; // Previous backup before restore
    command?: string; // Command to rollback
  };
  downtime?: {
    // Service downtime during restore
    start?: Date; // When service was stopped
    end?: Date; // When service was restarted
    duration?: number; // Total downtime in ms
    planned?: boolean; // Was this planned downtime?
  };
  warnings?: string[]; // Any warnings during restore
  error?: string;
  metadata?: Record<string, any>;
}

// Options for restore command
export interface RestoreOptions {
  force?: boolean; // Force restore even if service is running
  validate?: boolean; // Validate backup before restoring
  stopService?: boolean; // Stop service before restore
  startService?: boolean; // Start service after restore
  verifyChecksum?: boolean; // Verify backup integrity
  skipTests?: boolean; // Skip post-restore tests
  targetPath?: string; // Custom restore path
  dryRun?: boolean; // Simulate restore without changes
}