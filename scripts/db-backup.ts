#!/usr/bin/env -S npx tsx

import { RDSClient, DescribeDBInstancesCommand, CreateDBSnapshotCommand } from '@aws-sdk/client-rds';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
// SemiontStackConfig reserved for future use
import { config } from '../config/dist/index.js';

// Reserved for future stack configuration needs
const rdsClient = new RDSClient({ region: config.aws.region });
const cfnClient = new CloudFormationClient({ region: config.aws.region });

async function findSemiontDatabase() {
  try {
    // Get database endpoint from CloudFormation stack
    const stackResponse = await cfnClient.send(
      new DescribeStacksCommand({
        StackName: 'SemiontInfraStack'
      })
    );

    const outputs = stackResponse.Stacks?.[0]?.Outputs || [];
    const dbEndpoint = outputs.find(output => output.OutputKey === 'DatabaseEndpoint')?.OutputValue;

    if (!dbEndpoint) {
      throw new Error('Database endpoint not found in CloudFormation outputs');
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
    console.error('Failed to find Semiont database via CloudFormation. Falling back to name-based search...');
    
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

    return {
      identifier: semiontDB.DBInstanceIdentifier!,
      engine: semiontDB.Engine,
      status: semiontDB.DBInstanceStatus,
      endpoint: semiontDB.Endpoint?.Address,
    };
  }
}

async function createBackup(backupName?: string) {
  console.log('💾 Creating Semiont database backup...');

  try {
    // Find the database
    const database = await findSemiontDatabase();
    console.log(`📊 Database: ${database.identifier}`);
    console.log(`   Engine: ${database.engine}`);
    console.log(`   Status: ${database.status}`);
    console.log(`   Endpoint: ${database.endpoint}`);

    if (database.status !== 'available') {
      console.log('⚠️  Warning: Database is not in "available" status. Backup may fail.');
    }

    // Generate backup name if not provided
    const snapshotName = backupName || `semiont-${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}`;
    
    console.log(`📸 Creating snapshot: ${snapshotName}`);

    // Create snapshot
    const response = await rdsClient.send(
      new CreateDBSnapshotCommand({
        DBInstanceIdentifier: database.identifier,
        DBSnapshotIdentifier: snapshotName,
      })
    );

    console.log('✅ Backup initiated successfully');
    console.log(`📋 Snapshot ID: ${response.DBSnapshot?.DBSnapshotIdentifier}`);
    console.log('⏱️  This will take several minutes to complete');
    console.log('');
    console.log('💡 Monitor progress with:');
    console.log(`   aws rds describe-db-snapshots --db-snapshot-identifier ${snapshotName} --region ${config.aws.region}`);
    console.log('');
    console.log('🔍 View all snapshots:');
    console.log(`   aws rds describe-db-snapshots --db-instance-identifier ${database.identifier} --region ${config.aws.region}`);

  } catch (error: any) {
    if (error.name === 'DBSnapshotAlreadyExistsException') {
      console.error('❌ A snapshot with that name already exists');
      console.log('💡 Try with a different name:');
      console.log(`   ./scripts/semiont backup "semiont-$(date +%Y%m%d-%H%M%S)"`);
    } else {
      console.error('❌ Failed to create backup:', error.message);
    }
    process.exit(1);
  }
}

async function main() {
  const backupName = process.argv[2];
  
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('💾 Semiont Database Backup Tool');
    console.log('');
    console.log('Usage: npx tsx db-backup.ts [backup-name]');
    console.log('   or: ./scripts/semiont backup [backup-name]');
    console.log('');
    console.log('Examples:');
    console.log('   ./scripts/semiont backup                           # Auto-generated timestamp name');
    console.log('   ./scripts/semiont backup "pre-upgrade-20250127"    # Custom name');
    console.log('   ./scripts/semiont backup "before-oauth-changes"    # Descriptive name');
    console.log('');
    console.log('Notes:');
    console.log('   • Backup names must be unique');
    console.log('   • Snapshots are retained until manually deleted');
    console.log('   • Backup process typically takes 5-15 minutes');
    console.log('   • Database remains available during backup');
    return;
  }

  await createBackup(backupName);
}

main().catch(console.error);