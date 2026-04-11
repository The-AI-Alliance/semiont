/**
 * SemiontProject tests
 *
 * Tests project name reading, git sync flag, and git branch detection.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { SemiontProject } from '../project';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'semiont-project-test-'));
}

describe('SemiontProject', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  describe('gitBranch()', () => {
    it('returns the current branch in a git repo', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);

      // Init a git repo with a commit so HEAD exists
      execFileSync('git', ['init', dir], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(join(dir, '.semiont', 'config'), '[project]\nname = "test"\n');
      execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '-m', 'init', '--allow-empty'], { stdio: 'ignore' });

      const project = new SemiontProject(dir);
      const branch = project.gitBranch();
      expect(branch).toBeTruthy();
      expect(typeof branch).toBe('string');
    });

    it('returns the correct branch name after checkout', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);

      execFileSync('git', ['init', dir], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'checkout', '-b', 'feature-xyz'], { stdio: 'ignore' });

      const project = new SemiontProject(dir);
      expect(project.gitBranch()).toBe('feature-xyz');
    });

    it('returns null for a non-git directory', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);

      const project = new SemiontProject(dir);
      expect(project.gitBranch()).toBeNull();
    });
  });

  describe('name', () => {
    it('reads name from .semiont/config', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(join(dir, '.semiont', 'config'), '[project]\nname = "my-kb"\n');

      const project = new SemiontProject(dir);
      expect(project.name).toBe('my-kb');
    });

    it('falls back to directory basename', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);

      const project = new SemiontProject(dir);
      expect(project.name).toBe(dir.split('/').pop());
    });
  });

  describe('gitSync', () => {
    it('returns true when [git] sync = true', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(join(dir, '.semiont', 'config'), '[project]\nname = "test"\n\n[git]\nsync = true\n');

      const project = new SemiontProject(dir);
      expect(project.gitSync).toBe(true);
    });

    it('returns false when absent', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(join(dir, '.semiont', 'config'), '[project]\nname = "test"\n');

      const project = new SemiontProject(dir);
      expect(project.gitSync).toBe(false);
    });
  });
});
