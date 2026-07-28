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

  /**
   * `[site] domain` is the KB's PERMANENT identity literal — the string the
   * launcher turns into `did:web:<domain>` and calls "the permanent identity
   * in the committed event log" (KB-IDENTITY-VS-ADDRESS.md). It is read from
   * the committed `.semiont/config` and from nowhere else: the environment
   * config's `site` section can override it in `EnvironmentConfig`, and the
   * TOML loader defaults a domain-less `[site]` to the string `'localhost'`
   * — either would make the backend report an identity the launcher never
   * minted, or (worse) hand every domain-less KB on a machine the SAME
   * fabricated `did:web:localhost`. Identity must be declared, never
   * defaulted.
   */
  describe('siteDomain()', () => {
    it('returns the declared [site] domain, colon-path form preserved verbatim', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(
        join(dir, '.semiont', 'config'),
        '[project]\nname = "caselaw"\n\n[site]\ndomain = "the-ai-alliance.github.io:semiont-caselaw-kb"\nsiteName = "Caselaw Knowledge Base"\n',
      );

      expect(new SemiontProject(dir).siteDomain()).toBe('the-ai-alliance.github.io:semiont-caselaw-kb');
    });

    it('returns undefined when [site] declares no domain — never a default', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(
        join(dir, '.semiont', 'config'),
        '[project]\nname = "test"\n\n[site]\nsiteName = "Nameless"\n',
      );

      expect(new SemiontProject(dir).siteDomain()).toBeUndefined();
    });

    it('returns undefined when there is no [site] section, and when there is no config at all', async () => {
      const withConfig = await makeTempDir();
      dirs.push(withConfig);
      await fs.mkdir(join(withConfig, '.semiont'), { recursive: true });
      await fs.writeFile(join(withConfig, '.semiont', 'config'), '[project]\nname = "test"\n');
      expect(new SemiontProject(withConfig).siteDomain()).toBeUndefined();

      const bare = await makeTempDir();
      dirs.push(bare);
      expect(new SemiontProject(bare).siteDomain()).toBeUndefined();
    });

    it('is section-aware: a `domain` key in another section is not the site domain', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(
        join(dir, '.semiont', 'config'),
        '[project]\nname = "test"\ndomain = "not-the-site-domain"\n\n[git]\nsync = true\n',
      );

      expect(new SemiontProject(dir).siteDomain()).toBeUndefined();
    });
  });
});
