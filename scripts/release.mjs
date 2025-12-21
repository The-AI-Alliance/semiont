#!/usr/bin/env node

/**
 * Release Management Script
 *
 * Automates the process of promoting development builds to stable releases
 * and bumping versions for the next development cycle.
 *
 * Usage:
 *   npm run release:stable           # Promote current version, bump patch
 *   npm run release:stable minor     # Promote current version, bump minor
 *   npm run release:stable major     # Promote current version, bump major
 *   npm run release:stable -- --dry-run  # Preview without publishing
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
    console.log('  1) patch (0.2.0 → 0.2.1) - Bug fixes and minor updates');
    console.log('  2) minor (0.2.0 → 0.3.0) - New features, backward compatible');
    console.log('  3) major (0.2.0 → 1.0.0) - Breaking changes');

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

async function waitForWorkflows(workflows) {
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would wait for workflows to complete');
    return;
  }

  console.log('\n⏳ Waiting for workflows to start and complete...');
  console.log('   (You can Ctrl+C to exit - workflows will continue running)');

  // Wait a few seconds for workflows to start
  await new Promise(resolve => setTimeout(resolve, 5000));

  for (const workflow of workflows) {
    const workflowName = workflow.replace('.yml', '');

    try {
      // Get the most recent run of this workflow
      const runsJson = exec(
        `gh run list --workflow=${workflow} --limit=1 --json status,conclusion,databaseId`,
        `Checking status of ${workflowName}`
      );

      if (!runsJson.trim()) {
        console.log(`  ⚠️  No recent runs found for ${workflowName}`);
        continue;
      }

      const runs = JSON.parse(runsJson);
      if (runs.length === 0) {
        console.log(`  ⚠️  No runs found for ${workflowName}`);
        continue;
      }

      const run = runs[0];
      const runId = run.databaseId;

      // Watch the run until it completes
      console.log(`  ⏳ Watching ${workflowName} (run ${runId})...`);

      // Use gh run watch with timeout
      try {
        execSync(`gh run watch ${runId} --exit-status`, {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 1800000 // 30 minute timeout
        });
        console.log(`  ✓ ${workflowName} completed successfully`);
      } catch (error) {
        if (error.status === 1) {
          console.error(`  ✗ ${workflowName} failed`);
          throw new Error(`Workflow ${workflowName} failed. Check: https://github.com/The-AI-Alliance/semiont/actions`);
        } else if (error.signal === 'SIGTERM') {
          console.log(`  ⚠️  Timeout waiting for ${workflowName}`);
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error(`  ✗ Error checking ${workflowName}: ${error.message}`);
      throw error;
    }
  }
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
  console.log('║         Semiont Release Management Script                     ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN MODE - No changes will be made\n');
  }

  // Phase 1: Get current version and determine bump type
  const currentVersion = getCurrentVersion();
  console.log(`\nCurrent version: ${currentVersion}`);

  if (!bumpType) {
    bumpType = await askBumpType();
  }

  const nextVersion = bumpVersion(currentVersion, bumpType);

  // Confirm with user
  console.log('\n⚠️  This release process will:');
  console.log(`   1. Publish ${currentVersion} as stable release (npm: 'latest' tag, containers: 'latest' tag)`);
  console.log(`   2. Wait for all workflows to complete successfully`);
  console.log(`   3. Bump version to ${nextVersion} (${bumpType}) for next development cycle`);
  console.log(`   4. Push changes to main (next builds will be ${nextVersion}-build.N with 'dev' tag)`);

  const confirmed = await confirmAction('\nDo you want to proceed?');
  if (!confirmed) {
    console.log('\n❌ Release cancelled by user');
    process.exit(0);
  }

  // Phase 2: Verify version sync
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 1: VERIFY VERSION SYNC');
  console.log('='.repeat(70));

  execInteractive('npm run version:show', 'Checking version sync status');

  // Phase 3: Publish stable releases
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 2: PUBLISH STABLE RELEASES');
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
  console.log('\nMonitor progress at:');
  console.log('  https://github.com/The-AI-Alliance/semiont/actions');

  // Phase 4: Wait for workflows to complete
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 3: WAITING FOR WORKFLOWS TO COMPLETE');
  console.log('='.repeat(70));

  await waitForWorkflows(workflows);

  console.log('\n✓ All workflows completed successfully!');

  // Phase 5: Bump version
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 4: BUMP VERSION FOR NEXT DEVELOPMENT CYCLE');
  console.log('='.repeat(70));

  console.log(`\n🔼 Bumping version from ${currentVersion} to ${nextVersion} (${bumpType})...\n`);

  execInteractive(`npm run version:bump ${bumpType}`, `Bumping to ${nextVersion}`);
  execInteractive('npm run version:sync', 'Syncing all package.json files');
  execInteractive('npm run version:show', 'Verifying version sync');

  // Phase 6: Commit and push
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 5: COMMIT AND PUSH');
  console.log('='.repeat(70));

  exec('git status', 'Checking git status');

  const commitMessage = `bump version to ${nextVersion}

This commit bumps the version after releasing ${currentVersion} as stable.

Version bump type: ${bumpType}
- All package.json files updated to ${nextVersion}
- Next builds will be ${nextVersion}-build.N with dev tag

🤖 Generated with release script`;

  if (!DRY_RUN) {
    exec(
      `git add version.json packages/*/package.json apps/*/package.json`,
      'Staging version files'
    );

    exec(
      `git commit -m "${commitMessage}"`,
      `Committing version bump to ${nextVersion}`
    );

    exec('git push', 'Pushing to main branch');
  } else {
    console.log(`\n[DRY RUN] Would commit with message:\n${commitMessage}`);
    console.log('\n[DRY RUN] Would push to main');
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('✅ RELEASE COMPLETE');
  console.log('='.repeat(70));

  console.log(`\n📋 Summary:`);
  console.log(`   • Stable release: ${currentVersion} (tagged as 'latest')`);
  console.log(`   • Version bump type: ${bumpType}`);
  console.log(`   • Next dev version: ${nextVersion}-build.N (tagged as 'dev')`);
  console.log('\n🔗 Published artifacts:');
  console.log(`   • npm: https://www.npmjs.com/settings/semiont/packages`);
  console.log(`   • containers: https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont`);
  console.log('\n🎯 Next steps:');
  console.log(`   • Verify stable releases are available`);
  console.log(`   • Next push to main will publish ${nextVersion}-build.1`);

  if (DRY_RUN) {
    console.log('\n⚠️  This was a DRY RUN - no changes were made');
    console.log('   Run without --dry-run to execute for real');
  }
}

main().catch((error) => {
  console.error('\n❌ Release failed:', error.message);
  process.exit(1);
});
