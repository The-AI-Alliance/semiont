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
 *   resourcesDir    — stateDir/resources/  (the per-resource materialized views)
 *   projectionsDir  — stateDir/projections/  (KB-global projections + the storage-uri index)
 *   jobsDir         — stateDir/jobs/
 *   anchoredTextDir — supplied by the caller; required, no default
 *   runtimeDir      — $XDG_RUNTIME_DIR/semiont/{name}/  (or $TMPDIR fallback)
 *   gatewayPidFile  — runtimeDir/gateway.pid
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
 * launcher's per-root state, not the gateway's. A `dataHome` field existed and
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
export declare function stateDirFor(name: string): string;
/**
 * A KB's state tree, addressed by NAME — everything that needs no working tree.
 *
 * This exists because consumers appeared that genuinely need half of
 * `SemiontProject` and cannot supply the other half: the gateway reads
 * `jobsDir` and the Librarian reads `resourcesDir`, both on the shared
 * state mount, with no readable KB root at all (SINGLE-KB-MOUNT P1/P5).
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
 * is deliberately NOT here (SINGLE-KB-MOUNT P6): it is a supplied path rather
 * than a derived one, and its only readers hold a working tree too, so it sits
 * on `SemiontProject` where they already are.
 */
export declare class SemiontState {
    readonly name: string;
    readonly configDir: string;
    readonly stateDir: string;
    readonly resourcesDir: string;
    readonly projectionsDir: string;
    readonly jobsDir: string;
    readonly runtimeDir: string;
    readonly gatewayPidFile: string;
    constructor(opts: {
        name: string;
    });
}
/** A project is its state plus a working tree. */
export declare class SemiontProject extends SemiontState {
    readonly root: string;
    readonly anchoredTextDir: string;
    /** True if [git] sync = true in .semiont/config. When true, semiont stages
     *  working-tree and event-log changes in the git index automatically. */
    readonly gitSync: boolean;
    readonly eventsDir: string;
    /**
     * Seed `.semiont/config` if absent, then read the name back OUT of it.
     *
     * The order is the point, and it is why this is a static rather than inline
     * in the constructor: `super()` needs the resolved name, and the resolved
     * name is whatever the file says — a seed only applies when no file exists,
     * so a KB's committed identity always wins over anything a caller passes.
     */
    private static seedAndReadName;
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
     *   It lives on THIS type rather than `SemiontState` (SINGLE-KB-MOUNT P6)
     *   because every reader of it holds a working tree as well, and the one
     *   consumer that needs state paths without a tree — the gateway — does not
     *   read it at all.
     */
    constructor(projectRoot: string, opts: {
        anchoredTextDir: string;
        name?: string;
    });
    /**
     * Read the current git branch for the project root.
     * Returns null if the project is not a git repo or git is not available.
     */
    gitBranch(): string | null;
    /**
     * Delete all ephemeral state for this project (stateDir + runtimeDir).
     * Does not touch eventsDir — the event log is the system of record.
     */
    destroy(): Promise<void>;
    /**
     * The KB's permanent identity literal — `[site] domain` from the committed
     * `.semiont/config`, which `kbDid()` renders as `did:web:<domain>`.
     * `undefined` when the section or key is absent.
     *
     * Reads the committed file DIRECTLY, and deliberately not
     * `EnvironmentConfig.site.domain`, which is the same value only by
     * accident: the environment section can override the KB's own declaration.
     * That would report an identity the
     * launcher never minted — an address wearing a name, which is the whole
     * category error .plans/KB-IDENTITY-VS-ADDRESS.md exists to end. Identity
     * is declared or absent; it is never defaulted.
     */
    siteDomain(): string | undefined;
    /**
     * Read [git] sync from .semiont/config.
     * Defaults to false if the section or key is absent.
     */
    private static readGitSync;
    /**
     * Read the project name from .semiont/config [project] name = "..."
     * Falls back to the directory basename if the config is absent or has no name.
     */
    private static readName;
}
