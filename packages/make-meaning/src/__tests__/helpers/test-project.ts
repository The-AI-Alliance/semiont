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
 *   // project.root, project.stateDir, project.eventsDir, etc.
 *   await teardown();  // in afterEach
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { SemiontProject } from '@semiont/core/node';
import type { Roster } from '../../archivist/agent-roster';

/** A knowledge base no agent serves. */
export const NO_AGENTS: Roster = { workers: {}, actors: {} };

/** What a test composes an Archivist with: a full boot, and staging's deployed bounds. */
export const COMPOSE_OPTIONS = { skipRebuild: false, staging: { flushMs: 250, maxWaitMs: 2_000 } };

export interface TestProject {
  project: SemiontProject;
  teardown: () => Promise<void>;
}

export async function createTestProject(nameHint: string = 'test'): Promise<TestProject> {
  const root = join(tmpdir(), `semiont-${nameHint}-${uuidv4()}`);
  await fs.mkdir(join(root, '.semiont'), { recursive: true });
  await fs.writeFile(
    join(root, '.semiont', 'config'),
    `[project]\nname = "${nameHint}"\n`
  );

  const originalXdgState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, 'state');

  const project = new SemiontProject(root, { anchoredTextDir: `${root}/anchored-text` });

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

/** The identity `declareTestKb` gives a knowledge base. */
export const TEST_KB_DOMAIN = 'example.org:test-kb';

/**
 * Writes the committed `.semiont/config` of the knowledge base at `root`,
 * declaring its `[site] domain`. The Archivist refuses a knowledge base
 * that declares none.
 */
export async function declareTestKb(root: string): Promise<void> {
  await fs.mkdir(join(root, '.semiont'), { recursive: true });
  await fs.writeFile(join(root, '.semiont', 'config'), `[site]\ndomain = "${TEST_KB_DOMAIN}"\n`);
}
