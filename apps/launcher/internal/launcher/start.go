package launcher

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
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

// portChecks: every published port the stack needs, checked up front so a
// conflict surfaces before any image work. Ollama's 11434 is checked later —
// only needed if no host Ollama is already serving it.
var portChecks = []struct {
	port    int
	service string
	observe bool // only checked when the Jaeger sidecar runs
}{
	{7474, "Neo4j HTTP", false},
	{7687, "Neo4j Bolt", false},
	{6333, "Qdrant", false},
	{5432, "PostgreSQL", false},
	{4000, "Backend", false},
	{9090, "Worker", false},
	{9091, "Smelter", false},
	{9092, "Weaver", false},
	{3000, "Frontend", false},
	{16686, "Jaeger UI", true},
	{4318, "Jaeger OTLP", true},
}

// The config TOMLs reference env vars as ${VAR} (required) or ${VAR:-default}
// (optional); only the required form is matched here. These are the ones the
// launcher injects itself and never demands from the user.
var injectedVars = map[string]bool{
	"BACKEND_HOST": true, "NEO4J_HOST": true, "QDRANT_HOST": true,
	"OLLAMA_HOST": true, "POSTGRES_HOST": true, "SEMIONT_WORKER_SECRET": true,
	"ADMIN_EMAIL": true, "ADMIN_PASSWORD": true,
}

var (
	envRefRe = regexp.MustCompile(`\$\{[A-Z_][A-Z0-9_]*\}`)
	emailRe  = regexp.MustCompile(`^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$`)
)

type startOptions struct {
	configName     string
	configSet      bool // --config given explicitly (drives --service compatibility)
	listConfigs    bool
	adminEmail     string
	adminPassword  string
	cleanOllama    bool
	forceKillPorts bool
	runtime        string
	observe        bool
	noObserveSet   bool // --no-observe given explicitly
	quiet          bool
	dryRun         bool
	ollamaCache    string // "", "host", or "volume"
	service        string // start just this one service
}

const startUsage = `Usage: semiont start [options]

Start a local Semiont stack with Neo4j, Qdrant, Ollama, PostgreSQL,
the Semiont API server, worker, smelter, weaver, and the frontend
(http://localhost:3000) — all in containers.

Options:
  --config <name>       Semiontconfig to use (default: ollama-gemma)
  --list-configs        List available configs and exit
  --service <name>      Start (restart) just this one service, leaving the rest
                        of the stack untouched: jaeger, neo4j, qdrant, ollama,
                        postgres, backend, worker, smelter, weaver, or frontend.
                        Rejoins a running stack's worker secret automatically;
                        OTel export is enabled iff Jaeger is up.
  --email <email>       Admin user email (requires --password)
  --password <pass>     Admin user password (requires --email)
  --clean-ollama        Remove the Ollama model cache volume and exit
  --force-kill-ports    Kill any non-Semiont process holding a needed port
  --runtime <name>      Container runtime: container, docker, or podman (default: first found)
  --no-observe          Skip the Jaeger sidecar (OTel traces + metrics run by default)
  --ollama-cache <c>    Model cache when starting an Ollama container: 'host'
                        (~/.ollama) or 'volume' (named volume) — skips the prompt
  --dry-run             Print the exact runtime commands a run would execute, then exit
  --quiet, -q           Suppress informational output
  --help, -h            Show this help

Examples:
  # Fully local with Ollama (default, no API key needed)
  semiont start --email admin@example.com --password password

  # Anthropic cloud inference
  export ANTHROPIC_API_KEY=<your-key>
  semiont start --config anthropic --email admin@example.com --password password

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
		case "--list-configs":
			opts.listConfigs = true
		case "--email":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.adminEmail = v
			i++
		case "--password":
			v, ok := needVal(i)
			if !ok {
				return 1
			}
			opts.adminPassword = v
			i++
		case "--clean-ollama":
			opts.cleanOllama = true
		case "--force-kill-ports":
			opts.forceKillPorts = true
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

	// --service compatibility: flags that don't apply to the named service are
	// rejected rather than silently ignored.
	if opts.service != "" {
		if _, known := startableServices[opts.service]; !known {
			u.fail("Unknown --service '%s' (expected: jaeger, neo4j, qdrant, ollama, postgres, backend, worker, smelter, weaver, or frontend)", opts.service)
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
			u.fail("--no-observe does not apply to --service: OTel export is enabled iff Jaeger is already running.")
			return 1
		case (opts.adminEmail != "" || opts.adminPassword != "") && opts.service != "backend":
			u.fail("--email/--password only apply to --service backend.")
			return 1
		case opts.ollamaCache != "" && opts.service != "ollama":
			u.fail("--ollama-cache only applies to --service ollama.")
			return 1
		case opts.configSet && !isConfigConsumer(opts.service):
			u.fail("--config only applies to --service backend, worker, smelter, or weaver.")
			return 1
		}
	}

	// Dry-run output is a machine-consumable plan; keep the narration off it.
	u = newUI(opts.quiet || opts.dryRun)
	if !opts.dryRun {
		u.stamp("semiont start")
	}

	// Resolve the KB root. A git clone is required — the backend versions the
	// event log via git — so fail with instructions rather than git's opaque
	// "not a repository" fatal when someone used GitHub's "Download ZIP" (or
	// has no git at all). Deliberately after arg parsing so --help works
	// anywhere.
	root, err := capture("git", "rev-parse", "--show-toplevel")
	if err != nil || root == "" {
		u.fail("This must run inside a git clone of the KB (the backend versions the event log via git).")
		fmt.Fprintln(os.Stderr, "  If you used GitHub's 'Download ZIP', clone the repository instead:  git clone <repo-url>")
		return 1
	}
	if err := os.Chdir(root); err != nil {
		u.fail("Cannot enter KB root %s: %v", root, err)
		return 1
	}

	if opts.adminEmail != "" || opts.adminPassword != "" {
		if opts.adminEmail == "" || opts.adminPassword == "" {
			u.fail("--email and --password must be provided together.")
			return 1
		}
		if !emailRe.MatchString(opts.adminEmail) {
			u.fail("Invalid --email: '%s'", opts.adminEmail)
			return 1
		}
		if len(opts.adminPassword) < 8 {
			u.fail("--password must be at least 8 characters.")
			return 1
		}
	}

	if opts.listConfigs {
		fmt.Println("Available configs:")
		printConfigNames()
		return 0
	}
	// Services that never read the config (infra, frontend) don't require it.
	configNeeded := opts.service == "" || isConfigConsumer(opts.service)
	configFile := filepath.Join(configDir, opts.configName+".toml")
	if configNeeded {
		if _, err := os.Stat(configFile); err != nil {
			u.fail("Config not found: %s", configFile)
			fmt.Println("Available configs:")
			printConfigNames()
			return 1
		}
	}

	rt, ok := selectRuntime(u, opts.runtime)
	if !ok {
		return 1
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
	u.log("Container runtime: %s", u.bold(rt))
	if configNeeded {
		u.log("Config: %s", u.bold(opts.configName))
	}
	u.log("Image version: %s", u.bold(version))

	var userEnv []string
	if configNeeded {
		userVars, err := requiredConfigVars(configFile)
		if err != nil {
			u.fail("Reading %s: %v", configFile, err)
			return 1
		}
		for _, v := range userVars {
			if opts.dryRun {
				userEnv = append(userEnv, "--env", v+"=<env:"+v+">")
				continue
			}
			val := os.Getenv(v)
			if val == "" {
				u.fail("Config '%s' references ${%s} but it is not set in the environment.", opts.configName, v)
				return 1
			}
			userEnv = append(userEnv, "--env", v+"="+val)
		}
	}

	if opts.dryRun {
		if opts.service != "" {
			renderServicePlan(rt, version, opts, userEnv)
		} else {
			renderStartPlan(rt, version, opts, userEnv)
		}
		return 0
	}
	if opts.service != "" {
		return runStartService(u, rt, version, root, configFile, opts, userEnv)
	}
	return runStart(u, rt, version, root, configFile, opts, userEnv)
}

func printConfigNames() {
	files, _ := filepath.Glob(filepath.Join(configDir, "*.toml"))
	for _, f := range files {
		fmt.Printf("  %s\n", strings.TrimSuffix(filepath.Base(f), ".toml"))
	}
}

// requiredConfigVars extracts the sorted set of required ${VAR} references
// from a config file, minus the launcher-injected ones.
func requiredConfigVars(configFile string) ([]string, error) {
	b, err := os.ReadFile(configFile)
	if err != nil {
		return nil, err
	}
	set := map[string]bool{}
	for _, m := range envRefRe.FindAllString(string(b), -1) {
		name := strings.TrimSuffix(strings.TrimPrefix(m, "${"), "}")
		if !injectedVars[name] {
			set[name] = true
		}
	}
	names := make([]string, 0, len(set))
	for n := range set {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, nil
}

// --- Command builders (shared by the real run and --dry-run) ---

func image(svc, version string) string {
	return fmt.Sprintf("%s/semiont-%s:%s", imageRegistry, svc, version)
}

func jaegerArgs() []string {
	return []string{"run", "-d", "--rm", "--name", "semiont-jaeger",
		"-p", "16686:16686", "-p", "4318:4318", "jaegertracing/all-in-one:1.76.0"}
}

func neo4jArgs() []string {
	return []string{"run", "-d", "--rm", "--name", "semiont-neo4j",
		"-p", "7474:7474", "-p", "7687:7687",
		"-e", "NEO4J_AUTH=neo4j/localpass", "-e", "NEO4J_ACCEPT_LICENSE_AGREEMENT=yes",
		"neo4j:5.26.28-community"}
}

func qdrantArgs() []string {
	return []string{"run", "-d", "--rm", "--name", "semiont-qdrant",
		"-p", "6333:6333", "qdrant/qdrant:v1.18.3"}
}

func ollamaArgs(volume string) []string {
	return []string{"run", "-d", "--rm", "--name", "semiont-ollama",
		"-p", "11434:11434", "-m", "24G", "-v", volume + ":/root/.ollama", "ollama/ollama"}
}

func postgresArgs() []string {
	return []string{"run", "-d", "--rm", "--name", "semiont-postgres",
		"-p", "5432:5432", "-e", "POSTGRES_PASSWORD=localpass", "-e", "POSTGRES_DB=semiont",
		"postgres:15.18-alpine"}
}

// backendArgs: the backend takes the four dependency hosts but must NOT
// receive BACKEND_HOST (publicURL derives from it; see the DID/site.domain
// history before ever changing this).
func backendArgs(kbRoot, stage, addr, secret, version string, userEnv, otel, admin []string) []string {
	a := []string{"run", "-d", "--rm", "--name", "semiont-backend",
		"--publish", "4000:4000", "--memory", "8G",
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
	a = append(a, admin...)
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
var sidecarSpecs = []struct {
	svc, label, mem, banner string
	port                    int
}{
	{"worker", "Worker pool", "2G", "Starting Worker Pool", 9090},
	{"smelter", "Smelter", "2G", "Starting Smelter", 9091},
	{"weaver", "Weaver", "3G", "Starting Weaver", 9092},
}

// runGated: the common run-detached-then-health-gate shape.
func runGated(u *ui, rt string, args []string, failLabel, waitLabel, url string, tries int) (time.Duration, bool) {
	u.echoCmd(rt, args...)
	if err := runDetached(rt, args...); err != nil {
		u.fail("%s failed to start.", failLabel)
		return 0, false
	}
	return waitForHTTP(u, waitLabel, url, tries)
}

// runBackend starts the backend and runs BOTH its gates: host-side health,
// then container-gateway reachability — the sidecars dial addr:4000 (not
// localhost) and fatally exit if their first backend fetch fails, so host
// health alone doesn't prove the path they need.
func runBackend(u *ui, rt, root, stage, addr, secret, version string, userEnv, otel, admin []string) int {
	bArgs := backendArgs(root, stage, addr, secret, version, userEnv, otel, admin)
	u.echoCmd(rt, bArgs...)
	if err := runDetached(rt, bArgs...); err != nil {
		u.fail("Backend failed to start.")
		return 1
	}
	u.log("Waiting for backend health...")
	d, ok := waitForHTTP(u, "Backend", "http://localhost:4000/api/health", 120)
	if !ok {
		return 1
	}
	u.ok("Backend healthy %s", u.dim("("+took(d)+")"))

	u.log("Verifying backend reachable from containers...")
	reachT0 := time.Now()
	reachable := false
	for i := 0; i < 20; i++ {
		if runSilent(rt, "run", "--rm", "busybox:1.38.0", "sh", "-c",
			fmt.Sprintf("wget -q -O- http://%s:4000/api/health", addr)) == nil {
			reachable = true
			break
		}
		time.Sleep(time.Second)
	}
	if !reachable {
		u.fail("Backend not reachable from containers at %s:4000 within 20s.", addr)
		return 1
	}
	u.ok("Backend reachable from containers %s", u.dim("("+took(time.Since(reachT0))+")"))
	return 0
}

// runSidecar starts one make-meaning sidecar and gates on its /health.
func runSidecar(u *ui, rt string, sc struct {
	svc, label, mem, banner string
	port                    int
}, stage, addr, secret, version string, userEnv, otel []string) int {
	args := sidecarArgs(sc.svc, sc.mem, sc.port, stage, addr, secret, version, userEnv, otel)
	d, ok := runGated(u, rt, args, sc.label, sc.label, fmt.Sprintf("http://localhost:%d/health", sc.port), 30)
	if !ok {
		return 1
	}
	u.ok("%s healthy (http://localhost:%d) %s", sc.label, sc.port, u.dim("("+took(d)+")"))
	return 0
}

// --- The real run ---

func runStart(u *ui, rt, version, root, configFile string, opts startOptions, userEnv []string) int {
	t0 := time.Now()
	// Resolve the host address for container networking. Every inter-service
	// hop dials the HOST (hub-and-spoke over published ports), so this must be
	// an address that reaches the host FROM INSIDE a container — and that is
	// runtime-specific:
	//   - Apple container: one VM per container; the default gateway on the
	//     shared bridge IS the Mac host. The gateway probe is correct.
	//   - Docker Desktop (mac/win): the bridge gateway is internal to Docker's
	//     Linux VM and does NOT reach the host (measured: host Ollama on
	//     0.0.0.0 was unreachable at 172.17.0.1). The injected DNS name
	//     host.docker.internal does. Docker on Linux injects no such name by
	//     default — there the bridge gateway DOES reach host-published ports,
	//     so the gateway probe is the fallback.
	//   - podman: same pattern with host.containers.internal.
	// Probe, don't assume.
	addr := resolveHostAddr(rt)
	if addr == "" {
		u.fail("Could not determine host address for container networking.")
		fmt.Fprintln(os.Stderr, "  Neither the runtime's host alias nor the default-gateway probe returned a result.")
		return 1
	}
	u.log("Host address: %s", u.dim(addr))

	// Preflight: stop prior Semiont containers, verify required ports are
	// free — up front so a conflict surfaces before any image work.
	//
	// `stop` only halts a running container; under Apple Container the stopped
	// instance persists and the next `run --name <c>` fails with "already
	// exists". `rm` after `stop` (both best-effort) makes the loop idempotent
	// across all three states: not present, running, or stopped-but-not-removed.
	u.banner("Preflight")
	u.log("Removing prior containers %s", u.dim(fmt.Sprintf("(stop+rm, %d names; exact commands: semiont start --dry-run)", len(preflightNames))))
	removed := 0
	for _, c := range preflightNames {
		stopped := runSilent(rt, "stop", c) == nil
		rmed := runSilent(rt, "rm", c) == nil
		if stopped || rmed {
			removed++
		}
	}
	if removed == 0 {
		u.ok("No prior containers")
	} else {
		u.ok("Removed %d prior container(s)", removed)
	}
	// Staged config copies from previous runs (semiont stop also removes
	// these). Safe to delete only here, after the old stack's containers
	// (which mounted them) are stopped — this run's own staging is created
	// below, after this sweep.
	removeStagedConfigs()
	time.Sleep(time.Second)

	for _, pc := range portChecks {
		if pc.observe && !opts.observe {
			continue
		}
		if !requirePortFree(u, pc.port, pc.service, opts.forceKillPorts) {
			return 1
		}
	}
	u.ok("Required ports are free")

	// Stage per-service config copies — each service gets its OWN copy to
	// mount; do not "simplify" this back to one shared file. Under Apple
	// Container (one VM per container, each with its own virtiofs share),
	// mounting the same host file into a second VM transiently breaks existing
	// mounts of that file in other VMs (measured: a 50ms-interval read loop
	// showed ~100ms of read failures exactly when another container mounted
	// the same file). The backend is the victim: its CMD re-reads
	// ~/.semiontconfig across several CLI invocations while the sidecars
	// launch and mount theirs, and the CLI treats an unreadable config as
	// "not configured" — a shared file intermittently killed a healthy backend
	// mid-chain. Private copies mean no host file is ever mounted twice.
	//
	// docker/podman don't need this, but the copies are harmless there, so one
	// code path serves all runtimes. The staging dir deliberately outlives
	// this process — the running containers mount these copies; semiont stop
	// (and the next run's preflight sweep) removes it.
	//
	// The staging dir MUST be under /tmp, not $TMPDIR: Apple Container cannot
	// sustain mounts from /var/folders (macOS's per-user private temp) — the
	// first read succeeds, then every subsequent read fails (measured: 1 ok /
	// 29 fail over 30s, vs 30/30 ok from /tmp).
	stage, err := os.MkdirTemp("/tmp", "semiont-config.")
	if err != nil {
		u.fail("Cannot create config staging dir: %v", err)
		return 1
	}
	cfg, err := os.ReadFile(configFile)
	if err != nil {
		u.fail("Reading %s: %v", configFile, err)
		return 1
	}
	for _, svc := range []string{"backend", "worker", "smelter", "weaver"} {
		if err := os.WriteFile(filepath.Join(stage, svc+".toml"), cfg, 0o644); err != nil {
			u.fail("Staging config for %s: %v", svc, err)
			return 1
		}
	}

	// Pull explicitly, up front, so a bad version/registry fails before any
	// dep containers start — a `run` alone reuses a cached :latest forever.
	u.banner("Pulling Images")
	if version == "local" {
		u.log("Using locally-built %s images (skipping pull)", u.bold(":local"))
	} else {
		for _, svc := range semiontServices {
			args := pullArgs(rt, image(svc, version))
			u.echoCmd(rt, args...)
			if err := runVisible(rt, args...); err != nil {
				u.fail("Pull failed: %s", image(svc, version))
				return 1
			}
		}
		u.ok("Images pulled")
	}

	// Jaeger — on by default (skip with --no-observe): the Semiont processes
	// push OTLP traces + metrics to it over one endpoint env var.
	var otel []string
	if opts.observe {
		u.banner("Jaeger")
		u.echoCmd(rt, jaegerArgs()...)
		if err := runDetached(rt, jaegerArgs()...); err != nil {
			u.fail("Jaeger failed to start.")
			return 1
		}
		d, ok := waitForHTTP(u, "Jaeger UI", "http://localhost:16686", 30)
		if !ok {
			return 1
		}
		u.ok("Jaeger UI on http://localhost:16686 (OTLP collector: %s:4318) %s", addr, u.dim("("+took(d)+")"))
		otel = otelArgs(addr)
	}

	u.banner("Neo4j")
	u.echoCmd(rt, neo4jArgs()...)
	if err := runDetached(rt, neo4jArgs()...); err != nil {
		u.fail("Neo4j failed to start.")
		return 1
	}
	d, ok := waitForHTTP(u, "Neo4j", "http://localhost:7474", 30)
	if !ok {
		return 1
	}
	u.ok("Neo4j on bolt://localhost:7687 (browser: http://localhost:7474) %s", u.dim("("+took(d)+")"))

	u.banner("Qdrant")
	u.echoCmd(rt, qdrantArgs()...)
	if err := runDetached(rt, qdrantArgs()...); err != nil {
		u.fail("Qdrant failed to start.")
		return 1
	}
	d, ok = waitForHTTP(u, "Qdrant", "http://localhost:6333/readyz", 15)
	if !ok {
		return 1
	}
	u.ok("Qdrant on http://localhost:6333 %s", u.dim("("+took(d)+")"))

	if code := startOllama(u, rt, addr, opts); code != 0 {
		return code
	}

	u.banner("PostgreSQL")
	u.echoCmd(rt, postgresArgs()...)
	if err := runDetached(rt, postgresArgs()...); err != nil {
		u.fail("PostgreSQL failed to start.")
		return 1
	}
	d, ok = waitForPG(u, rt, addr, 5432, 20)
	if !ok {
		return 1
	}
	u.ok("PostgreSQL on port 5432 %s", u.dim("("+took(d)+")"))

	secret := os.Getenv("SEMIONT_WORKER_SECRET")
	if secret == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			u.fail("Generating worker secret: %v", err)
			return 1
		}
		secret = hex.EncodeToString(b)
	}

	u.banner("Starting Backend")
	u.log("http://localhost:4000")
	u.log("Worker secret: %s", u.dim("(generated)"))
	var admin []string
	if opts.adminEmail != "" && opts.adminPassword != "" {
		admin = []string{"--env", "ADMIN_EMAIL=" + opts.adminEmail, "--env", "ADMIN_PASSWORD=" + opts.adminPassword}
		u.log("Admin user: %s", u.bold(opts.adminEmail))
	}
	if code := runBackend(u, rt, root, stage, addr, secret, version, userEnv, otel, admin); code != 0 {
		return code
	}

	// The weaver note: the graph projection is standalone-only — the backend
	// no longer applies events to Neo4j in-process. Without the weaver the
	// graph stays empty and every gather 404s at the buildKnowledgeGraph
	// barrier. Its health reports readiness before catch-up completes.
	for _, sc := range sidecarSpecs {
		u.banner(sc.banner)
		if code := runSidecar(u, rt, sc, stage, addr, secret, version, userEnv, otel); code != 0 {
			return code
		}
	}

	// Frontend: a static SPA server — no config mount and no service env; the
	// browser talks to the backend directly on localhost:4000.
	u.banner("Starting Frontend")
	d, ok = runGated(u, rt, frontendArgs(version), "Frontend", "Frontend", "http://localhost:3000", 30)
	if !ok {
		return 1
	}
	u.ok("Frontend on http://localhost:3000 %s", u.dim("("+took(d)+")"))

	// Summary; the stack runs detached and this process exits — bring the
	// stack up, say where everything is, and get out of the way (compose up
	// -d / supabase start style). Logs and teardown are explicit follow-up
	// commands, not a resident supervisor. URLs are printed bare because
	// terminals auto-link plain URLs; OSC 8 support is uneven.
	//
	// Restart story, honestly: these containers run --rm with NO restart
	// policy (docker forbids --rm + --restart, and Apple `container` has no
	// restart policies) — a crashed service stays down until you rerun
	// `semiont start`. Services fail FAST by design; a dead container is the
	// visible, diagnosable signal. The compose path adds `restart: on-failure`;
	// this launcher deliberately does not pretend to.
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
	if opts.adminEmail != "" {
		fmt.Printf("  Sign in at http://localhost:3000 as %s with your --password.\n", u.bold(opts.adminEmail))
		fmt.Println()
	}
	fmt.Printf("  Check health:  %s\n", u.bold("semiont status"))
	fmt.Printf("  Follow logs:   %s\n", u.bold("semiont logs"))
	fmt.Printf("  Stop stack:    %s\n", u.bold("semiont stop"))
	fmt.Println()
	return 0
}

// startOllama reuses a host Ollama when one is serving 11434 and reachable
// from containers; otherwise starts the semiont-ollama container.
func startOllama(u *ui, rt, addr string, opts startOptions) int {
	u.banner("Ollama")
	if httpOK("http://localhost:11434/api/version") {
		if runSilent(rt, "run", "--rm", "busybox:1.38.0", "sh", "-c",
			fmt.Sprintf("wget -q -O- http://%s:11434/api/version", addr)) == nil {
			u.ok("Using host Ollama at http://localhost:11434")
			return 0
		}
		fmt.Println()
		u.warn("Ollama is running on the host but not reachable from containers.")
		fmt.Printf("   The backend runs in a container and needs Ollama at %s:11434.\n", addr)
		fmt.Println()
		if runSilent("pgrep", "-f", "Ollama.app/Contents") == nil {
			fmt.Println("   Detected: Ollama Desktop app")
		} else if runSilent("pgrep", "-f", "ollama serve") == nil {
			fmt.Println("   Detected: ollama serve daemon")
		}
		fmt.Println()
		fmt.Println("   Fix: configure Ollama to listen on all interfaces:")
		fmt.Printf("     %s\n", u.bold("launchctl setenv OLLAMA_HOST 0.0.0.0"))
		fmt.Println("   Then fully quit Ollama Desktop from the menu bar and relaunch it.")
		fmt.Println()
		fmt.Println("   (If launchctl doesn't stick, quit Ollama Desktop entirely and run")
		fmt.Printf("    %s from a terminal.)\n", u.bold("OLLAMA_HOST=0.0.0.0:11434 ollama serve"))
		fmt.Println()
		return 1
	}

	u.log("No host Ollama detected — starting container...")
	u.echoCmd(rt, "stop", "semiont-ollama")
	runPassthrough(rt, "stop", "semiont-ollama")
	time.Sleep(time.Second)
	if !requirePortFree(u, 11434, "Ollama", opts.forceKillPorts) {
		return 1
	}

	home, _ := os.UserHomeDir()
	volume := ""
	switch opts.ollamaCache {
	case "host":
		volume = filepath.Join(home, ".ollama")
		u.log("Using host model cache.")
	case "volume":
		volume = "semiont-ollama-models"
		u.log("Using named volume semiont-ollama-models for model cache.")
	default:
		if home != "" {
			if _, err := os.Stat(filepath.Join(home, ".ollama")); err == nil {
				if promptShareCache(home) {
					volume = filepath.Join(home, ".ollama")
					u.log("Using host model cache.")
				}
			}
		}
		if volume == "" {
			volume = "semiont-ollama-models"
			u.log("Using named volume semiont-ollama-models for model cache.")
		}
	}

	u.echoCmd(rt, ollamaArgs(volume)...)
	if err := runDetached(rt, ollamaArgs(volume)...); err != nil {
		u.fail("Ollama container failed to start.")
		return 1
	}
	d, ok := waitForHTTP(u, "Ollama", "http://localhost:11434/api/version", 30)
	if !ok {
		return 1
	}
	u.ok("Ollama container on http://localhost:11434 (24 GB memory) %s", u.dim("("+took(d)+")"))
	return 0
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

// requirePortFree fails (or, with force, kills and re-verifies) when a TCP
// port is already held, naming the offending process(es). lsof -ti prints one
// PID per line when several processes hold a port (parent+child servers,
// SO_REUSEPORT), so everything here iterates over all of them.
func requirePortFree(u *ui, port int, service string, forceKill bool) bool {
	out, err := capture("lsof", "-ti", fmt.Sprintf(":%d", port))
	if err != nil || out == "" {
		return true
	}
	pids := strings.Fields(out)
	procs := make([]string, 0, len(pids))
	for _, p := range pids {
		comm, err := capture("ps", "-p", p, "-o", "comm=")
		if err != nil || comm == "" {
			comm = "<unknown>"
		}
		procs = append(procs, fmt.Sprintf("%s (%s)", p, comm))
	}
	desc := strings.Join(procs, ", ")
	if forceKill {
		u.warn("Port %d (needed for %s) held by %s — killing (--force-kill-ports).", port, service, desc)
		for _, p := range pids {
			if pid, err := strconv.Atoi(p); err == nil {
				_ = syscall.Kill(pid, syscall.SIGTERM)
			}
		}
		time.Sleep(time.Second)
		if out, err := capture("lsof", "-ti", fmt.Sprintf(":%d", port)); err == nil && out != "" {
			u.fail("Port %d still held after kill (%s).", port, strings.Join(strings.Fields(out), " "))
			return false
		}
		return true
	}
	u.fail("Port %d (needed for %s) is held by %s.", port, service, desc)
	fmt.Fprintln(os.Stderr, "  Stop the conflicting process and re-run, or pass --force-kill-ports.")
	return false
}
