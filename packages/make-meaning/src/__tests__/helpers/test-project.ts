/**
 * Test project scaffolding for make-meaning tests.
 *
 * Creates a fully isolated temporary Semiont project for each test:
 *   - Unique temp directory with .semiont/config (project name)
 *   - XDG_STATE_HOME pointed inside the temp dir so stateDir is local
 *   - teardown() restores XDG_STATE_HOME and removes the temp dir
 *
 * Usage:
 *   const { project, teardown } = await createTestProject('my-test');
 *   // project.root, project.stateDir, project.dataDir, etc.
 *   await teardown();  // in afterEach
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SemiontProject } from '@semiont/core';

export interface TestProject {
  project: SemiontProject;
  teardown: () => Promise<void>;
}

export async function createTestProject(nameHint: string = 'test'): Promise<TestProject> {
  const root = join(tmpdir(), `semiont-${nameHint}-${Date.now()}`);
  await fs.mkdir(join(root, '.semiont'), { recursive: true });
  await fs.writeFile(
    join(root, '.semiont', 'config'),
    `[project]\nname = "${nameHint}"\n`
  );

  const originalXdgState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, 'state');

  const project = new SemiontProject(root);

  const teardown = async () => {
    if (originalXdgState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalXdgState;
    }
    await fs.rm(root, { recursive: true, force: true });
  };

  return { project, teardown };
}
