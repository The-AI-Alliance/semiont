/**
 * Database Backup Command V2 - AWS RDS backup management for Semiont
 * 
 * Creates automated database snapshots for deployed environments
 * 
 * Usage:
 *   semiont backup -e production                        # Auto timestamp name
 *   semiont backup -e staging --name "pre-upgrade"     # Custom name
 *   semiont backup -e production --name "before-migration" --verbose
 */

import { z } from 'zod';
import { RDSClient, DescribeDBInstancesCommand, CreateDBSnapshotCommand } from '@aws-sdk/client-rds';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { loadEnvironmentConfig } from '@semiont/config-loader';
import { getAvailableEnvironments, isValidEnvironment } from '../lib/environment-discovery.js';
import { SemiontStackConfig } from '../lib/stack-config.js';

// =====================================================================
// ARGUMENT PARSING WITH ZOD
// =====================================================================

const BackupOptionsSchema = z.object({
  environment: z.string(),
  name: z.string().optional(),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type BackupOptions = z.infer<typeof BackupOptionsSchema>;

// =====================================================================
// TYPES
// =====================================================================

interface DatabaseInfo {
  identifier: string;
  engine?: string;
  status?: string;
  endpoint?: string;
}

// =====================================================================
// ARGUMENT PARSING
// =====================================================================

function parseArgs(): BackupOptions {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Parse flags
  let environment: string | undefined;
  let name: string | undefined;
  let verbose = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--environment' || arg === '-e') {
      environment = args[i + 1];
      i++; // Skip next arg
    } else if (arg === '--name' || arg === '-n') {
      name = args[i + 1];
      i++; // Skip next arg
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (!environment) {
    console.error('❌ --environment is required');
    console.log(`💡 Available environments: ${getAvailableEnvironments().join(', ')}`);
    process.exit(1);
  }

  if (!isValidEnvironment(environment)) {
    console.error(`❌ Invalid environment: ${environment}`);
    console.log(`💡 Available environments: ${getAvailableEnvironments().join(', ')}`);
    process.exit(1);
  }

  try {
    return BackupOptionsSchema.parse({
      environment,
      name,
      verbose,
      dryRun,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid arguments:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

function printHelp(): void {
  console.log(`
💾 Semiont Database Backup Tool

Usage:
  semiont backup --environment <env> [options]

Options:
  -e, --environment <env>    Environment to backup (required)
  -n, --name <name>         Custom backup name (optional)
  -v, --verbose             Show detailed output
  --dry-run                 Show what would be done without creating backup
  -h, --help                Show this help message

Examples:
  # Auto-generated timestamp name
  semiont backup -e production

  # Custom descriptive name  
  semiont backup -e staging --name "pre-upgrade-20250127"
  
  # Before major changes
  semiont backup -e production --name "before-oauth-migration" --verbose
  
  # Test what would happen
  semiont backup -e staging --name "test-backup" --dry-run

Available Environments:
  ${getAvailableEnvironments().join(', ')}

Notes:
  • Backup names must be unique across your AWS account
  • Snapshots are retained until manually deleted
  • Backup process typically takes 5-15 minutes
  • Database remains available during backup
  • Requires AWS credentials with RDS snapshot permissions

Requirements:
  • AWS CLI configured
  • Valid environment configuration with AWS settings
  • IAM permissions for RDS snapshots and CloudFormation describe
`);
}

// =====================================================================
// DATABASE DISCOVERY
// =====================================================================

async function findSemiontDatabase(
  stackConfig: SemiontStackConfig, 
  rdsClient: RDSClient, 
  cfnClient: CloudFormationClient,
  verbose: boolean = false
): Promise<DatabaseInfo> {
  try {
    if (verbose) {
      console.log('🔍 Finding database via CloudFormation stack...');
    }
    
    // Get database endpoint from CloudFormation stack
    const infraStackName = await stackConfig.getInfraStackName();
    const stackResponse = await cfnClient.send(
      new DescribeStacksCommand({
        StackName: infraStackName
      })
    );

    const outputs = stackResponse.Stacks?.[0]?.Outputs || [];
    const dbEndpoint = outputs.find(output => output.OutputKey === 'DatabaseEndpoint')?.OutputValue;

    if (!dbEndpoint) {
      throw new Error('Database endpoint not found in CloudFormation outputs');
    }

    if (verbose) {
      console.log(`📡 Found database endpoint in stack: ${dbEndpoint}`);
    }

    // Get database instance details
    const response = await rdsClient.send(
      new DescribeDBInstancesCommand({})
    );

    const semiontDB = response.DBInstances?.find(db => 
      db.Endpoint?.Address === dbEndpoint
    );

    if (!semiontDB) {
      throw new Error('No Semiont database instance found matching CloudFormation endpoint');
    }

    return {
      identifier: semiontDB.DBInstanceIdentifier!,
      engine: semiontDB.Engine,
      status: semiontDB.DBInstanceStatus,
      endpoint: semiontDB.Endpoint?.Address,
    };
    
  } catch (error: any) {
    if (verbose) {
      console.log('⚠️  CloudFormation lookup failed, trying name-based search...');
      console.log(`   Error: ${error.message}`);
    }
    
    // Fallback: search by identifier patterns
    const response = await rdsClient.send(
      new DescribeDBInstancesCommand({})
    );

    const semiontDB = response.DBInstances?.find(db => 
      db.DBInstanceIdentifier?.toLowerCase().includes('semiont') || 
      db.DBName === 'semiont'
    );

    if (!semiontDB) {
      throw new Error('No Semiont database found. Please check your infrastructure deployment.');
    }

    if (verbose) {
      console.log(`📊 Found database via name search: ${semiontDB.DBInstanceIdentifier}`);
    }

    return {
      identifier: semiontDB.DBInstanceIdentifier!,
      engine: semiontDB.Engine,
      status: semiontDB.DBInstanceStatus,
      endpoint: semiontDB.Endpoint?.Address,
    };
  }
}

// =====================================================================
// BACKUP OPERATIONS
// =====================================================================

async function createBackup(options: BackupOptions): Promise<void> {
  const { environment, name, verbose, dryRun } = options;
  
  if (verbose) {
    console.log('🔧 Backup options:', options);
  }
  
  const config = loadEnvironmentConfig(environment);
  
  if (!config.aws) {
    throw new Error(`Environment ${environment} does not have AWS configuration`);
  }
  
  if (verbose) {
    console.log(`🌍 Using AWS region: ${config.aws.region}`);
  }
  
  const stackConfig = new SemiontStackConfig(environment);
  const rdsClient = new RDSClient({ region: config.aws.region });
  const cfnClient = new CloudFormationClient({ region: config.aws.region });
  
  console.log(`💾 Creating Semiont database backup for ${environment}...`);

  try {
    // Find the database
    const database = await findSemiontDatabase(stackConfig, rdsClient, cfnClient, verbose);
    
    console.log(`📊 Database Information:`);
    console.log(`   Identifier: ${database.identifier}`);
    console.log(`   Engine: ${database.engine || 'Unknown'}`);
    console.log(`   Status: ${database.status || 'Unknown'}`);
    console.log(`   Endpoint: ${database.endpoint || 'Unknown'}`);

    if (database.status !== 'available') {
      console.log(`⚠️  Warning: Database status is "${database.status}" - backup may fail or take longer`);
      if (!dryRun) {
        console.log('   Continuing anyway...');
      }
    }

    // Generate backup name if not provided
    const snapshotName = name || `semiont-${environment}-${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}`;
    
    console.log(`📸 Snapshot name: ${snapshotName}`);

    if (dryRun) {
      console.log('\n🔍 DRY RUN - Would create snapshot with:');
      console.log(`   DB Instance: ${database.identifier}`);
      console.log(`   Snapshot ID: ${snapshotName}`);
      console.log(`   Region: ${config.aws.region}`);
      console.log('\n💡 Use without --dry-run to create the actual backup');
      return;
    }

    // Create snapshot
    if (verbose) {
      console.log('🚀 Sending CreateDBSnapshot request to AWS...');
    }
    
    const response = await rdsClient.send(
      new CreateDBSnapshotCommand({
        DBInstanceIdentifier: database.identifier,
        DBSnapshotIdentifier: snapshotName,
      })
    );

    console.log('\n✅ Backup initiated successfully!');
    console.log(`📋 Snapshot ID: ${response.DBSnapshot?.DBSnapshotIdentifier}`);
    console.log(`📅 Started: ${response.DBSnapshot?.SnapshotCreateTime?.toISOString()}`);
    console.log('⏱️  This will take several minutes to complete...');
    
    console.log('\n💡 Monitor progress with:');
    console.log(`   aws rds describe-db-snapshots --db-snapshot-identifier ${snapshotName} --region ${config.aws.region}`);
    
    console.log('\n🔍 View all snapshots for this database:');
    console.log(`   aws rds describe-db-snapshots --db-instance-identifier ${database.identifier} --region ${config.aws.region}`);
    
    if (verbose) {
      console.log('\n📊 Snapshot details:');
      console.log(`   Engine: ${response.DBSnapshot?.Engine}`);
      console.log(`   Size: ${response.DBSnapshot?.AllocatedStorage} GB`);
      console.log(`   Type: ${response.DBSnapshot?.SnapshotType}`);
      console.log(`   Status: ${response.DBSnapshot?.Status}`);
    }

  } catch (error: any) {
    if (error.name === 'DBSnapshotAlreadyExistsException') {
      console.error('\n❌ A snapshot with that name already exists');
      console.log('💡 Try with a different name:');
      console.log(`   semiont backup -e ${environment} --name "semiont-$(date +%Y%m%d-%H%M%S)"`);
      console.log('💡 Or let the system auto-generate a name:');
      console.log(`   semiont backup -e ${environment}`);
    } else {
      console.error('\n❌ Failed to create backup:', error.message);
      
      if (verbose) {
        console.error('Full error details:', error);
      } else {
        console.log('💡 Use --verbose for more error details');
      }
      
      console.log('\n🔍 Common issues:');
      console.log('   • AWS credentials not configured or expired');
      console.log('   • Insufficient IAM permissions for RDS snapshots');
      console.log('   • Database is not in available state');
      console.log('   • Invalid environment or missing infrastructure');
    }
    process.exit(1);
  }
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  try {
    const options = parseArgs();
    await createBackup(options);
    
  } catch (error) {
    console.error('❌ Backup failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}