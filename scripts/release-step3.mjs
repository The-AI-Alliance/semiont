#!/usr/bin/env node

/**
 * Release Script - Step 3: Bump Version and Commit
 *
 * This step bumps the version for the next development cycle,
 * syncs all package.json files, and commits/pushes to main.
 *
 * Usage:
 *   npm run release:step3 patch
 *   npm run release:step3 minor
 *   npm run release:step3 major
 *   npm run release:step3        # Interactive prompt
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';

function exec(command, description) {
  console.log(`\n→ ${description}`);
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
  console.log('║         Semiont Release - Step 3: Bump & Commit               ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const currentVersion = getCurrentVersion();
  console.log(`\nCurrent version (just released as stable): ${currentVersion}`);

  // Get bump type
  let bumpType = process.argv.find(arg => ['patch', 'minor', 'major'].includes(arg));
  if (!bumpType) {
    bumpType = await askBumpType();
  }

  const nextVersion = bumpVersion(currentVersion, bumpType);

  // Confirm
  console.log('\n⚠️  This step will:');
  console.log(`   1. Bump version from ${currentVersion} to ${nextVersion} (${bumpType})`);
  console.log(`   2. Sync all package.json files`);
  console.log(`   3. Commit and push to main`);
  console.log(`\nNext development builds will be: ${nextVersion}-build.N with 'dev' tag`);

  const confirmed = await confirmAction('\nDo you want to proceed?');
  if (!confirmed) {
    console.log('\n❌ Step 3 cancelled by user');
    process.exit(0);
  }

  // Phase 1: Bump version
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 1: BUMP VERSION');
  console.log('='.repeat(70));

  console.log(`\n🔼 Bumping version from ${currentVersion} to ${nextVersion} (${bumpType})...\n`);

  execInteractive(`npm run version:bump ${bumpType}`, `Bumping to ${nextVersion}`);
  execInteractive('npm run version:sync', 'Syncing all package.json files');
  execInteractive('npm run version:show', 'Verifying version sync');

  // Phase 2: Commit and push
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 2: COMMIT AND PUSH');
  console.log('='.repeat(70));

  exec('git status', 'Checking git status');

  const commitMessage = `bump version to ${nextVersion}

This commit bumps the version after releasing ${currentVersion} as stable.

Version bump type: ${bumpType}
- All package.json files updated to ${nextVersion}
- Next builds will be ${nextVersion}-build.N with dev tag

🤖 Generated with release script`;

  exec(
    `git add version.json packages/*/package.json apps/*/package.json`,
    'Staging version files'
  );

  exec(
    `git commit -m "${commitMessage}"`,
    `Committing version bump to ${nextVersion}`
  );

  exec('git push', 'Pushing to main branch');

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('✅ RELEASE COMPLETE');
  console.log('='.repeat(70));

  console.log(`\n📋 Full release summary:`);
  console.log(`   • Stable release published: ${currentVersion} (tagged as 'latest')`);
  console.log(`   • Version bump type: ${bumpType}`);
  console.log(`   • New development version: ${nextVersion}`);
  console.log(`   • Next builds will be: ${nextVersion}-build.N (tagged as 'dev')`);

  console.log('\n🔗 Published artifacts:');
  console.log(`   • npm: https://www.npmjs.com/settings/semiont/packages`);
  console.log(`   • containers: https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont`);

  console.log('\n🎯 What happens next:');
  console.log(`   • Next push to main will publish ${nextVersion}-build.1 with 'dev' tag`);
  console.log(`   • Users can install stable release: npm install @semiont/core@latest`);
  console.log(`   • Users can install dev builds: npm install @semiont/core@dev`);
}

main().catch((error) => {
  console.error('\n❌ Step 3 failed:', error.message);
  process.exit(1);
});
