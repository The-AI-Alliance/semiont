/**
 * Test project scaffolding for make-meaning tests.
 *
 * Creates a fully isolated temporary Semiont project for each test:
 *   - Unique temp directory with .semiont/config (project name)
 *   - XDG_STATE_HOME pointed inside the temp dir so stateDir is local
 *   - project.destroy() in afterEach cleans up everything
 *
 * Usage:
 *   const project = await createTestProject();
 *   // project.root, project.stateDir, project.dataDir, etc.
 *   await project.destroy();  // in afterEach
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SemiontProject } from '@semiont/core';

export interface TestProject extends SemiontProject {
  /** Restore XDG_STATE_HOME to its original value */
  teardown(): Promise<void>;
}

/**
 * Create a temporary isolated Semiont project for testing.
 *
 * Sets XDG_STATE_HOME to inside the temp dir so the stateDir
 * (projections, job queue) is fully contained and cleaned up with destroy().
 */
export async function createTestProject(nameHint: string = 'test'): Promise<TestProject> {
  const root = join(tmpdir(), `semiont-${nameHint}-${Date.now()}`);
  await fs.mkdir(join(root, '.semiont'), { recursive: true });
  await fs.writeFile(
    join(root, '.semiont', 'config'),
    `[project]\nname = "${nameHint}"\n`
  );

  // Redirect XDG_STATE_HOME into the temp dir so stateDir is local
  const originalXdgState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, 'state');

  const project = new SemiontProject(root) as TestProject;

  project.teardown = async () => {
    // Restore env var before rm so any parallel tests aren't affected
    if (originalXdgState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalXdgState;
    }
    await fs.rm(root, { recursive: true, force: true });
  };

  return project;
}
