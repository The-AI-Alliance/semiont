import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Represents a Semiont project rooted at a given directory.
 *
 * Computes all paths — durable and ephemeral — once at construction time.
 * XDG environment variables are read here and nowhere else.
 *
 * Durable paths (inside the project root, committed or repo-local):
 *   eventsDir          — .semiont/events/      (system of record, committed)
 *   representationsDir — representations/      (content store, committed)
 *   dataDir            — projectRoot/          (project root)
 *
 * Ephemeral paths (outside the project root, never committed):
 *   configDir      — $XDG_CONFIG_HOME/semiont/{name}/  (generated config for managed processes)
 *   dataHome       — $XDG_DATA_HOME/semiont/{name}/   (persistent user data, e.g. database files)
 *   stateDir        — $XDG_STATE_HOME/semiont/{name}/
 *   projectionsDir  — stateDir/projections/
 *   jobsDir         — stateDir/jobs/
 *   backendLogsDir  — stateDir/backend/
 *   frontendLogsDir — stateDir/frontend/
 *   runtimeDir     — $XDG_RUNTIME_DIR/semiont/{name}/  (or $TMPDIR fallback)
 */
export class SemiontProject {
  readonly root: string;
  readonly name: string;

  // Durable
  readonly eventsDir: string;
  readonly representationsDir: string;
  readonly dataDir: string;

  // Ephemeral — config (generated config files for managed processes)
  readonly configDir: string;

  // Ephemeral — data (persistent user data managed by semiont)
  readonly dataHome: string;

  // Ephemeral — state
  readonly stateDir: string;
  readonly projectionsDir: string;
  readonly jobsDir: string;
  readonly backendLogsDir: string;
  readonly frontendLogsDir: string;

  // Ephemeral — runtime
  readonly runtimeDir: string;

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

    this.eventsDir = path.join(projectRoot, '.semiont', 'events');
    this.representationsDir = path.join(projectRoot, 'representations');
    this.dataDir = projectRoot;

    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    this.configDir = path.join(xdgConfig, 'semiont', this.name);

    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    this.dataHome = path.join(xdgData, 'semiont', this.name);

    const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    this.stateDir = path.join(xdgState, 'semiont', this.name);
    this.projectionsDir = path.join(this.stateDir, 'projections');
    this.jobsDir = path.join(this.stateDir, 'jobs');
    this.backendLogsDir = path.join(this.stateDir, 'backend');
    this.frontendLogsDir = path.join(this.stateDir, 'frontend');

    const xdgRuntime = process.env.XDG_RUNTIME_DIR;
    const runtimeBase = xdgRuntime ?? process.env.TMPDIR ?? '/tmp';
    this.runtimeDir = path.join(runtimeBase, 'semiont', this.name);
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
