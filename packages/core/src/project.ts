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
 *   eventsDir — .semiont/events/  (system of record, committed)
 *
 * Ephemeral paths (outside the project root, never committed):
 *   configDir      — $XDG_CONFIG_HOME/semiont/{name}/  (generated config for managed processes)
 *   stateDir        — $XDG_STATE_HOME/semiont/{name}/
 *   projectionsDir  — stateDir/projections/
 *   jobsDir         — stateDir/jobs/
 *   anchoredTextDir — supplied by the caller; required, no default
 *   backendLogsDir      — stateDir/backend/
 *   backendAppLogFile   — backendLogsDir/app.log
 *   backendErrorLogFile — backendLogsDir/error.log
 *   runtimeDir      — $XDG_RUNTIME_DIR/semiont/{name}/  (or $TMPDIR fallback)
 *   backendPidFile  — runtimeDir/backend.pid
 *
 * Everything ephemeral that is DERIVED sits under stateDir together —
 * projections (from the event log) and jobs. The anchored-text store is
 * derived too, but its location is declared by the deployment rather than
 * composed here (see anchoredTextDir). That is the XDG distinction, not a
 * filing habit:
 * $XDG_STATE_HOME is for data that persists between restarts but "is not
 * important or portable enough" for $XDG_DATA_HOME, and losing any of these
 * costs recomputation rather than information.
 *
 * There is no $XDG_DATA_HOME path here, deliberately. Semiont's own system of
 * record is the committed event log above; the databases live under the
 * launcher's per-root state, not the backend's. A `dataHome` field existed and
 * had exactly one consumer — the anchored-text store, which belonged in state
 * all along — so it went with the move rather than being left for a
 * hypothetical future user of the DATA tier.
 *
 * Note: the frontend has no entry here, deliberately. It serves static assets
 * from its own container image and keeps no per-project state on the host, so
 * there is nothing to derive from a project root.
 */
export class SemiontProject {
  readonly root: string;
  readonly name: string;

  /** True if [git] sync = true in .semiont/config. When true, semiont stages
   *  working-tree and event-log changes in the git index automatically. */
  readonly gitSync: boolean;

  // Durable
  readonly eventsDir: string;

  // Ephemeral — config (generated config files for managed processes)
  readonly configDir: string;

  // Ephemeral — state
  readonly stateDir: string;
  readonly projectionsDir: string;
  readonly jobsDir: string;
  readonly anchoredTextDir: string;
  readonly backendLogsDir: string;
  readonly backendAppLogFile: string;
  readonly backendErrorLogFile: string;

  // Ephemeral — runtime
  readonly runtimeDir: string;
  readonly backendPidFile: string;

  /**
   * @param projectRoot  the KB clone this project describes
   * @param opts.name    override the name read from .semiont/config
   * @param opts.anchoredTextDir  where this deployment keeps the anchored-text
   *   store. Passed IN, never read from the environment here: the entry point
   *   owns that read, exactly as it owns SEMIONT_ROOT. Required, and with no
   *   default — a default would let a deployment that forgot it write a full
   *   OCR pass per representation into a directory nobody mounted, lose it on
   *   the next `stop`, and re-derive it forever: silent, expensive, and
   *   indistinguishable from working.
   */
  constructor(projectRoot: string, opts: { anchoredTextDir: string; name?: string }) {
    const name = opts.name;
    this.anchoredTextDir = opts.anchoredTextDir;
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

    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    this.configDir = path.join(xdgConfig, 'semiont', this.name);

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
   * Does not touch eventsDir — the event log is the system of record.
   */
  async destroy(): Promise<void> {
    await Promise.all([
      fs.promises.rm(this.configDir, { recursive: true, force: true }),
      fs.promises.rm(this.stateDir, { recursive: true, force: true }),
      fs.promises.rm(this.runtimeDir, { recursive: true, force: true }),
    ]);
  }

  /**
   * The KB's permanent identity literal — `[site] domain` from the committed
   * `.semiont/config`, which `kbDid()` renders as `did:web:<domain>`.
   * `undefined` when the section or key is absent.
   *
   * Reads the committed file DIRECTLY, and deliberately not
   * `EnvironmentConfig.site.domain`, which is the same value only by
   * accident: the TOML loader defaults a domain-less `[site]` to the string
   * `'localhost'` (so every domain-less KB on a machine would claim one
   * fabricated `did:web:localhost`) and lets the environment section
   * override the KB's own declaration. Either would report an identity the
   * launcher never minted — an address wearing a name, which is the whole
   * category error .plans/KB-IDENTITY-VS-ADDRESS.md exists to end. Identity
   * is declared or absent; it is never defaulted.
   */
  siteDomain(): string | undefined {
    const configPath = path.join(this.root, '.semiont', 'config');
    if (!fs.existsSync(configPath)) return undefined;
    const content = fs.readFileSync(configPath, 'utf-8');
    let inSiteSection = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;
      if (trimmed === '[site]') { inSiteSection = true; continue; }
      if (trimmed.startsWith('[')) { inSiteSection = false; continue; }
      if (!inSiteSection) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      if (trimmed.slice(0, eq).trim() !== 'domain') continue;
      const value = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      return value === '' ? undefined : value;
    }
    return undefined;
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
