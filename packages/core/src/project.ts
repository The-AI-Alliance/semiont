import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { isObject, isString } from './type-guards';

/**
 * The one composition of a project's state-tree root from its name, for the
 * `SemiontState` constructor below. A service that mounts no part of the KB
 * tree (the Librarian) builds a `SemiontState` from the name alone.
 */
function stateDirFor(name: string): string {
  // No fabricated default: absence fails loudly. Every process that reaches
  // its state tree through this — the Librarian, the Archivist — runs in a
  // container the launcher gives a state MOUNT and an explicit
  // `XDG_STATE_HOME=/semiont-state`. Its absence means a service that
  // needs state has no volume behind it — a misconfiguration — and writing to a
  // manufactured `~/.local/state` would hide that behind an ephemeral path
  // nobody chose. A service that needs no persistent state must not construct a
  // SemiontState/SemiontProject in the first place.
  const xdgState = process.env.XDG_STATE_HOME;
  if (!xdgState) {
    throw new Error(
      'XDG_STATE_HOME is not set: a Semiont state tree has no safe default. The launcher sets it to ' +
      'the mounted state volume; reaching state here without it is a misconfiguration.',
    );
  }
  return path.join(xdgState, 'semiont', name);
}

/**
 * A KB's state tree, addressed by NAME — everything that needs no working tree.
 *
 * This exists for consumers that genuinely need half of `SemiontProject` and
 * cannot supply the other half: the Librarian reads `resourcesDir` on the
 * shared state mount, with no readable KB root at all. Only the Archivist
 * mounts the KB.
 *
 * **Split rather than made optional, deliberately.** Relaxing
 * `SemiontProject`'s root-derived fields to optional-and-throw-on-read would
 * have traded a compile-time guarantee for a runtime one, and bought no extra
 * safety doing it: a getter asserts PRESENCE exactly as weakly as a constructor
 * does — neither can tell a real path from a typo. Two types keep "needs a
 * working tree" a fact the compiler enforces. Handing a `SemiontState` to
 * something that reads `eventsDir` does not compile.
 *
 * Every field here is required, and every one is derived from `name` alone —
 * which is what makes the name the whole of this type's input. `anchoredTextDir`
 * is deliberately NOT here: it is a supplied path rather than a derived one,
 * and its only readers hold a working tree too, so it sits on `SemiontProject`
 * where they already are.
 */
export class SemiontState {
  readonly name: string;

  // Ephemeral — state
  readonly stateDir: string;
  readonly resourcesDir: string;
  readonly projectionsDir: string;

  constructor(opts: { name: string }) {
    this.name = opts.name;

    this.stateDir = stateDirFor(this.name);
    this.resourcesDir = path.join(this.stateDir, 'resources');
    this.projectionsDir = path.join(this.stateDir, 'projections');
  }
}

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
 * working tree — which lets a consumer that has no KB root (the Librarian,
 * which mounts no part of the KB tree) take the smaller type and still be
 * checked by the compiler rather than by a throw at first read.
 *
 * Durable paths (inside the project root, committed or repo-local) — `SemiontProject`:
 *   eventsDir — .semiont/events/  (system of record, committed)
 *
 * Ephemeral paths (outside the project root, never committed) — `SemiontState`:
 *   stateDir        — $XDG_STATE_HOME/semiont/{name}/
 *   resourcesDir    — stateDir/resources/  (the per-resource materialized views)
 *   projectionsDir  — stateDir/projections/  (KB-global projections + the storage-uri index)
 *
 * Supplied by the caller rather than composed — `SemiontProject`:
 *   anchoredTextDir — the anchored-text store; required, no default
 *
 * Everything ephemeral that is DERIVED sits under stateDir together —
 * the projections (from the event log). The anchored-text store is
 * derived too, but its location is declared by the deployment rather than
 * composed here (see anchoredTextDir). That is the XDG distinction, not a
 * filing habit:
 * $XDG_STATE_HOME is for data that persists between restarts but "is not
 * important or portable enough" for $XDG_DATA_HOME, and losing any of these
 * costs recomputation rather than information.
 *
 * There is no $XDG_DATA_HOME path here, deliberately. Semiont's own system of
 * record is the committed event log above, and the databases live under the
 * launcher's per-root data directory.
 *
 * Note: the Browser has no entry here, deliberately. It serves static assets
 * from its own container image and keeps no per-project state on the host, so
 * there is nothing to derive from a project root.
 */
export class SemiontProject extends SemiontState {
  readonly root: string;
  readonly anchoredTextDir: string;

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
   * @param opts.anchoredTextDir  where this deployment keeps the anchored-text
   *   store. Supplied by the caller; REQUIRED, no default.
   *
   *   A default would let a deployment that forgot it write a full OCR pass per
   *   representation into a directory nobody mounted, lose it on the next
   *   `stop`, and re-derive it forever: silent, expensive, and indistinguishable
   *   from working. Passed IN, never read from the environment here — the entry
   *   point owns that read, exactly as it owns SEMIONT_ROOT.
   *
   *   It lives on THIS type rather than `SemiontState` because every reader
   *   of it holds a working tree as well, and the one consumer that needs
   *   state paths without a tree — the Librarian — does not read it at all.
   */
  constructor(projectRoot: string, opts: { anchoredTextDir: string; name?: string }) {
    super({ name: SemiontProject.seedAndReadName(projectRoot, opts.name) });
    this.anchoredTextDir = opts.anchoredTextDir;
    this.root = projectRoot;
    this.gitSync = SemiontProject.readGitSync(projectRoot);
    this.eventsDir = path.join(projectRoot, '.semiont', 'events');
  }

  /**
   * Delete all ephemeral state for this project (stateDir).
   * Does not touch eventsDir — the event log is the system of record.
   */
  async destroy(): Promise<void> {
    await fs.promises.rm(this.stateDir, { recursive: true, force: true });
  }

  /**
   * The KB's permanent identity — `[site] domain` from the committed
   * `.semiont/config`, which `kbDid()` renders as `did:web:<domain>`. The one
   * source: everything that names this KB derives from it. `undefined` when
   * none is declared; identity is declared or absent, never defaulted.
   */
  siteDomain(): string | undefined {
    return nonEmptyString(readCommittedConfig(this.root)?.['site'], 'domain');
  }

  /** `[git] sync` from .semiont/config: true only when it is declared `true`. */
  private static readGitSync(projectRoot: string): boolean {
    const git = readCommittedConfig(projectRoot)?.['git'];
    return isObject(git) && git['sync'] === true;
  }

  /** `[project] name` from .semiont/config, else the directory's name. */
  private static readName(projectRoot: string): string {
    return nonEmptyString(readCommittedConfig(projectRoot)?.['project'], 'name') ?? path.basename(projectRoot);
  }
}

/**
 * The committed .semiont/config, decoded as TOML; `null` when the file is
 * absent or does not parse. This is the launcher's reading too (kbconfig.go
 * `parseKBIdentity`), and specs/src/kb-identity/cases.json holds the two to
 * one answer. A file that does not parse never reaches a running service:
 * `loadEnvironmentConfig` decodes the same file and refuses to start on it.
 */
function readCommittedConfig(projectRoot: string): Record<string, unknown> | null {
  const configPath = path.join(projectRoot, '.semiont', 'config');
  if (!fs.existsSync(configPath)) return null;
  try {
    return parseToml(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** `table[key]` when the table exists and the key holds a non-empty string. */
function nonEmptyString(table: unknown, key: string): string | undefined {
  if (!isObject(table)) return undefined;
  const value = table[key];
  return isString(value) && value !== '' ? value : undefined;
}
