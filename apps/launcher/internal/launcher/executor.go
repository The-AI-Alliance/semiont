package launcher

// executor.go — the two walking modes for launch flows (see
// .plans/LAUNCHER-ROLE-EXECUTOR.md). Flows (flows.go) touch the world only
// through this interface; liveExec runs the stack, planExec renders
// --dry-run. EFFECT methods are the drift-proof boundary: argv, ports, URLs,
// tries, and record contents exist once, in the flow. DECORATION methods are
// deliberately one-sided (say = live narration, note = plan comments): a
// plan is a plan, not a transcript.

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	toml "github.com/pelletier/go-toml/v2"
)

type executor interface {
	// --- effects ---
	stopRm(name string) bool        // teardown; reports whether anything existed
	sweepStray(names []string) bool // stop+rm the names under every OTHER installed runtime; reports whether anything existed
	settle(ports ...int)            // wait for torn-down ports to be released
	sweepStaging()                  // /tmp/semiont-config.* removal (+ state forget)
	portChecks(ports []portNeed) bool
	portCheck(p portNeed) bool    // singular wording in plan mode
	recordPorts(ports []portNeed) // note claimed host ports in the belief record
	hostOllamaReachable(addr string, port int) bool
	stageAll(configFile, envName, addr string) (string, bool)      // per-service config copies; returns stage dir
	stageOne(svc, configFile, envName, addr string) (string, bool) // one service's fresh private copy
	initStack(root, config, version, addr, stage string)           // begin the belief record
	pull(img string) bool
	runDetached(args []string) (string, bool)                      // echo + run -d; returns runtime-reported id
	waitHTTP(label, url string, seconds int) (time.Duration, bool) // wall-clock budget, not attempts
	waitPG(addr string, port, seconds int) (time.Duration, bool)
	probeTCP(role string, rp rolePlan) bool // external-role reachability
	backendReachable(addr string, port int) bool
	resolveAddr() (string, bool) // container→host address ("<host-addr>" in plan mode)
	either(cond func() bool, then, els func() int) int
	otelDetect(addr string) []string       // --service: OTel iff traces is up
	recoverSecret() (string, bool)         // --service: rejoin the running stack's secret
	workerSecret() (string, bool)          // full start: env or generated
	jwtSecret(root string) (string, bool)  // backend token-signing key: env, else persisted per-root, else generated
	ollamaVolume(opts startOptions) string // model-cache choice (prompt is live-only)
	record(role, id, image, provided, endpoint, driver string)
	providerOf(role string) string        // how an already-recorded role was provided
	noteContainer(role, container string) // stamp a launched container on a container-less role
	browserCurrent(desired string) bool   // running AND image identity matches
	browserRecord() *serviceState         // the machine-level browser record
	recordBrowser(id, image, version string, port int)
	dumpLogs(container, svc string)                             // failed health gate: show the crash where it is
	verifyRemoteModels(role, base, key string, models []string) // record /v1/models metadata; warn on unlisted
	ensureModels(base string, models []modelNeed)               // pull configured ollama models that are absent
	stateMounts(role, image, root string) ([]string, bool)      // persistent-state run args; !ok = refuse (data written by another image)
	stateMountsShared(role, root string) ([]string, bool)       // the same mounts WITHOUT claiming the image stamp (a reader beside the stamp's owner)
	val(live, plan string) string                               // mode-scoped value (kb root, admin password)
	rtName() string

	// --- decoration ---
	banner(s string)
	dim(s string) string
	bold(s string) string
	say(kind sayKind, format string, a ...any) // live narration; nothing in plan mode
	note(format string, a ...any)              // plan comment; nothing in live mode
}

type sayKind int

const (
	sayLog sayKind = iota
	sayOK
	sayWarn
	sayFail // also marks the run failed (stderr)
)

// --- live ---

type liveExec struct {
	u  *ui
	rt string
	st *stackState
	// existing: semiont-* container names per runtime, listed once and cached
	// for the life of the command (see present).
	existing map[string]map[string]bool
	version  string // SEMIONT_VERSION, for records created lazily (--service mode)
	root     string // KB root, ditto ("" for root-free services)
	// plan lets record() stamp each role's configured models without every
	// flow having to pass them; models are config truth, so they belong to
	// the record the same way the driver does.
	plan *launchPlan
}

// present lists the semiont-* containers that EXIST under a runtime — running
// or stopped, because a stopped container still holds its name and the next
// `run --name` fails on it.
//
// ONE list per runtime, cached for the life of the command. The teardown used
// to ask by firing `stop` then `rm` at all nine names blindly, on every
// installed runtime: 54 fork/execs to discover, usually, that nothing was
// there. It also inferred "did anything exist?" from the exit codes of commands
// it EXPECTED to fail, which is why the settle below then slept a second on a
// maybe. Asking once is both faster and a straight answer.
func (x *liveExec) present(rt string) map[string]bool {
	if x.existing == nil {
		x.existing = map[string]map[string]bool{}
	}
	if got, ok := x.existing[rt]; ok {
		return got
	}
	names := map[string]bool{}
	// The listing idiom the launcher already trusts (see logs.go stackRuntime),
	// with -a so STOPPED containers are included — the ones a teardown most
	// needs to find.
	var out string
	var err error
	if rt == "container" {
		out, err = capture(rt, "list", "-a")
	} else {
		out, err = capture(rt, "ps", "-a", "--format", "{{.Names}}")
	}
	if err == nil {
		for _, line := range strings.Split(out, "\n") {
			if f := strings.Fields(line); len(f) > 0 && strings.HasPrefix(f[0], "semiont-") {
				names[f[0]] = true
			}
		}
	}
	// A runtime that cannot be listed yields an empty set, and every later
	// stop/rm is skipped. That is the honest failure: unknown is not "present",
	// and firing teardown at a runtime that would not answer a list is how the
	// old code spent 18 spawns learning nothing.
	x.existing[rt] = names
	return names
}

func (x *liveExec) stopRm(name string) bool {
	if !x.present(x.rt)[name] {
		return false // not there; nothing to stop, nothing to remove
	}
	stopped := runSilent(x.rt, "stop", name) == nil
	rmed := runSilent(x.rt, "rm", name) == nil
	delete(x.existing[x.rt], name)
	return stopped || rmed
}

// sweepStray: the cross-runtime belt-and-braces — after this, no semiont-*
// container exists under ANY installed runtime, so a port holder at check
// time is provably foreign. Idempotent no-ops when clean.
func (x *liveExec) sweepStray(names []string) bool {
	swept := false
	for _, rt := range installedRuntimes() {
		if rt == x.rt {
			continue
		}
		here := x.present(rt)
		removed := 0
		for _, c := range names {
			if !here[c] {
				continue
			}
			stopped := runSilent(rt, "stop", c) == nil
			rmed := runSilent(rt, "rm", c) == nil
			if stopped || rmed {
				removed++
			}
		}
		if removed > 0 {
			swept = true
			x.u.warn("Removed %d stray Semiont container(s) under %s.", removed, rt)
		}
	}
	return swept
}

// settle waits for the named ports to be released after a teardown. See
// settlePorts: a condition, not a duration.
func (x *liveExec) settle(ports ...int) { settlePorts(ports...) }

func (x *liveExec) portCheck(p portNeed) bool {
	return requirePortFree(x.u, p.port, p.label)
}

// hostOllamaReachable: a host Ollama is serving — confirm containers can
// reach it, else print the Ollama-Desktop diagnostics and fail (measured:
// Docker Desktop's bridge gateway does not reach the Mac host).
func (x *liveExec) hostOllamaReachable(addr string, port int) bool {
	if runSilent(x.rt, "run", "--rm", "busybox:1.38.0", "sh", "-c",
		fmt.Sprintf("wget -q -O- http://%s:%d/api/version", addr, port)) == nil {
		return true
	}
	fmt.Println()
	x.u.warn("Ollama is running on the host but not reachable from containers.")
	fmt.Printf("   The backend runs in a container and needs Ollama at %s:%d.\n", addr, port)
	fmt.Println()
	if runSilent("pgrep", "-f", "Ollama.app/Contents") == nil {
		fmt.Println("   Detected: Ollama Desktop app")
	} else if runSilent("pgrep", "-f", "ollama serve") == nil {
		fmt.Println("   Detected: ollama serve daemon")
	}
	fmt.Println()
	fmt.Println("   Fix: configure Ollama to listen on all interfaces:")
	fmt.Printf("     %s\n", x.u.bold("launchctl setenv OLLAMA_HOST 0.0.0.0"))
	fmt.Println("   Then fully quit Ollama Desktop from the menu bar and relaunch it.")
	fmt.Println()
	fmt.Println("   (If launchctl doesn't stick, quit Ollama Desktop entirely and run")
	fmt.Printf("    %s from a terminal.)\n", x.u.bold("OLLAMA_HOST=0.0.0.0:11434 ollama serve"))
	fmt.Println()
	return false
}

func (x *liveExec) sweepStaging() {
	removeStagedConfigs()
	forgetStack("local") // codespace stacks' records are not ours to erase
}

func (x *liveExec) portChecks(ports []portNeed) bool {
	for _, pc := range ports {
		if !requirePortFree(x.u, pc.port, pc.label) {
			return false
		}
	}
	return true
}

// recordPorts appends the host ports this start claims to the belief record
// — stop's release verification reads them back. Lazy-inits the record the
// same way record() does (--service mode).
func (x *liveExec) recordPorts(ports []portNeed) {
	if len(ports) == 0 {
		return
	}
	if x.st == nil {
		x.st = loadLocalState()
		if x.st == nil {
			x.st = &stackState{
				Runtime: x.rt, KBRoot: x.root, KBDid: loadKBIdentity(x.root).didWeb(),
				Version: x.version, Services: map[string]serviceState{},
			}
		}
	}
	have := make(map[int]bool, len(x.st.Ports))
	for _, p := range x.st.Ports {
		have[p] = true
	}
	for _, p := range ports {
		if !have[p.port] {
			x.st.Ports = append(x.st.Ports, p.port)
			have[p.port] = true
		}
	}
	saveStack(x.st)
}

func (x *liveExec) stageDir() (string, bool) {
	stage, err := os.MkdirTemp("/tmp", "semiont-config.")
	if err != nil {
		x.u.fail("Cannot create config staging dir: %v", err)
		return "", false
	}
	return stage, true
}

// archivistDialers: the services that resolve the Archivist's address from
// their staged config, and so must be handed it. The gateway proxies bytes
// onto the record; the Smelter, the Librarian and the Worker read bytes from
// it directly (SINGLE-KB-MOUNT P4). All four refuse to boot without it, which
// is the point — a process that cannot reach the record has nothing to do.
//
// The Archivist itself is absent: it IS the record, and holds the mount.
var archivistDialers = map[string]bool{"backend": true, "smelter": true, "librarian": true, "worker": true}

// kbIdentityStaged: the services that describe a KB tree they do not mount,
// and so must be handed its committed identity rather than reading it
// (SINGLE-KB-MOUNT P5/P6). The Archivist is absent because it HOLDS the
// tree; the Smelter and Worker are absent because they never name the KB.
var kbIdentityStaged = map[string]bool{"backend": true, "librarian": true}

// stagedConfig applies every launcher-owned patch a service's config needs.
// ONE decider: `stageAll` and `stageOne` stage the same services from the
// same source and must agree on what each one gets.
func (x *liveExec) stagedConfig(svc string, cfg []byte, envName, addr string) []byte {
	if archivistDialers[svc] {
		cfg = patchArchivistTopology(cfg, envName, addr)
	}
	if kbIdentityStaged[svc] {
		cfg = patchKBIdentity(cfg, effectiveKBName(x.root), committedDomain(x.root))
	}
	return cfg
}

// patchArchivistTopology appends [environments.<env>.archivist] — with the
// LITERAL address the launcher computed — to a staged config.
// Deployment topology is the launcher's to know, never the KB config's to
// declare: a ${VAR} here would demand that var of every config consumer,
// which is how ARCHIVIST_HOST briefly existed. A hand-written section wins —
// the operator is describing a topology the launcher cannot see. Invalid
// TOML passes through untouched; the consumer's own loader owns that error.
func patchArchivistTopology(cfg []byte, envName, addr string) []byte {
	var doc map[string]any
	if err := toml.Unmarshal(cfg, &doc); err != nil {
		return cfg
	}
	if envs, ok := doc["environments"].(map[string]any); ok {
		if env, ok := envs[envName].(map[string]any); ok {
			if _, has := env["archivist"]; has {
				return cfg
			}
		}
	}
	stanza := fmt.Sprintf("\n# Staged by the launcher: where THIS stack's archivist listens.\n[environments.%s.archivist]\nhost = %q\nport = %d\n",
		envName, addr, roles["archivist"].ports[0].port)
	return append(cfg, []byte(stanza)...)
}

// patchKBIdentity appends a top-level [kb] — the KB's committed identity card
// — to a staged config (SINGLE-KB-MOUNT D4/P5). Two facts, both read off
// `<root>/.semiont/config`, for the two services that no longer mount the tree
// they describe:
//
//   name   — how the Librarian and the gateway locate the views the Archivist
//            materializes under the shared state mount.
//   domain — the KB's permanent did:web identity. The gateway REFUSES to boot
//            without it (KB-IDENTITY decision 8), and once it stops mounting
//            /kb this staged copy is the only way it can see the committed
//            value. Omitted when the KB declares none, so the refusal still
//            fires: staging a fabricated identity is the one thing worse than
//            failing loudly.
//
// Top-level deliberately: an environment section cannot override what sits
// beside [defaults]. A hand-written [kb] wins — the escape hatch for an
// operator whose state tree lives under a name the current root would not
// derive. Invalid TOML passes through untouched; the consumer's own loader
// owns that error.
func patchKBIdentity(cfg []byte, name, domain string) []byte {
	var doc map[string]any
	if err := toml.Unmarshal(cfg, &doc); err != nil {
		return cfg
	}
	if _, has := doc["kb"]; has {
		return cfg
	}
	stanza := fmt.Sprintf("\n# Staged by the launcher: this KB's committed identity (SINGLE-KB-MOUNT D4).\n[kb]\nname = %q\n", name)
	if domain != "" {
		stanza += fmt.Sprintf("domain = %q\n", domain)
	}
	return append(cfg, []byte(stanza)...)
}

func (x *liveExec) stageAll(configFile, envName, addr string) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	cfg, err := os.ReadFile(configFile)
	if err != nil {
		x.u.fail("Reading %s: %v", configFile, err)
		return "", false
	}
	for _, svc := range []string{"backend", "worker", "smelter", "weaver", "archivist", "librarian"} {
		out := x.stagedConfig(svc, cfg, envName, addr)
		if err := os.WriteFile(filepath.Join(stage, svc+".toml"), out, 0o644); err != nil {
			x.u.fail("Staging config for %s: %v", svc, err)
			return "", false
		}
	}
	return stage, true
}

func (x *liveExec) stageOne(svc, configFile, envName, addr string) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	cfg, err := os.ReadFile(configFile)
	if err != nil {
		x.u.fail("Reading %s: %v", configFile, err)
		return "", false
	}
	if err := os.WriteFile(filepath.Join(stage, svc+".toml"), x.stagedConfig(svc, cfg, envName, addr), 0o644); err != nil {
		x.u.fail("Staging config for %s: %v", svc, err)
		return "", false
	}
	return stage, true
}

func (x *liveExec) initStack(root, config, version, addr, stage string) {
	x.st = &stackState{
		Runtime: x.rt, KBRoot: root, KBDid: loadKBIdentity(root).didWeb(),
		Config: config, Version: version,
		HostAddr: addr, Stage: stage, Services: map[string]serviceState{},
	}
}

func (x *liveExec) pull(img string) bool {
	args := pullArgs(x.rt, img)
	x.u.echoCmd(x.rt, args...)
	if err := runVisible(x.rt, args...); err != nil {
		x.u.fail("Pull failed: %s", img)
		return false
	}
	return true
}

func (x *liveExec) runDetached(args []string) (string, bool) {
	x.u.echoCmd(x.rt, args...)
	id, err := runDetached(x.rt, args...)
	if err != nil {
		return "", false
	}
	return id, true
}

func (x *liveExec) waitHTTP(label, url string, seconds int) (time.Duration, bool) {
	return waitForHTTP(x.u, label, url, seconds)
}

func (x *liveExec) waitPG(addr string, port, seconds int) (time.Duration, bool) {
	return waitForPG(x.u, x.rt, addr, port, seconds)
}

func (x *liveExec) probeTCP(role string, rp rolePlan) bool {
	return verifyExternal(x.u, role, rp)
}

func (x *liveExec) backendReachable(addr string, port int) bool {
	x.u.log("Verifying backend reachable from containers...")
	t0 := time.Now()
	for i := 0; i < 20; i++ {
		if runSilent(x.rt, "run", "--rm", "busybox:1.38.0", "sh", "-c",
			fmt.Sprintf("wget -q -O- http://%s:%d/api/health", addr, port)) == nil {
			x.u.ok("Backend reachable from containers %s", x.u.dim("("+took(time.Since(t0))+")"))
			return true
		}
		time.Sleep(time.Second)
	}
	x.u.fail("Backend not reachable from containers at %s:%d within 20s.", addr, port)
	return false
}

func (x *liveExec) resolveAddr() (string, bool) {
	addr := resolveHostAddr(x.rt)
	if addr == "" {
		x.u.fail("Could not determine host address for container networking.")
		if fixit := daemonDownFixit(x.rt); fixit != "" {
			fmt.Fprintln(os.Stderr, "  "+fixit)
		} else {
			fmt.Fprintln(os.Stderr, "  Neither the runtime's host alias nor the default-gateway probe returned a result.")
		}
		return "", false
	}
	return addr, true
}

// daemonDownFixit: an empty host-address probe usually isn't networking at
// all — the runtime's daemon is down, and the probe is merely the first
// command in a start whose failure is fatal (the preflight sweeps that run
// before it swallow their errors). Ask the runtime directly; when its own
// liveness check fails, say WHICH check failed and name the likely fix —
// a failed check is evidence, not proof, so the wording claims no more.
func daemonDownFixit(rt string) string {
	switch rt {
	case "container":
		if runSilent(rt, "system", "status") != nil {
			return "`container system status` failed — the runtime's API server looks down. Start it: container system start"
		}
	case "docker":
		if runSilent(rt, "info") != nil {
			return "`docker info` failed — the Docker daemon looks unreachable. Start Docker Desktop (or dockerd), then retry."
		}
	case "podman":
		if runSilent(rt, "info") != nil {
			return "`podman info` failed — the Podman machine looks unreachable. Start it: podman machine start"
		}
	}
	return ""
}

func (x *liveExec) either(cond func() bool, then, els func() int) int {
	if cond() {
		return then()
	}
	return els()
}

func (x *liveExec) otelDetect(addr string) []string {
	if httpOK("http://localhost:16686") {
		x.u.log("Jaeger detected — OTel export enabled")
		return otelArgs(addr)
	}
	return nil
}

func (x *liveExec) recoverSecret() (string, bool) {
	return serviceSecret(x.u, x.rt)
}

func (x *liveExec) workerSecret() (string, bool) {
	return fullStartSecret(x.u)
}

// jwtSecret is per-root and persisted, so a --service backend restart resolves
// the SAME value a full start did — no inspect-based recovery needed (contrast
// recoverSecret, which exists because the worker secret is never persisted).
//
// root is PASSED rather than read off x, which is only populated on the
// --service path. Today x.root would still resolve correctly on a full start —
// start Chdir()s into the root after applying the --root > SEMIONT_ROOT > cwd
// precedence, so an empty root falls back to cwd and lands in the same place.
// This does not lean on that: the flow already holds the resolved root, and
// depending on a chdir performed a few hundred lines away in another function
// is the kind of coupling that breaks silently and keys a signing key off the
// wrong directory.
func (x *liveExec) jwtSecret(root string) (string, bool) {
	return loadOrCreateJWTSecret(x.u, root)
}

func (x *liveExec) ollamaVolume(opts startOptions) string {
	return chooseOllamaVolume(x.u, opts)
}

func (x *liveExec) record(role, id, image, provided, endpoint, driver string) {
	if x.st == nil { // --service mode: load, or create with full metadata
		x.st = loadLocalState()
		if x.st == nil {
			x.st = &stackState{
				Runtime: x.rt, KBRoot: x.root, KBDid: loadKBIdentity(x.root).didWeb(),
				Version: x.version, Services: map[string]serviceState{},
			}
		}
	}
	var models, ollamaServed []string
	if x.plan != nil {
		models = x.plan.Roles[role].Models
		ollamaServed = x.plan.Roles[role].OllamaServed
	}
	x.st.recordService(role, id, image, provided, endpoint, driver, models, ollamaServed)
}

// providerOf reads back how an earlier step in THIS run resolved a role.
// The host-Ollama-vs-container decision is made at runtime, not in the plan,
// so a role sharing that Ollama can only learn the answer here.
func (x *liveExec) providerOf(role string) string {
	if x.st == nil {
		return ""
	}
	return x.st.Services[role].Provided
}

// noteContainer marks a container-less role (embedding) as the OWNER of a
// container it launched itself — the shared Ollama under all-remote
// bindings. Only the launching flow may call this; it is what stop's
// ownership checks key on.
func (x *liveExec) noteContainer(role, container string) {
	if x.st == nil {
		return
	}
	e, ok := x.st.Services[role]
	if !ok {
		return
	}
	e.Container = container
	x.st.Services[role] = e
	saveStack(x.st)
}

// verifyRemoteModels records what /v1/models says about the configured
// models — and says out loud when one is NOT listed for this key (withdrawn,
// or a typo'd id): the remote analog of a MISSING ollama model, and today's
// only warning before a job fails on it.
func (x *liveExec) verifyRemoteModels(role, base, key string, models []string) {
	if key == "" || x.st == nil {
		return
	}
	listed, found := fetchAnthropicModels(base, key)
	if !found {
		x.u.log("Model metadata: %s", x.u.dim("("+base+"/v1/models did not answer — skipping; status will show plain 'remote')"))
		return
	}
	metas := map[string]remoteModelMeta{}
	for _, m := range models {
		if meta, ok := listed[m]; ok {
			metas[m] = meta
			continue
		}
		metas[m] = remoteModelMeta{Available: false}
		x.u.warn("Model %s is not listed for this API key — withdrawn, or a typo'd id? Jobs bound to it will fail.", m)
	}
	e, ok := x.st.Services[role]
	if !ok {
		return
	}
	e.RemoteModels = metas
	x.st.Services[role] = e
	saveStack(x.st)
}

// dumpLogs prints the tail of a just-launched container's own logs when its
// health gate fails. The crash cause is usually sitting right there — a
// friction log (2026-07-20) spent most of a day on an errno -35 event-log
// read failure that was in `logs` for the whole 120s wait, while the
// launcher said only "did not become ready".
func (x *liveExec) dumpLogs(container, svc string) {
	out, _ := captureBoth(x.rt, "logs", container)
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) == 1 && strings.TrimSpace(lines[0]) == "" {
		return
	}
	const tail = 20
	if len(lines) > tail {
		lines = lines[len(lines)-tail:]
	}
	fmt.Fprintf(os.Stderr, "  Last %d line(s) of %s's logs:\n", len(lines), container)
	for _, l := range lines {
		fmt.Fprintln(os.Stderr, "    "+l)
	}
	fmt.Fprintf(os.Stderr, "  Full logs:  semiont logs --service %s\n", svc)
}

// browserCurrent: is semiont-browser RUNNING on an image identical to the
// one this start would run? Identity, not tag order: the running container's
// image reference must match the desired ref, and when both sides expose an
// image ID those must match too (a moved :latest). Reference match without
// obtainable IDs KEEPS the browser (restart-on-doubt would negate the
// feature on runtimes that expose no ID through inspect) — the explicit
// refresh is `semiont start --service browser`.
func (x *liveExec) browserCurrent(desired string) bool {
	out, err := capture(x.rt, "inspect", "semiont-browser")
	if err != nil || out == "" {
		return false
	}
	var entries []map[string]any
	if json.Unmarshal([]byte(out), &entries) != nil || len(entries) == 0 {
		return false
	}
	e := entries[0]
	status, _ := digString(e, "status")
	if status == "" {
		status, _ = digString(e, "State", "Status")
	}
	if status != "running" {
		return false
	}
	ref, _ := digString(e, "configuration", "image", "reference")
	if ref == "" {
		ref, _ = digString(e, "Config", "Image")
	}
	if ref != desired {
		return false
	}
	runningID, _ := digString(e, "Image")
	if runningID == "" {
		return true // reference matches; no ID exposed — keep
	}
	idOut, err := capture(x.rt, "image", "inspect", "-f", "{{.Id}}", desired)
	if err != nil || idOut == "" {
		return true
	}
	return strings.TrimSpace(idOut) == runningID
}

func (x *liveExec) browserRecord() *serviceState {
	return loadStackSet().Browser
}

func (x *liveExec) recordBrowser(id, img, version string, port int) {
	saveBrowser(&serviceState{
		Container: "semiont-browser", ID: id, Image: img, Provided: providedLauncher,
		Runtime: x.rt, Endpoint: fmt.Sprintf("http://localhost:%d", port),
		StartedAt: time.Now().UTC(),
	})
}

func (x *liveExec) ensureModels(base string, models []modelNeed) {
	ensureOllamaModels(x.u, base, models)
}

// stateMounts prepares a role's persistent state dir and returns the run
// args that mount it (LAUNCHER-STATE.md). The image-mismatch split lives
// here: database data is user rows — refuse, fix-it names the clean
// command; projections (vectors/graph) auto-clean and rebuild.
func (x *liveExec) stateMounts(role, image, root string) ([]string, bool) {
	args := stateMountArgs(role, root)
	if len(args) == 0 {
		return nil, true
	}
	spec := stateStores[role]
	dir := stateRootDir(root)
	sd := spec.storeDir(root)
	meta := loadRootMeta(dir)
	if prev := meta.Stores[role].Image; prev != "" && prev != image && storeDirNonEmpty(sd) {
		if spec.projection {
			// A projection of the event log: staleness is rebuildable, so a
			// mismatch clears rather than refuses.
			x.u.log("%s state at %s was written by %s; this config launches %s — projections rebuild, so clearing it.",
				role, sd, prev, image)
			if err := os.RemoveAll(sd); err != nil {
				x.u.fail("cannot clear %s state %s: %v", role, sd, err)
				return nil, false
			}
		} else {
			x.u.fail("%s state at %s was written by %s; this config launches %s.", role, sd, prev, image)
			fmt.Fprintln(os.Stderr, "  That data is not auto-deleted. Remove it first: semiont clean --store "+role)
			return nil, false
		}
	}
	for _, m := range spec.mounts {
		mp := filepath.Join(sd, m.sub)
		if err := os.MkdirAll(mp, 0o755); err != nil {
			x.u.fail("cannot create state dir %s: %v", mp, err)
			return nil, false
		}
		if spec.mode != 0 {
			// MkdirAll perms pass through the umask; the virtiofs gate needs
			// the literal mode, so stamp it explicitly.
			if err := os.Chmod(mp, spec.mode); err != nil {
				x.u.fail("cannot chmod state dir %s: %v", mp, err)
				return nil, false
			}
		}
	}
	if spec.mode != 0 {
		// The mount dirs carry a permissive mode for the container's own
		// gate — clamp their UNMOUNTED parent to owner-only so other local
		// users can't traverse to them. The container never sees the
		// parent; only the mount dirs cross the boundary.
		if err := os.Chmod(sd, 0o700); err != nil {
			x.u.fail("cannot chmod state dir %s: %v", sd, err)
			return nil, false
		}
	}
	meta.KBRoot = root
	meta.Did = loadKBIdentity(root).didWeb()
	meta.Stores[role] = storeMeta{Image: image}
	saveRootMeta(dir, meta)
	return args, true
}

// stateMountsShared: a role's state mounts for a container that is NOT the
// stamp's owner. The SMELTER owns the anchored-text stamp (it mounts via
// stateMounts with the smelter image and clears on image change); the
// Archivist mounts the same store as a peer, read-only.
//
// Running the stamped path here with a second image would flip the stamp on
// every start and — anchored-text being a projection — CLEAR the store each
// alternation, at ~2.9s/page of OCR to rebuild. Exactly one service may take
// the stamped path per store.
//
// The stamp follows the WRITER, which is what makes an image-change clear
// correct: the stamp names the code whose output the store holds. It moved
// from the backend to the Smelter in ANCHORED-TEXT-TO-SMELTER P5, once P4
// had removed the gateway's anchored-text faces.
//
// Two earlier versions of this comment predicted the wrong trigger — first
// "the Archivist cutover", then EXTRACT-LIBRARIAN's. Neither happened; that
// plan retired the flip entirely (the Gatherer reads no anchored text).
func (x *liveExec) stateMountsShared(role, root string) ([]string, bool) {
	args := stateMountArgs(role, root)
	if len(args) == 0 {
		return nil, true
	}
	spec := stateStores[role]
	sd := spec.storeDir(root)
	for _, m := range spec.mounts {
		if err := os.MkdirAll(filepath.Join(sd, m.sub), 0o755); err != nil {
			x.u.fail("cannot create state dir %s: %v", filepath.Join(sd, m.sub), err)
			return nil, false
		}
	}
	return args, true
}

func (x *liveExec) val(live, _ string) string { return live }
func (x *liveExec) rtName() string            { return x.rt }
func (x *liveExec) dim(s string) string       { return x.u.dim(s) }
func (x *liveExec) bold(s string) string      { return x.u.bold(s) }

func (x *liveExec) banner(s string) { x.u.banner(s) }

func (x *liveExec) say(kind sayKind, format string, a ...any) {
	switch kind {
	case sayLog:
		x.u.log(format, a...)
	case sayOK:
		x.u.ok(format, a...)
	case sayWarn:
		x.u.warn(format, a...)
	case sayFail:
		x.u.fail(format, a...)
	}
}

func (x *liveExec) note(string, ...any) {}

// --- plan (--dry-run) ---

type planExec struct {
	rt string
}

func (x *planExec) p(args ...string)          { fmt.Println(renderCmd(x.rt, args...)) }
func (x *planExec) c(format string, a ...any) { fmt.Printf("# "+format+"\n", a...) }
func (x *planExec) stopRm(name string) bool   { x.p("stop", name); x.p("rm", name); return false }
func (x *planExec) settle(...int)             {} // plan mode tears nothing down
func (x *planExec) sweepStaging()             { x.c("remove staged config copies: /tmp/semiont-config.*") }

func (x *planExec) sweepStray(names []string) bool {
	for _, rt := range installedRuntimes() {
		if rt == x.rt {
			continue
		}
		x.c("sweep stray Semiont containers under %s:", rt)
		for _, c := range names {
			fmt.Println(renderCmd(rt, "stop", c))
			fmt.Println(renderCmd(rt, "rm", c))
		}
	}
	// Plan mode performs nothing, so it settles nothing.
	return false
}

func (x *planExec) portChecks(ports []portNeed) bool {
	if len(ports) == 0 {
		return true
	}
	strs := make([]string, 0, len(ports))
	for _, pc := range ports {
		strs = append(strs, fmt.Sprintf("%d", pc.port))
	}
	x.c("require free ports: %s", strings.Join(strs, " "))
	return true
}

func (x *planExec) stageAll(_, envName, _ string) (string, bool) {
	x.c("stage per-service config copies under <config-stage>: backend.toml worker.toml smelter.toml weaver.toml archivist.toml librarian.toml")
	for _, svc := range []string{"backend", "worker", "smelter", "librarian"} {
		x.c("append [environments.%s.archivist] host/port (launcher-staged topology) to %s.toml", envName, svc)
	}
	return "<config-stage>", true
}

func (x *planExec) stageOne(svc, _, envName, _ string) (string, bool) {
	x.c("stage a fresh private config copy under <config-stage>: %s.toml", svc)
	if archivistDialers[svc] {
		x.c("append [environments.%s.archivist] host/port (launcher-staged topology) to %s.toml", envName, svc)
	}
	return "<config-stage>", true
}

func (x *planExec) initStack(_, _, _, _, _ string) {}

func (x *planExec) pull(img string) bool {
	x.p(pullArgs(x.rt, img)...)
	return true
}

func (x *planExec) runDetached(args []string) (string, bool) {
	x.p(args...)
	return "", true
}

func (x *planExec) waitHTTP(_, url string, seconds int) (time.Duration, bool) {
	x.c("wait: %s (%ds)", url, seconds)
	return 0, true
}

func (x *planExec) waitPG(addr string, port, seconds int) (time.Duration, bool) {
	x.c("wait: tcp localhost:%d (%ds)", port, seconds)
	x.c("probe: %s run --rm busybox:1.38.0 nc -z -w 2 %s %d", x.rt, addr, port)
	return 0, true
}

func (x *planExec) probeTCP(string, rolePlan) bool { return true }

func (x *planExec) portCheck(p portNeed) bool {
	x.c("require free port: %d", p.port)
	return true
}

func (x *planExec) recordPorts([]portNeed) {}

func (x *planExec) hostOllamaReachable(string, int) bool { return true }

func (x *planExec) backendReachable(addr string, port int) bool {
	x.c(`probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://%s:%d/api/health" (up to 20 tries)`, x.rt, addr, port)
	return true
}

func (x *planExec) resolveAddr() (string, bool) {
	switch x.rt {
	case "container":
		x.c(`probe: container run --rm busybox:1.38.0 sh -c "ip route | awk '/default/{print $3}'" → <host-addr>`)
	case "docker":
		x.c("probe: docker run --rm busybox:1.38.0 nslookup host.docker.internal (fallback: default-gateway probe) → <host-addr>")
	case "podman":
		x.c("probe: podman run --rm busybox:1.38.0 nslookup host.containers.internal (fallback: default-gateway probe) → <host-addr>")
	}
	return "<host-addr>", true
}

func (x *planExec) either(_ func() bool, then, els func() int) int {
	then()
	x.c("else:")
	els()
	return 0
}

func (x *planExec) otelDetect(string) []string {
	x.c("probe: Jaeger at http://localhost:16686 — if running, add --env OTEL_EXPORTER_OTLP_ENDPOINT=http://<host-addr>:4318")
	return nil
}

func (x *planExec) recoverSecret() (string, bool) {
	x.c("worker secret: recovered from a running Semiont container's env (inspect), else $SEMIONT_WORKER_SECRET, else generated")
	return "<worker-secret>", true
}

func (x *planExec) workerSecret() (string, bool) { return "<worker-secret>", true }

// Dry-run reaches for nothing: no file is read and none is minted, so a plan
// never has the side effect of creating a root's signing key.
func (x *planExec) jwtSecret(root string) (string, bool) { return "<jwt-secret>", true }

func (x *planExec) ollamaVolume(opts startOptions) string {
	volume := "<ollama-volume>"
	switch opts.ollamaCache {
	case "host":
		if home, err := os.UserHomeDir(); err == nil {
			volume = filepath.Join(home, ".ollama")
		}
	case "volume":
		volume = "semiont-ollama-models"
	}
	return volume
}

func (x *planExec) record(_, _, _, _, _, _ string) {}

// --dry-run records nothing, so there is nothing to read back.
func (x *planExec) providerOf(string) string { return "" }

// --dry-run records nothing, so ownership notes have nowhere to land.
func (x *planExec) noteContainer(string, string) {}

// --dry-run launches nothing, so nothing can crash.
func (x *planExec) dumpLogs(string, string) {}

// --dry-run: the keep-or-restart decision is a runtime fact; either() shows
// both branches, so these answer neutrally.
func (x *planExec) browserCurrent(string) bool                { return false }
func (x *planExec) browserRecord() *serviceState              { return nil }
func (x *planExec) recordBrowser(string, string, string, int) {}

// --dry-run reaches for nothing; name the query a real run would make.
func (x *planExec) verifyRemoteModels(role, base, _ string, models []string) {
	if len(models) > 0 {
		x.c("query %s/v1/models (x-api-key from env) — metadata + availability for: %s", base, strings.Join(models, ", "))
	}
}

// --dry-run reaches for nothing: which models are ABSENT is a runtime fact,
// so the plan can only name what would be checked.
func (x *planExec) ensureModels(base string, models []modelNeed) {
	if len(models) > 0 {
		x.c("ensure %s models present at %s (pull each missing one): %s",
			strings.Join(modelRoles(models), ", "), base, strings.Join(modelNames(models), ", "))
	}
}

// --dry-run computes the real state path (it is derivation, not effect) but
// creates nothing and never refuses — the image-mismatch check reads disk,
// a runtime fact the plan only names.
func (x *planExec) stateMounts(role, _, root string) ([]string, bool) {
	args := stateMountArgs(role, root)
	if len(args) > 0 {
		x.c("%s state: %s (created if absent; reused across restarts)",
			role, stateStores[role].storeDir(root))
	}
	return args, true
}

func (x *planExec) stateMountsShared(role, root string) ([]string, bool) {
	x.c("mount %s state (shared; the stamp stays with its owning service)", role)
	return stateMountArgs(role, root), true
}

func (x *planExec) val(_, plan string) string { return plan }
func (x *planExec) rtName() string            { return x.rt }
func (x *planExec) dim(s string) string       { return s }
func (x *planExec) bold(s string) string      { return s }

func (x *planExec) banner(string) {}

func (x *planExec) say(sayKind, string, ...any) {}

func (x *planExec) note(format string, a ...any) { x.c(format, a...) }

// probeHostOllama: the live host-reuse condition (plan mode never calls it —
// either() renders both branches there).
func probeHostOllama(port int) func() bool {
	return func() bool {
		return httpOK(fmt.Sprintf("http://localhost:%d/api/version", port))
	}
}

// verifyExternal confirms an externally-provided role is reachable at its
// configured address — the launcher launches nothing but refuses to bring up
// dependents against a dead dependency.
func verifyExternal(u *ui, role string, rp rolePlan) bool {
	addr := net.JoinHostPort(rp.Address, fmt.Sprintf("%d", rp.Port))
	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		u.fail("%s is externally provided at %s but unreachable: %v", role, addr, err)
		return false
	}
	conn.Close()
	u.ok("%s — externally provided at %s %s", role, addr, u.dim("(reachable)"))
	return true
}
