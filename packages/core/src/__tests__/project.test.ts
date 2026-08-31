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
import { SemiontProject, SemiontState } from '../project';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'semiont-project-test-'));
}

describe('SemiontState — the half that needs no KB root', () => {
  // SINGLE-KB-MOUNT P5 leaves the gateway with no readable KB root while it
  // still legitimately needs the state paths. That is not a project with
  // fields missing, it is a smaller thing: a KB's state tree, addressed by
  // name. Split rather than made optional, so "needs a working tree" stays a
  // COMPILE-time fact — passing a SemiontState where a SemiontProject is
  // required is a type error, not a throw inside some later read.
  const state = new SemiontState({ name: 'kb-under-test' });

  it('resolves every name-derived path with no KB root in sight', () => {
    expect(state.name).toBe('kb-under-test');
    expect(state.stateDir).toContain('semiont/kb-under-test');
    expect(state.resourcesDir).toBe(join(state.stateDir, 'resources'));
    expect(state.projectionsDir).toBe(join(state.stateDir, 'projections'));
    expect(state.jobsDir).toBe(join(state.stateDir, 'jobs'));
    expect(state.gatewayPidFile).toBe(join(state.runtimeDir, 'gateway.pid'));
  });

  it('takes NOTHING but the name — every path here derives from it', () => {
    // SINGLE-KB-MOUNT P6 moved `anchoredTextDir` to SemiontProject: it is a
    // SUPPLIED path rather than a derived one, and the gateway — the reason
    // this type exists — neither mounts the store nor reads it. Requiring it
    // here would have made the one consumer that cannot supply it supply it
    // anyway, which is the shape this split exists to avoid.
    expect(Object.keys(state)).not.toContain('anchoredTextDir');
  });

  it('has no working-tree surface at all', () => {
    // The point of the split: these are absent from the TYPE, so a consumer
    // that needs them cannot be handed a SemiontState by mistake.
    expect('root' in state).toBe(false);
    expect('eventsDir' in state).toBe(false);
    expect('gitSync' in state).toBe(false);
  });
});

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

      const project = new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` });
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

      const project = new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` });
      expect(project.gitBranch()).toBe('feature-xyz');
    });

    it('returns null for a non-git directory', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);

      const project = new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` });
      expect(project.gitBranch()).toBeNull();
    });
  });

  describe('name', () => {
    it('reads name from .semiont/config', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(join(dir, '.semiont', 'config'), '[project]\nname = "my-kb"\n');

      const project = new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` });
      expect(project.name).toBe('my-kb');
    });

    it('falls back to directory basename', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);

      const project = new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` });
      expect(project.name).toBe(dir.split('/').pop());
    });
  });

  describe('gitSync', () => {
    it('returns true when [git] sync = true', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(join(dir, '.semiont', 'config'), '[project]\nname = "test"\n\n[git]\nsync = true\n');

      const project = new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` });
      expect(project.gitSync).toBe(true);
    });

    it('returns false when absent', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(join(dir, '.semiont', 'config'), '[project]\nname = "test"\n');

      const project = new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` });
      expect(project.gitSync).toBe(false);
    });
  });

  /**
   * `[site] domain` is the KB's PERMANENT identity literal — the string the
   * launcher turns into `did:web:<domain>` and calls "the permanent identity
   * in the committed event log" (KB-IDENTITY-VS-ADDRESS.md). It is read from
   * the committed `.semiont/config` and from nowhere else: the environment
   * config's `site` section can override it in `EnvironmentConfig`, which
   * would make the gateway report an identity the launcher never minted.
   * Identity must be declared, never defaulted.
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

      expect(new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` }).siteDomain()).toBe('the-ai-alliance.github.io:semiont-caselaw-kb');
    });

    it('returns undefined when [site] declares no domain — never a default', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(
        join(dir, '.semiont', 'config'),
        '[project]\nname = "test"\n\n[site]\nsiteName = "Nameless"\n',
      );

      expect(new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` }).siteDomain()).toBeUndefined();
    });

    it('returns undefined when there is no [site] section, and when there is no config at all', async () => {
      const withConfig = await makeTempDir();
      dirs.push(withConfig);
      await fs.mkdir(join(withConfig, '.semiont'), { recursive: true });
      await fs.writeFile(join(withConfig, '.semiont', 'config'), '[project]\nname = "test"\n');
      expect(new SemiontProject(withConfig, { anchoredTextDir: `${withConfig}/anchored-text` }).siteDomain()).toBeUndefined();

      const bare = await makeTempDir();
      dirs.push(bare);
      expect(new SemiontProject(bare, { anchoredTextDir: `${bare}/anchored-text` }).siteDomain()).toBeUndefined();
    });

    it('is section-aware: a `domain` key in another section is not the site domain', async () => {
      const dir = await makeTempDir();
      dirs.push(dir);
      await fs.mkdir(join(dir, '.semiont'), { recursive: true });
      await fs.writeFile(
        join(dir, '.semiont', 'config'),
        '[project]\nname = "test"\ndomain = "not-the-site-domain"\n\n[git]\nsync = true\n',
      );

      expect(new SemiontProject(dir, { anchoredTextDir: `${dir}/anchored-text` }).siteDomain()).toBeUndefined();
    });
  });
});
