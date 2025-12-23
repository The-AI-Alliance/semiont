#!/usr/bin/env node

/**
 * Release Script - Await: Monitor Workflows
 *
 * This step monitors the stable release workflows triggered by release:publish
 * and outputs the command to bump version when complete.
 *
 * Usage:
 *   npm run release:await <runId1> <runId2> ...
 *   npm run release:await  # Auto-detect run IDs
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function getCurrentVersion() {
  const versionPath = resolve(process.cwd(), 'version.json');
  const versionJson = JSON.parse(readFileSync(versionPath, 'utf-8'));
  return versionJson.version;
}

async function getLatestWorkflowRuns() {
  const workflows = [
    'publish-npm-packages.yml',
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
  console.log('║         Semiont Release - Await: Monitor Workflows            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const currentVersion = getCurrentVersion();
  console.log(`\nCurrent version: ${currentVersion}`);

  // Parse arguments
  const args = process.argv.slice(2);
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
    console.error('\n❌ No workflow runs found. Did release:publish complete successfully?');
    process.exit(1);
  }

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
    console.log('\n   Fix the issues and re-run failed workflows, then run release:await again.');
    process.exit(1);
  }

  console.log('✅ ALL WORKFLOWS COMPLETE');
  console.log('='.repeat(70));

  console.log('\n📋 Summary:');
  console.log(`   • Stable release published: ${currentVersion}`);
  console.log(`   • Workflows completed: ${runInfos.length}`);

  console.log('\n🔗 Published artifacts:');
  console.log('   • npm: https://www.npmjs.com/settings/semiont/packages');
  console.log('   • containers: https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont');

  console.log('\n📝 NEXT STEP:');
  console.log('   Run this command to bump version and commit:\n');
  console.log('   npm run release:bump [patch|minor|major]\n');
  console.log('   Examples:');
  console.log('     npm run release:bump patch   # Bug fixes (0.2.13 → 0.2.14)');
  console.log('     npm run release:bump minor   # New features (0.2.13 → 0.3.0)');
  console.log('     npm run release:bump major   # Breaking changes (0.2.13 → 1.0.0)');
  console.log('     npm run release:bump         # Interactive prompt\n');
}

main().catch((error) => {
  console.error('\n❌ Await failed:', error.message);
  process.exit(1);
});
