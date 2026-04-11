import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Represents a Semiont project rooted at a given directory.
 *
 * Computes all paths — durable and ephemeral — once at construction time.
 * XDG environment variables are read here and nowhere else.
 *
 * Durable paths (inside the project root, committed or repo-local):
 *   eventsDir          — .semiont/events/      (system of record, committed)
 *   representationsDir — representations/      (content store, committed)
 *
 * Ephemeral paths (outside the project root, never committed):
 *   configDir      — $XDG_CONFIG_HOME/semiont/{name}/  (generated config for managed processes)
 *   dataHome       — $XDG_DATA_HOME/semiont/{name}/   (persistent user data, e.g. database files)
 *   stateDir        — $XDG_STATE_HOME/semiont/{name}/
 *   projectionsDir  — stateDir/projections/
 *   jobsDir         — stateDir/jobs/
 *   backendLogsDir      — stateDir/backend/
 *   backendAppLogFile   — backendLogsDir/app.log
 *   backendErrorLogFile — backendLogsDir/error.log
 *   runtimeDir      — $XDG_RUNTIME_DIR/semiont/{name}/  (or $TMPDIR fallback)
 *   backendPidFile  — runtimeDir/backend.pid
 *
 * Note: frontend paths are NOT project-scoped. The frontend service is bundled
 * with the CLI and uses fixed XDG paths keyed by "frontend", not project name.
 * See apps/cli/src/platforms/posix/handlers/frontend-paths.ts.
 */
export class SemiontProject {
  readonly root: string;
  readonly name: string;

  /** True if [git] sync = true in .semiont/config. When true, semiont stages
   *  working-tree and event-log changes in the git index automatically. */
  readonly gitSync: boolean;

  // Durable
  readonly eventsDir: string;
  readonly representationsDir: string;

  // Ephemeral — config (generated config files for managed processes)
  readonly configDir: string;

  // Ephemeral — data (persistent user data managed by semiont)
  readonly dataHome: string;

  // Ephemeral — state
  readonly stateDir: string;
  readonly projectionsDir: string;
  readonly jobsDir: string;
  readonly backendLogsDir: string;
  readonly backendAppLogFile: string;
  readonly backendErrorLogFile: string;

  // Ephemeral — runtime
  readonly runtimeDir: string;
  readonly backendPidFile: string;

  constructor(projectRoot: string, name?: string) {
    this.root = projectRoot;
    if (name !== undefined) {
      const configPath = path.join(projectRoot, '.semiont', 'config');
      if (!fs.existsSync(configPath)) {
        fs.mkdirSync(path.join(projectRoot, '.semiont'), { recursive: true });
        fs.writeFileSync(configPath, `[project]\nname = "${name}"\n`);
      }
    }
    this.name = SemiontProject.readName(projectRoot);
    this.gitSync = SemiontProject.readGitSync(projectRoot);

    this.eventsDir = path.join(projectRoot, '.semiont', 'events');
    this.representationsDir = path.join(projectRoot, 'representations');

    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    this.configDir = path.join(xdgConfig, 'semiont', this.name);

    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    this.dataHome = path.join(xdgData, 'semiont', this.name);

    const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    this.stateDir = path.join(xdgState, 'semiont', this.name);
    this.projectionsDir = path.join(this.stateDir, 'projections');
    this.jobsDir = path.join(this.stateDir, 'jobs');
    this.backendLogsDir = path.join(this.stateDir, 'backend');
    this.backendAppLogFile = path.join(this.backendLogsDir, 'app.log');
    this.backendErrorLogFile = path.join(this.backendLogsDir, 'error.log');

    const xdgRuntime = process.env.XDG_RUNTIME_DIR;
    const runtimeBase = xdgRuntime ?? process.env.TMPDIR ?? '/tmp';
    this.runtimeDir = path.join(runtimeBase, 'semiont', this.name);
    this.backendPidFile = path.join(this.runtimeDir, 'backend.pid');
  }

  /**
   * Read the current git branch for the project root.
   * Returns null if the project is not a git repo or git is not available.
   */
  gitBranch(): string | null {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Delete all ephemeral state for this project (stateDir + runtimeDir).
   * Does not touch eventsDir or dataDir.
   */
  async destroy(): Promise<void> {
    await Promise.all([
      fs.promises.rm(this.configDir, { recursive: true, force: true }),
      fs.promises.rm(this.stateDir, { recursive: true, force: true }),
      fs.promises.rm(this.runtimeDir, { recursive: true, force: true }),
    ]);
  }

  /**
   * Read [git] sync from .semiont/config.
   * Defaults to false if the section or key is absent.
   */
  private static readGitSync(projectRoot: string): boolean {
    const configPath = path.join(projectRoot, '.semiont', 'config');
    if (!fs.existsSync(configPath)) return false;
    const content = fs.readFileSync(configPath, 'utf-8');
    let inGitSection = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '[git]') { inGitSection = true; continue; }
      if (trimmed.startsWith('[')) { inGitSection = false; continue; }
      if (inGitSection && trimmed.startsWith('sync') && trimmed.includes('=')) {
        const value = trimmed.split('=')[1]?.trim();
        return value === 'true';
      }
    }
    return false;
  }

  /**
   * Read the project name from .semiont/config [project] name = "..."
   * Falls back to the directory basename if the config is absent or has no name.
   */
  private static readName(projectRoot: string): string {
    const configPath = path.join(projectRoot, '.semiont', 'config');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('name') && trimmed.includes('=')) {
          const [, ...rest] = trimmed.split('=');
          return rest.join('=').trim().replace(/^"(.*)"$/, '$1');
        }
      }
    }
    return path.basename(projectRoot);
  }
}
