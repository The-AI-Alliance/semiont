#!/usr/bin/env node

/**
 * Release Script - Step 1: Verify and Publish
 *
 * This step:
 * 1. Verifies version sync
 * 2. Triggers stable release workflows
 * 3. Outputs the command to run step 2
 *
 * Usage:
 *   npm run release:step1
 *   npm run release:step1 patch   # Specify bump type for step 3
 *   npm run release:step1 -- --dry-run
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';

const DRY_RUN = process.argv.includes('--dry-run');
let bumpType = process.argv.find(arg => ['patch', 'minor', 'major'].includes(arg));

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

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number);
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Invalid bump type: ${type}`);
  }
}

async function askBumpType() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    console.log('\nWhat type of version bump for the next development cycle?');
    console.log('  1) patch (0.2.1 → 0.2.2) - Bug fixes and minor updates');
    console.log('  2) minor (0.2.1 → 0.3.0) - New features, backward compatible');
    console.log('  3) major (0.2.1 → 1.0.0) - Breaking changes');

    rl.question('\nEnter choice (1/2/3) or type (patch/minor/major): ', (answer) => {
      rl.close();

      const normalized = answer.trim().toLowerCase();
      if (normalized === '1' || normalized === 'patch') {
        resolve('patch');
      } else if (normalized === '2' || normalized === 'minor') {
        resolve('minor');
      } else if (normalized === '3' || normalized === 'major') {
        resolve('major');
      } else {
        console.error('Invalid choice. Defaulting to patch.');
        resolve('patch');
      }
    });
  });
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
  console.log('║         Semiont Release - Step 1: Verify & Publish            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN MODE - No changes will be made\n');
  }

  // Get current version and determine bump type
  const currentVersion = getCurrentVersion();
  console.log(`\nCurrent version: ${currentVersion}`);

  if (!bumpType) {
    bumpType = await askBumpType();
  }

  const nextVersion = bumpVersion(currentVersion, bumpType);

  // Confirm with user
  console.log('\n⚠️  This step will:');
  console.log(`   1. Verify version sync across all packages`);
  console.log(`   2. Trigger stable release workflows for ${currentVersion}`);
  console.log(`   3. Provide command to monitor workflows (step 2)`);
  console.log(`\nAfter workflows complete, you will bump to ${nextVersion} (${bumpType})`);

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
    'publish-api-client.yml',
    'publish-core.yml',
    'publish-cli.yml',
    'publish-backend.yml',
    'publish-frontend.yml',
  ];

  const workflowNames = {
    'publish-api-client.yml': '@semiont/api-client (npm)',
    'publish-core.yml': '@semiont/core (npm)',
    'publish-cli.yml': '@semiont/cli (npm)',
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
  console.log('✅ STEP 1 COMPLETE');
  console.log('='.repeat(70));

  console.log('\n📋 Summary:');
  console.log(`   • Version to publish: ${currentVersion}`);
  console.log(`   • Workflows triggered: ${workflows.length}`);
  console.log(`   • Next bump type: ${bumpType}`);
  console.log(`   • Next version: ${nextVersion}`);

  console.log('\n🔗 Monitor progress:');
  console.log('   https://github.com/The-AI-Alliance/semiont/actions');

  console.log('\n📝 NEXT STEP:');
  console.log('   Run this command to monitor workflows and continue when ready:\n');
  if (runIds.length > 0) {
    console.log(`   npm run release:step2 ${runIds.join(' ')} ${bumpType}\n`);
  } else {
    console.log(`   npm run release:step2 ${bumpType}\n`);
    console.log('   (Run IDs will be auto-detected)');
  }

  if (DRY_RUN) {
    console.log('\n⚠️  This was a DRY RUN - no changes were made');
  }
}

main().catch((error) => {
  console.error('\n❌ Step 1 failed:', error.message);
  process.exit(1);
});
