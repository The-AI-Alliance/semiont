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
 * **The paths divide along what they are derived FROM, and so does the type.**
 * Everything ephemeral is composed from the KB's NAME, so it needs no working
 * tree and lives on `SemiontState`. Only the durable half is composed from the
 * root. `SemiontProject extends SemiontState` — a project is its state plus a
 * working tree — which lets a consumer that has no KB root (the gateway, after
 * SINGLE-KB-MOUNT P5) take the smaller type and still be checked by the
 * compiler rather than by a throw at first read.
 *
 * Durable paths (inside the project root, committed or repo-local) — `SemiontProject`:
 *   eventsDir — .semiont/events/  (system of record, committed)
 *
 * Ephemeral paths (outside the project root, never committed) — `SemiontState`:
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
/**
 * The one composition of a project's state-tree root from its name. The
 * Librarian resolves this WITHOUT a SemiontProject — it has no KB root to
 * construct one from (SINGLE-KB-MOUNT P1) — so the join lives here, beside
 * the constructor that also uses it, rather than being restated over there.
 */
export function stateDirFor(name: string): string {
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(xdgState, 'semiont', name);
}

/**
 * A KB's state tree, addressed by NAME — everything that needs no working tree.
 *
 * This exists because a consumer appeared that genuinely needs half of
 * `SemiontProject` and cannot supply the other half: the gateway reads
 * `projectionsDir`, `jobsDir`, the backend log paths and `anchoredTextDir`, all
 * of which live on the shared state and anchored-text mounts, while having no
 * readable KB root at all (SINGLE-KB-MOUNT P5).
 *
 * **Split rather than made optional, deliberately.** Relaxing
 * `SemiontProject`'s root-derived fields to optional-and-throw-on-read would
 * have traded a compile-time guarantee for a runtime one, and bought no extra
 * safety doing it: a getter asserts PRESENCE exactly as weakly as a constructor
 * does — neither can tell a real path from a typo. Two types keep "needs a
 * working tree" a fact the compiler enforces. Handing a `SemiontState` to
 * something that reads `eventsDir` does not compile.
 *
 * Every field here is required. The `anchoredTextDir` guard is unchanged by the
 * split — see its note on the constructor.
 */
export class SemiontState {
  readonly name: string;

  /** Supplied by the caller; required, no default.
   *
   *  A default would let a deployment that forgot it write a full OCR pass per
   *  representation into a directory nobody mounted, lose it on the next
   *  `stop`, and re-derive it forever: silent, expensive, and indistinguishable
   *  from working. Passed IN, never read from the environment here — the entry
   *  point owns that read, exactly as it owns SEMIONT_ROOT. */
  readonly anchoredTextDir: string;

  // Ephemeral — config (generated config files for managed processes)
  readonly configDir: string;

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

  constructor(opts: { name: string; anchoredTextDir: string }) {
    this.name = opts.name;
    this.anchoredTextDir = opts.anchoredTextDir;

    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    this.configDir = path.join(xdgConfig, 'semiont', this.name);

    this.stateDir = stateDirFor(this.name);
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
}

/** A project is its state plus a working tree. */
export class SemiontProject extends SemiontState {
  readonly root: string;

  /** True if [git] sync = true in .semiont/config. When true, semiont stages
   *  working-tree and event-log changes in the git index automatically. */
  readonly gitSync: boolean;

  // Durable
  readonly eventsDir: string;

  /**
   * Seed `.semiont/config` if absent, then read the name back OUT of it.
   *
   * The order is the point, and it is why this is a static rather than inline
   * in the constructor: `super()` needs the resolved name, and the resolved
   * name is whatever the file says — a seed only applies when no file exists,
   * so a KB's committed identity always wins over anything a caller passes.
   */
  private static seedAndReadName(projectRoot: string, seed?: string): string {
    if (seed !== undefined) {
      const configPath = path.join(projectRoot, '.semiont', 'config');
      if (!fs.existsSync(configPath)) {
        fs.mkdirSync(path.join(projectRoot, '.semiont'), { recursive: true });
        fs.writeFileSync(configPath, `[project]\nname = "${seed}"\n`);
      }
    }
    return SemiontProject.readName(projectRoot);
  }

  /**
   * @param projectRoot  the KB clone this project describes
   * @param opts.name    seed value — see `seedAndReadName`.
   * @param opts.anchoredTextDir  see `SemiontState.anchoredTextDir`; required
   *   here for the same reason and with the same absence of a default.
   */
  constructor(projectRoot: string, opts: { anchoredTextDir: string; name?: string }) {
    super({
      name: SemiontProject.seedAndReadName(projectRoot, opts.name),
      anchoredTextDir: opts.anchoredTextDir,
    });
    this.root = projectRoot;
    this.gitSync = SemiontProject.readGitSync(projectRoot);
    this.eventsDir = path.join(projectRoot, '.semiont', 'events');
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
