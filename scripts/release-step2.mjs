#!/usr/bin/env node

/**
 * Release Script - Step 2: Monitor Workflows
 *
 * This step monitors the stable release workflows triggered in step 1
 * and outputs the command to run step 3 when complete.
 *
 * Usage:
 *   npm run release:step2 <runId1> <runId2> ... <bumpType>
 *   npm run release:step2 patch  # Auto-detect run IDs
 *   npm run release:step2        # Auto-detect run IDs and ask for bump type
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';

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

async function getLatestWorkflowRuns() {
  const workflows = [
    'publish-api-client.yml',
    'publish-core.yml',
    'publish-cli.yml',
    'publish-backend.yml',
    'publish-frontend.yml',
  ];

  const runIds = [];
  console.log('\n📋 Auto-detecting latest workflow runs...\n');

  for (const workflow of workflows) {
    try {
      const runsJson = execSync(
        `gh run list --workflow=${workflow} --limit=1 --json databaseId,status`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      const runs = JSON.parse(runsJson);
      if (runs.length > 0) {
        const runId = runs[0].databaseId;
        runIds.push({ workflow, runId });
        console.log(`  • ${workflow}: ${runId}`);
      }
    } catch (error) {
      console.warn(`  ⚠️  Could not get run ID for ${workflow}`);
    }
  }

  return runIds;
}

async function watchWorkflow(runId, workflowName) {
  console.log(`\n⏳ Watching ${workflowName} (run ${runId})...`);
  console.log(`   URL: https://github.com/The-AI-Alliance/semiont/actions/runs/${runId}`);

  try {
    execSync(`gh run watch ${runId} --exit-status`, {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 1800000 // 30 minute timeout per workflow
    });
    console.log(`  ✓ ${workflowName} completed successfully`);
    return true;
  } catch (error) {
    if (error.status === 1) {
      console.error(`  ✗ ${workflowName} failed`);
      return false;
    } else if (error.signal === 'SIGTERM') {
      console.log(`  ⚠️  Timeout waiting for ${workflowName}`);
      return false;
    } else {
      throw error;
    }
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         Semiont Release - Step 2: Monitor Workflows           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const currentVersion = getCurrentVersion();
  console.log(`\nCurrent version: ${currentVersion}`);

  // Parse arguments
  const args = process.argv.slice(2);
  let bumpType = args.find(arg => ['patch', 'minor', 'major'].includes(arg));
  const providedRunIds = args.filter(arg => /^\d+$/.test(arg));

  let runInfos;
  if (providedRunIds.length > 0) {
    // Use provided run IDs
    console.log(`\n📋 Using ${providedRunIds.length} provided run ID(s)`);
    runInfos = providedRunIds.map(id => ({
      workflow: `run-${id}`,
      runId: parseInt(id)
    }));
  } else {
    // Auto-detect latest runs
    runInfos = await getLatestWorkflowRuns();
  }

  if (runInfos.length === 0) {
    console.error('\n❌ No workflow runs found. Did step 1 complete successfully?');
    process.exit(1);
  }

  // Get bump type if not provided
  if (!bumpType) {
    bumpType = await askBumpType();
  }

  const nextVersion = bumpVersion(currentVersion, bumpType);

  console.log('\n' + '='.repeat(70));
  console.log('MONITORING WORKFLOWS');
  console.log('='.repeat(70));
  console.log('\n⏳ Watching workflows until completion...');
  console.log('   (This may take 10-20 minutes for container builds)');
  console.log('   (You can Ctrl+C to exit - workflows will continue running)\n');

  let allSucceeded = true;
  for (const { workflow, runId } of runInfos) {
    const succeeded = await watchWorkflow(runId, workflow);
    if (!succeeded) {
      allSucceeded = false;
    }
  }

  console.log('\n' + '='.repeat(70));

  if (!allSucceeded) {
    console.log('❌ SOME WORKFLOWS FAILED');
    console.log('='.repeat(70));
    console.log('\n⚠️  One or more workflows failed. Check the logs:');
    console.log('   https://github.com/The-AI-Alliance/semiont/actions');
    console.log('\n   Fix the issues and re-run failed workflows, then run step 2 again.');
    process.exit(1);
  }

  console.log('✅ ALL WORKFLOWS COMPLETE');
  console.log('='.repeat(70));

  console.log('\n📋 Summary:');
  console.log(`   • Stable release published: ${currentVersion}`);
  console.log(`   • Workflows completed: ${runInfos.length}`);
  console.log(`   • Next bump type: ${bumpType}`);
  console.log(`   • Next version: ${nextVersion}`);

  console.log('\n🔗 Published artifacts:');
  console.log('   • npm: https://www.npmjs.com/settings/semiont/packages');
  console.log('   • containers: https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont');

  console.log('\n📝 NEXT STEP:');
  console.log('   Run this command to bump version and commit:\n');
  console.log(`   npm run release:step3 ${bumpType}\n`);
}

main().catch((error) => {
  console.error('\n❌ Step 2 failed:', error.message);
  process.exit(1);
});
