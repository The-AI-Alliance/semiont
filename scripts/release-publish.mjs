#!/usr/bin/env node

/**
 * Release Script - Publish: Verify and Trigger Workflows
 *
 * This step:
 * 1. Verifies version sync
 * 2. Triggers stable release workflows
 * 3. Outputs the command to await workflow completion
 *
 * Usage:
 *   npm run release:publish
 *   npm run release:publish -- --dry-run
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';

const DRY_RUN = process.argv.includes('--dry-run');

function exec(command, description) {
  console.log(`\n→ ${description}`);
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would execute: ${command}`);
    return '';
  }
  try {
    const output = execSync(command, { encoding: 'utf-8', stdio: 'pipe' });
    return output;
  } catch (error) {
    console.error(`✗ Failed: ${error.message}`);
    if (error.stdout) console.log(error.stdout);
    if (error.stderr) console.error(error.stderr);
    throw error;
  }
}

function execInteractive(command, description) {
  console.log(`\n→ ${description}`);
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would execute: ${command}`);
    return;
  }
  try {
    execSync(command, { encoding: 'utf-8', stdio: 'inherit' });
  } catch (error) {
    console.error(`✗ Failed: ${error.message}`);
    throw error;
  }
}

function getCurrentVersion() {
  const versionPath = resolve(process.cwd(), 'version.json');
  const versionJson = JSON.parse(readFileSync(versionPath, 'utf-8'));
  return versionJson.version;
}

async function confirmAction(message) {
  if (DRY_RUN) {
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         Semiont Release - Publish: Trigger Workflows          ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN MODE - No changes will be made\n');
  }

  // Get current version
  const currentVersion = getCurrentVersion();
  console.log(`\nCurrent version: ${currentVersion}`);

  // Confirm with user
  console.log('\n⚠️  This will:');
  console.log(`   1. Verify version sync across all packages`);
  console.log(`   2. Trigger stable release workflows for ${currentVersion}`);
  console.log(`   3. Provide command to await workflow completion`);

  const confirmed = await confirmAction('\nDo you want to proceed?');
  if (!confirmed) {
    console.log('\n❌ Release cancelled by user');
    process.exit(0);
  }

  // Phase 1: Verify version sync
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 1: VERIFY VERSION SYNC');
  console.log('='.repeat(70));

  execInteractive('npm run version:show', 'Checking version sync status');

  // Phase 2: Publish stable releases
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 2: TRIGGER STABLE RELEASE WORKFLOWS');
  console.log('='.repeat(70));

  console.log(`\n📦 Publishing ${currentVersion} as stable release...\n`);

  const workflows = [
    'publish-npm-packages.yml',
    'publish-backend.yml',
    'publish-frontend.yml',
  ];

  const workflowNames = {
    'publish-npm-packages.yml': 'npm packages (api-client, core, cli)',
    'publish-backend.yml': 'semiont-backend (container)',
    'publish-frontend.yml': 'semiont-frontend (container)',
  };

  for (const workflow of workflows) {
    const name = workflowNames[workflow];
    exec(
      `gh workflow run ${workflow} --field stable_release=true`,
      `Triggering stable release for ${name}`
    );
  }

  console.log('\n✓ All stable release workflows triggered!');

  // Wait a moment for workflows to start, then get their run IDs
  if (!DRY_RUN) {
    console.log('\n⏳ Waiting 5 seconds for workflows to start...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  const runIds = [];
  if (!DRY_RUN) {
    console.log('\n📋 Fetching workflow run IDs...\n');
    for (const workflow of workflows) {
      try {
        const runsJson = execSync(
          `gh run list --workflow=${workflow} --limit=1 --json databaseId,status`,
          { encoding: 'utf-8', stdio: 'pipe' }
        );
        const runs = JSON.parse(runsJson);
        if (runs.length > 0) {
          const runId = runs[0].databaseId;
          runIds.push(runId);
          console.log(`  • ${workflow}: ${runId}`);
        }
      } catch (error) {
        console.warn(`  ⚠️  Could not get run ID for ${workflow}`);
      }
    }
  }

  // Output next step command
  console.log('\n' + '='.repeat(70));
  console.log('✅ PUBLISH COMPLETE');
  console.log('='.repeat(70));

  console.log('\n📋 Summary:');
  console.log(`   • Version to publish: ${currentVersion}`);
  console.log(`   • Workflows triggered: ${workflows.length}`);

  console.log('\n🔗 Monitor progress:');
  console.log('   https://github.com/The-AI-Alliance/semiont/actions');

  console.log('\n📝 NEXT STEP:');
  console.log('   Run this command to await workflows and continue when ready:\n');
  if (runIds.length > 0) {
    console.log(`   npm run release:await ${runIds.join(' ')}\n`);
  } else {
    console.log(`   npm run release:await\n`);
    console.log('   (Run IDs will be auto-detected)');
  }

  if (DRY_RUN) {
    console.log('\n⚠️  This was a DRY RUN - no changes were made');
  }
}

main().catch((error) => {
  console.error('\n❌ Publish failed:', error.message);
  process.exit(1);
});
