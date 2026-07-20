package launcher

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	configDir     = ".semiont/semiontconfig"
	imageRegistry = "ghcr.io/the-ai-alliance"
)

// preflightNames is the stop-then-rm sweep order at start; semiont-ollama is
// deliberately absent — it is handled in the Ollama section, where a host
// instance may make a container unnecessary.
var preflightNames = []string{
	"semiont-jaeger", "semiont-neo4j", "semiont-qdrant", "semiont-postgres",
	"semiont-backend", "semiont-worker", "semiont-smelter", "semiont-weaver",
	"semiont-frontend",
}

type startOptions struct {
	configName   string
	configSet    bool // --config given explicitly (drives --service compatibility)
	listConfigs  bool
	cleanOllama  bool
	runtime      string
	observe      bool
	noObserveSet bool // --no-observe given explicitly
	quiet        bool
	dryRun       bool
	ollamaCache  string // "", "host", or "volume"
	service      string // start just this one service
	root         string // --root: KB root by path or registered basename
	repo         string // --repo: owner/name (codespace placement only)
	csName       string // --codespace: instance disambiguator (codespace placement only)
	machine      string // --machine: VM class (codespace placement only)
}

const startUsage = `Usage: semiont start [options]

Start a local Semiont stack — graph (Neo4j), vectors (Qdrant), inference
(Ollama), database (PostgreSQL), the Semiont backend, worker, smelter, weaver, and
the frontend (http://localhost:3000) — all in containers.

Options:
  --config <name>       Semiontconfig to use (default: this KB's recorded
                        preference — the --config a successful start last
                        used, kept in roots.json — else ollama-gemma)
  --list-configs        List available configs and exit
  --root <path|name>    KB root to start: a directory (must contain .semiont/)
                        or the basename of a registered root (roots register on
                        every real start; see semiont status). Wins over
                        SEMIONT_ROOT and cwd discovery.
  --service <name>      Start (restart) just this one service, leaving the rest
                        of the stack untouched: backend, worker, smelter, weaver,
                        frontend, database, graph, vectors, inference, or traces.
                        Rejoins a running stack's worker secret automatically;
                        OTel export is enabled iff traces (Jaeger) is up.
  --clean-ollama        Remove the Ollama model cache volume and exit
  --runtime <name>      Container runtime: container, docker, or podman
                        (default: the machine's recorded preference — the
                        --runtime a successful start last used, kept in
                        roots.json — else the first found on PATH). Or
                        'codespace': run the stack on a GitHub-hosted
                        machine via gh (never sticky; a recorded codespace
                        stack resumes on a bare start)
  --repo <owner/name>   Codespace placement: the GitHub repo (default: the
                        KB clone's origin remote; the record remembers it)
  --codespace <name>    Codespace placement: disambiguate when the repo has
                        several codespaces (the launcher itself makes one)
  --machine <class>     Codespace placement: VM class (default: premiumLinux)
  --no-observe          Skip the Jaeger sidecar (OTel traces + metrics run by default)
  --ollama-cache <c>    Model cache when starting an Ollama container: 'host'
                        (~/.ollama) or 'volume' (named volume) — skips the prompt
  --dry-run             Print the exact runtime commands a run would execute, then exit
  --quiet, -q           Suppress informational output
  --help, -h            Show this help

Environment:
  SEMIONT_ROOT          KB root override, analogous to GIT_DIR: skip discovery
                        and use this path (must contain .semiont/; invalid
                        values are an error, never ignored). Default: walk up
                        from the current directory looking for .semiont/.
  SEMIONT_VERSION       Image tag to run (default: latest; 'local' uses
                        locally-built :local images and skips the pull)
  SEMIONT_WORKER_SECRET Shared backend/sidecar secret (default: generated per
                        run; --service rejoins the running stack's secret)

Examples:
  # Fully local with Ollama (default, no API key needed)
  semiont start

  # Anthropic cloud inference
  export ANTHROPIC_API_KEY=<your-key>
  semiont start --config anthropic

  # First admin user, once the stack is up
  semiont useradd --email admin@example.com --password <pass> --admin

  # See available configs
  semiont start --list-configs
`

// Start implements `semiont start` — the port of the fleet's start.sh.
func Start(args []string) int {
	opts := startOptions{configName: "ollama-gemma", observe: true}
	u := newUI(false)

	needVal := func(i int) (string, bool) {
		if i+1 >= len(args) {
			u.fail("Missing value for %s", args[i])
			return "", false
		}
		return args[i+1], true
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if v, ok := strings.CutPrefix(a, "--ollama-cache="); ok {
			opts.ollamaCache = v
			continue
		}
		switch a {
		case "--config":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.configName = v
			opts.configSet = true
			i++
		case "--service":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.service = v
			i++
		case "--root":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.root = v
			i++
		case "--repo":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.repo = v
			i++
		case "--codespace":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.csName = v
			i++
		case "--machine":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.machine = v
			i++
		case "--list-configs":
			opts.listConfigs = true
		case "--clean-ollama":
			opts.cleanOllama = true
		case "--runtime":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.runtime = v
			i++
		case "--no-observe":
			opts.observe = false
			opts.noObserveSet = true
		case "--ollama-cache":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.ollamaCache = v
			i++
		case "--dry-run":
			opts.dryRun = true
		case "--quiet", "-q":
			opts.quiet = true
		case "--help", "-h":
			fmt.Print(startUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", a)
			return 1
		}
	}
	switch opts.ollamaCache {
	case "", "host", "volume":
	default:
		u.fail("Unknown --ollama-cache '%s' (expected: host or volume)", opts.ollamaCache)
		return 1
	}

	// Codespace placement: the codespace-only flags are rejected elsewhere,
	// and the local-only knobs are rejected on a codespace start — nothing
	// is silently ignored, per the flag-scoping pattern.
	if opts.runtime == "codespace" {
		switch {
		case opts.service != "":
			u.fail("--service does not apply to --runtime codespace (compose owns the services inside).")
			return 1
		case opts.configSet:
			u.fail("--config does not apply to --runtime codespace (the codespace runs its committed config).")
			return 1
		case opts.noObserveSet:
			u.fail("--no-observe does not apply to --runtime codespace (the observe profile is composed inside).")
			return 1
		case opts.ollamaCache != "":
			u.fail("--ollama-cache does not apply to --runtime codespace.")
			return 1
		case opts.cleanOllama:
			u.fail("--clean-ollama does not apply to --runtime codespace.")
			return 1
		case opts.listConfigs:
			u.fail("--list-configs does not apply to --runtime codespace.")
			return 1
		case opts.root != "" && opts.repo != "":
			u.fail("--root and --repo are contradictory (one derives the repo from a clone, the other bypasses clones).")
			return 1
		}
	} else if opts.repo != "" || opts.csName != "" || opts.machine != "" {
		u.fail("--repo/--codespace/--machine only apply to --runtime codespace.")
		return 1
	}

	// --service compatibility: flags that don't apply to the named service are
	// rejected rather than silently ignored.
	if opts.service != "" {
		if _, known := roles[opts.service]; !known {
			u.fail("Unknown --service '%s' (expected: %s)", opts.service, roleList)
			return 1
		}
		switch {
		case opts.listConfigs:
			u.fail("--list-configs cannot be combined with --service.")
			return 1
		case opts.cleanOllama:
			u.fail("--clean-ollama cannot be combined with --service.")
			return 1
		case opts.noObserveSet:
			u.fail("--no-observe does not apply to --service: OTel export is enabled iff traces (Jaeger) is already running.")
			return 1
		case opts.ollamaCache != "" && opts.service != "inference":
			u.fail("--ollama-cache only applies to --service inference.")
			return 1
		case opts.configSet && (opts.service == "frontend" || opts.service == "traces"):
			u.fail("--config does not apply to --service %s (it reads no config).", opts.service)
			return 1
		case opts.root != "" && (opts.service == "frontend" || opts.service == "traces"):
			u.fail("--root only applies to services that read the KB config (--service %s does not).", opts.service)
			return 1
		}
	}

	// Dry-run output is a machine-consumable plan; keep the narration off it.
	u = newUI(opts.quiet || opts.dryRun)
	if !opts.dryRun {
		u.stamp("semiont start")
	}

	// Codespace placement dispatches before anything local: no root
	// discovery (the record replaces the clone), no config load, no local
	// preflight. Explicit --runtime codespace; or, implicitly, a bare start
	// on a machine whose ONLY recorded stack(s) are codespaces — one resumes
	// (rejoin what exists), several must be named. A local record wins the
	// bare start (codespace stacks coexist; only the lens contends, dropped
	// below).
	if opts.runtime == "codespace" {
		return startCodespace(u, opts)
	}
	if opts.runtime == "" {
		ss := loadStackSet()
		if cs := codespaceStacks(ss); ss.Stacks["local"] == nil && len(cs) > 0 {
			if len(cs) > 1 {
				u.fail("%d codespace stacks are recorded — say which:", len(cs))
				for _, c := range cs {
					fmt.Fprintf(os.Stderr, "    semiont start --runtime codespace --repo %s\n", c.Repo)
				}
				return 1
			}
			if !onPath("gh") {
				u.fail("A codespace stack is recorded (per %s) but 'gh' is not on PATH.", statePath())
				fmt.Fprintln(os.Stderr, "  Install the GitHub CLI, or forget the stack:  semiont stop --delete")
				return 1
			}
			u.log("Using recorded stack's runtime: %s %s", u.bold("codespace"), u.dim("(per "+statePath()+")"))
			return startCodespace(u, opts)
		}
	}

	// Resolve the KB root: SEMIONT_ROOT override (strict), else walk up from
	// cwd for .semiont/ — deliberately after arg parsing so --help works
	// anywhere. Only flows that read the config need a root at all; only
	// flows that mount /kb (full start, --service backend) must additionally
	// be a git clone — the backend versions the event log via git. A
	// --service target that touches neither (infra, frontend) runs from
	// anywhere: "just the browser" needs no clone at all.
	// Everything except frontend and traces is config-driven now: infra
	// roles need the config to know their OBLIGATION (provided / external /
	// host-process / absent), so they need the KB root too. frontend (absent
	// from the config) and traces (launcher-owned) keep the no-clone freedom.
	configNeeded := opts.service == "" || (opts.service != "frontend" && opts.service != "traces")
	rootNeeded := configNeeded
	root := ""
	if rootNeeded {
		var err error
		if opts.root != "" {
			// --root wins over SEMIONT_ROOT and discovery: a path is
			// validated directly, anything else resolves via the registry.
			root, err = resolveRootArg(opts.root)
		} else {
			root, _, err = resolveKBRoot()
		}
		if err != nil {
			u.fail("%v", err)
			fmt.Fprintln(os.Stderr, "  cd into a KB clone, or set SEMIONT_ROOT / pass --root.")
			return 1
		}
		if opts.service == "" || opts.service == "backend" {
			if !requireGitClone(u, root) {
				return 1
			}
		}
		if err := os.Chdir(root); err != nil {
			u.fail("Cannot enter KB root %s: %v", root, err)
			return 1
		}
		// The registry remembers every root a real run used (dry-run is a
		// machine seam and mutates nothing). The sticky config is recorded
		// separately, only after the start succeeds.
		if !opts.dryRun {
			registerRootUse(root, opts.service == "", "")
		}
	}

	// Sticky config: with no explicit --config, this KB's recorded
	// preference (roots.json) wins over the built-in fallback. Dry-run
	// reads it too — the plan must mirror what a real run would do.
	configFrom := ""
	if configNeeded && !opts.configSet {
		if rec := recordedConfig(root); rec != "" {
			opts.configName = rec
			configFrom = "recorded from last start; override with --config"
		}
	}

	if opts.listConfigs {
		fmt.Println("Available configs:")
		printConfigNames()
		return 0
	}
	configFile := filepath.Join(configDir, opts.configName+".toml")
	var plan *launchPlan
	var userVars []string
	if configNeeded {
		if _, err := os.Stat(configFile); err != nil {
			u.fail("Config not found: %s", configFile)
			if configFrom != "" {
				fmt.Fprintf(os.Stderr, "  ('%s' is this KB's recorded preference; pass --config to pick another — a successful start re-records it.)\n", opts.configName)
			}
			fmt.Println("Available configs:")
			printConfigNames()
			return 1
		}
		var uv []string
		envCfg, envName, uv, err := loadConfig(configFile)
		if err != nil {
			u.fail("%v", err)
			return 1
		}
		userVars = uv
		if plan, err = derivePlan(envCfg, envName, configFile); err != nil {
			u.fail("%v", err)
			return 1
		}
	}

	// Runtime selection, three tiers: a live stack's record (correctness —
	// rejoin what exists, below), then the machine-wide sticky preference
	// (the --runtime a successful start last used, roots.json), then
	// auto-detect. Only an EXPLICIT flag naming a missing runtime is an
	// error; a recorded preference that vanished from PATH just falls back.
	requested, rtSticky := opts.runtime, false
	if requested == "" {
		// "codespace" can never be a sticky preference (we never write it);
		// a hand-edited registry saying so is ignored, not obeyed.
		if rec := loadRoots().Runtime; rec != "" && rec != "codespace" {
			if onPath(rec) {
				requested, rtSticky = rec, true
			} else if !opts.dryRun { // keep the dry-run seam machine-clean
				u.warn("Recorded runtime preference '%s' (per %s) is not on PATH — auto-detecting.", rec, rootsPath())
			}
		}
	}
	rt, ok := selectRuntime(u, requested)
	if !ok {
		return 1
	}
	rtFrom := ""
	switch {
	case rtSticky:
		rtFrom = "recorded from last start; override with --runtime"
	case opts.runtime == "":
		// Ambiguous auto-detect owns its choice: name the alternatives.
		if found := installedRuntimes(); len(found) > 1 {
			others := make([]string, 0, len(found)-1)
			for _, f := range found {
				if f != rt {
					others = append(others, f)
				}
			}
			rtFrom = "auto-detected; also on PATH: " + strings.Join(others, ", ") + " — override with --runtime"
		}
	}
	// The record binds a running stack to its runtime. Implicit selection
	// prefers it (a bare `start --service worker` must rejoin the stack that
	// exists, not whatever auto-detect — or the sticky preference — says);
	// an EXPLICIT mismatch on a non-dry-run refuses rather than orphan the
	// recorded stack — start's preflight would erase its record and delete
	// staged configs out from under its live mounts. A record whose runtime
	// is no longer installed is stale (that stack cannot be running) and
	// doesn't bind anything.
	if recSt := loadLocalState(); recSt != nil && recSt.Runtime != "" && recSt.Runtime != rt && onPath(recSt.Runtime) {
		if opts.runtime == "" {
			rt = recSt.Runtime
			rtFrom = ""
			u.log("Using recorded stack's runtime: %s %s", u.bold(rt), u.dim("(per "+statePath()+")"))
		} else if !opts.dryRun {
			u.fail("A recorded stack is running under %s (per %s).", recSt.Runtime, statePath())
			fmt.Fprintln(os.Stderr, "  Stop it first (semiont stop), or start with --runtime "+recSt.Runtime+".")
			return 1
		}
	}

	if opts.cleanOllama {
		u.log("Removing Ollama model cache volume...")
		u.echoCmd(rt, "volume", "rm", "semiont-ollama-models")
		if err := runSilent(rt, "volume", "rm", "semiont-ollama-models"); err == nil {
			u.ok("Removed.")
		} else {
			u.warn("Volume not found.")
		}
		return 0
	}

	// Published service images are consumed by version (they ship config-free):
	// each is pulled explicitly below (a `run` alone will NOT refresh a cached
	// mutable tag like :latest), and the selected config TOML is bind-mounted
	// into every container at runtime. SEMIONT_VERSION=local uses locally-built
	// :local images and skips the pull.
	version := os.Getenv("SEMIONT_VERSION")
	if version == "" {
		version = "latest"
	}

	u.banner("Semiont Local Backend")
	if rootNeeded {
		if ident := loadKBIdentity(root); ident != nil && ident.SiteName != "" {
			u.log("KB: %s %s", u.bold(ident.SiteName), u.dim(ident.didWeb()))
		}
	}
	if rtFrom != "" {
		u.log("Container runtime: %s %s", u.bold(rt), u.dim("("+rtFrom+")"))
	} else {
		u.log("Container runtime: %s", u.bold(rt))
	}
	if configNeeded {
		if configFrom != "" {
			u.log("Config: %s %s", u.bold(opts.configName), u.dim("("+configFrom+")"))
		} else {
			u.log("Config: %s", u.bold(opts.configName))
		}
	}
	u.log("Image version: %s", u.bold(version))

	// User env vars (API keys the config references, extracted by
	// loadConfig's single parse) are demanded only where a Semiont service
	// will consume the config — never for infra restarts. The environment
	// always wins; a registered secret source (semiont secret) is consulted
	// only for vars the environment doesn't provide, with the reach
	// announced BEFORE it happens. Dry-run reaches for nothing.
	var userEnv []string
	if opts.service == "" || isConfigConsumer(opts.service) {
		secrets := loadRoots().Secrets
		for _, v := range userVars {
			if opts.dryRun {
				userEnv = append(userEnv, "--env", v+"=<env:"+v+">")
				continue
			}
			val := os.Getenv(v)
			if val == "" {
				if ref, ok := secrets[v]; ok {
					if !requireProviderBin(u, ref) {
						return 1
					}
					u.log("%s: reading from %s (%s) %s", u.bold(v),
						secretProviders[ref.Provider].display, refCommand(ref),
						u.dim("— expect an authorization prompt"))
					var err error
					if val, err = resolveSecret(ref); err != nil {
						u.fail("%s: %v.", v, err)
						fmt.Fprintf(os.Stderr, "  Fix the source (semiont secret set %s ...), or export %s yourself — the environment always wins.\n", v, v)
						return 1
					}
				}
			}
			if val == "" {
				u.fail("Config '%s' references ${%s} but it is not set in the environment.", opts.configName, v)
				fmt.Fprintf(os.Stderr, "  Export it, or register a secret source once:  semiont secret set %s\n", v)
				return 1
			}
			userEnv = append(userEnv, "--env", v+"="+val)
		}
	}

	if opts.dryRun {
		if opts.service != "" {
			renderServicePlan(rt, version, opts, userEnv, plan)
		} else {
			renderStartPlan(rt, version, opts, userEnv, plan)
		}
		return 0
	}
	// A codespace KB forward may squat on a port this start claims (a
	// forward is a view, not a stack — dropping one stops nothing in the
	// cloud). Only colliding forwards drop; concurrent KBs on allocated
	// ports keep running.
	if !opts.dryRun {
		var needs []portNeed
		if opts.service != "" {
			needs = servicePortNeeds(opts.service, plan) // nil-plan-safe (frontend, traces)
		} else {
			needs = planPortChecks(plan, opts.observe) // full start always has a plan
		}
		dropCollidingForwards(u, needs)
	}

	// Record sticky preferences only when this start SUCCEEDED with the
	// explicit flag: preferences are "what I actually run", so a typo'd
	// name or an unlaunchable choice never becomes the default. Implicit
	// picks (auto-detect, the preferences themselves) record nothing.
	code := 0
	if opts.service != "" {
		code = runStartService(u, rt, version, root, configFile, opts, userEnv, plan)
	} else {
		code = runStart(u, rt, version, root, configFile, opts, userEnv, plan)
	}
	if code == 0 {
		if opts.configSet {
			registerRootUse(root, false, opts.configName)
		}
		if opts.runtime != "" {
			recordRuntimePref(opts.runtime)
		}
	}
	return code
}

func printConfigNames() {
	files, _ := filepath.Glob(filepath.Join(configDir, "*.toml"))
	for _, f := range files {
		fmt.Printf("  %s\n", strings.TrimSuffix(filepath.Base(f), ".toml"))
	}
}

// --- Command builders (shared by the real run and --dry-run) ---

func image(svc, version string) string {
	return fmt.Sprintf("%s/semiont-%s:%s", imageRegistry, svc, version)
}

func tracesArgs() []string {
	return []string{"run", "-d", "--rm", "--name", "semiont-jaeger",
		"-p", "16686:16686", "-p", "4318:4318", "jaegertracing/all-in-one:1.76.0"}
}

// backendArgs: the backend takes the four dependency hosts but must NOT
// receive BACKEND_HOST (publicURL derives from it; see the DID/site.domain
// history before ever changing this). Admin seeding deliberately does NOT
// ride in here — `semiont useradd` execs the in-container CLI instead, so
// no password ever sits in the container's inspectable env.
func backendArgs(kbRoot, stage, addr, secret, version string, port int, userEnv, otel []string) []string {
	a := []string{"run", "-d", "--rm", "--name", "semiont-backend",
		"--publish", fmt.Sprintf("%d:%d", port, port), "--memory", "8G",
		"--volume", kbRoot + ":/kb",
		"--volume", stage + "/backend.toml:/home/semiont/.semiontconfig:ro"}
	a = append(a, userEnv...)
	a = append(a, otel...)
	a = append(a,
		"--env", "POSTGRES_HOST="+addr,
		"--env", "NEO4J_HOST="+addr,
		"--env", "QDRANT_HOST="+addr,
		"--env", "OLLAMA_HOST="+addr,
		"--env", "SEMIONT_WORKER_SECRET="+secret)
	return append(a, image("backend", version))
}

// sidecarArgs covers the three make-meaning sidecars (worker / smelter /
// weaver) — identical in shape, differing only in name, port, and memory.
func sidecarArgs(svc, mem string, port int, stage, addr, secret, version string, userEnv, otel []string) []string {
	p := strconv.Itoa(port)
	a := []string{"run", "-d", "--rm", "--name", "semiont-" + svc,
		"--memory", mem, "--publish", p + ":" + p,
		"--volume", stage + "/" + svc + ".toml:/home/semiont/.semiontconfig:ro"}
	a = append(a, userEnv...)
	a = append(a, otel...)
	a = append(a,
		"--env", "BACKEND_HOST="+addr,
		"--env", "OLLAMA_HOST="+addr,
		"--env", "NEO4J_HOST="+addr,
		"--env", "QDRANT_HOST="+addr,
		"--env", "POSTGRES_HOST="+addr,
		"--env", "SEMIONT_WORKER_SECRET="+secret)
	return append(a, image(svc, version))
}

func frontendArgs(version string) []string {
	return []string{"run", "-d", "--rm", "--name", "semiont-frontend",
		"--memory", "1G", "--publish", "3000:3000", image("frontend", version)}
}

func otelArgs(addr string) []string {
	return []string{"--env", "OTEL_EXPORTER_OTLP_ENDPOINT=http://" + addr + ":4318"}
}

func pullArgs(rt, img string) []string {
	// Pull is not portable across runtimes: Apple `container` uses
	// `image pull`, docker/podman use `pull`.
	if rt == "container" {
		return []string{"image", "pull", img}
	}
	return []string{"pull", img}
}

var semiontServices = []string{"backend", "worker", "smelter", "weaver", "frontend"}

// sidecarSpecs: the three make-meaning sidecars, in start order.
type sidecarSpec struct {
	svc, label, mem, banner string
	port                    int
}

var sidecarSpecs = []sidecarSpec{
	{"worker", "Worker pool", "2G", "Starting Worker Pool", 9090},
	{"smelter", "Smelter", "2G", "Starting Smelter", 9091},
	{"weaver", "Weaver", "3G", "Starting Weaver", 9092},
}

// --- The real run ---

// runStart: the live full start — flowFullStart with liveExec, plus the
// live-only bookends (timing stamp, summary table).
func runStart(u *ui, rt, version, root, configFile string, opts startOptions, userEnv []string, plan *launchPlan) int {
	t0 := time.Now()
	x := &liveExec{u: u, rt: rt}
	if code := flowFullStart(x, flowCtx{plan: plan, opts: opts, version: version, root: root, configFile: configFile, userEnv: userEnv}); code != 0 {
		return code
	}

	// Summary; the stack runs detached and this process exits — bring the
	// stack up, say where everything is, and get out of the way. These
	// containers run --rm with NO restart policy; a crashed service stays
	// down until you rerun semiont start (fail-fast is the design; the
	// compose path adds restart: on-failure).
	u.stamp("semiont start: containers ready")
	fmt.Println()
	fmt.Printf("%s  %s\n", u.wrap(ansiBold+ansiGreen, "🚀 Semiont stack is up"), u.dim("("+took(time.Since(t0))+")"))
	fmt.Println()
	fmt.Printf("  Semiont Browser    %s\n", u.bold("http://localhost:3000"))
	fmt.Println("  Semiont KB         http://localhost:4000")
	fmt.Printf("  Neo4j Browser      http://localhost:7474   %s\n", u.dim("(neo4j / localpass)"))
	fmt.Println("  Qdrant Dashboard   http://localhost:6333/dashboard")
	if opts.observe {
		fmt.Println("  Jaeger UI          http://localhost:16686")
	}
	fmt.Println()
	fmt.Printf("  Add a user:    %s\n", u.bold("semiont useradd --email <email> --password <pass> --admin"))
	fmt.Printf("  Check health:  %s\n", u.bold("semiont status"))
	fmt.Printf("  Follow logs:   %s\n", u.bold("semiont logs"))
	fmt.Printf("  Stop stack:    %s\n", u.bold("semiont stop"))
	fmt.Println()
	return 0
}

// fullStartSecret: $SEMIONT_WORKER_SECRET or freshly generated.
func fullStartSecret(u *ui) (string, bool) {
	if secret := os.Getenv("SEMIONT_WORKER_SECRET"); secret != "" {
		return secret, true
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		u.fail("Generating worker secret: %v", err)
		return "", false
	}
	return hex.EncodeToString(b), true
}

// chooseOllamaVolume: --ollama-cache override, else the ~/.ollama share
// prompt (auto-yes in 10s), else the named volume.
func chooseOllamaVolume(u *ui, opts startOptions) string {
	home, _ := os.UserHomeDir()
	switch opts.ollamaCache {
	case "host":
		u.log("Using host model cache.")
		return filepath.Join(home, ".ollama")
	case "volume":
		u.log("Using named volume semiont-ollama-models for model cache.")
		return "semiont-ollama-models"
	}
	if home != "" {
		if _, err := os.Stat(filepath.Join(home, ".ollama")); err == nil {
			if promptShareCache(home) {
				u.log("Using host model cache.")
				return filepath.Join(home, ".ollama")
			}
		}
	}
	u.log("Using named volume semiont-ollama-models for model cache.")
	return "semiont-ollama-models"
}

// promptShareCache asks whether to mount ~/.ollama, auto-yes after 10s (and
// on EOF, matching `read -t 10 || answer=""`).
func promptShareCache(home string) bool {
	fmt.Printf("  Found local Ollama model cache at %s/.ollama. Share it? [Y/n] (auto-yes in 10s) ", home)
	ch := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		ch <- strings.TrimSpace(line)
	}()
	answer := ""
	select {
	case answer = <-ch:
	case <-time.After(10 * time.Second):
	}
	return answer != "n" && answer != "N"
}

func resolveHostAddr(rt string) string {
	alias := ""
	switch rt {
	case "docker":
		alias = "host.docker.internal"
	case "podman":
		alias = "host.containers.internal"
	}
	if alias != "" && runSilent(rt, "run", "--rm", "busybox:1.38.0", "nslookup", alias) == nil {
		return alias
	}
	out, _ := capture(rt, "run", "--rm", "busybox:1.38.0", "sh", "-c", "ip route | awk '/default/{print $3}'")
	return strings.Join(strings.Fields(out), "")
}

// removeStagedConfigs sweeps /tmp/semiont-config.* — shared by start's
// preflight and semiont stop.
func removeStagedConfigs() {
	dirs, _ := filepath.Glob("/tmp/semiont-config.*")
	for _, d := range dirs {
		_ = os.RemoveAll(d)
	}
}

// requirePortFree fails when a TCP port is already held, naming the
// offending process(es). By this point every semiont-* container has been
// swept under every installed runtime, so a holder is provably foreign —
// the launcher never signals it; killing it is the user's call, per
// incident. lsof -ti prints one PID per line when several processes hold a
// port (parent+child servers, SO_REUSEPORT), so everything here iterates
// over all of them.
func requirePortFree(u *ui, port int, service string) bool {
	out, err := capture("lsof", "-ti", fmt.Sprintf(":%d", port))
	if err != nil || out == "" {
		return true
	}
	pids := strings.Fields(out)
	u.fail("Port %d (needed for %s) is held by %s.", port, service, describeProcs(pids))
	fmt.Fprintln(os.Stderr, "  This is not a Semiont container. Stop it and re-run (e.g. kill "+strings.Join(pids, " ")+").")
	return false
}

// describeProcs renders "pid (comm), pid (comm)" for a set of PIDs.
func describeProcs(pids []string) string {
	procs := make([]string, 0, len(pids))
	for _, p := range pids {
		comm, err := capture("ps", "-p", p, "-o", "comm=")
		if err != nil || comm == "" {
			comm = "<unknown>"
		}
		procs = append(procs, fmt.Sprintf("%s (%s)", p, comm))
	}
	return strings.Join(procs, ", ")
}
