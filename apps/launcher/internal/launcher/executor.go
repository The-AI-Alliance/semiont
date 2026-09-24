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
	"maps"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	toml "github.com/pelletier/go-toml/v2"
)

type executor interface {
	// --- effects ---
	snapshotLogs(root string, names []string) // crash evidence: capture container logs into the root's state area before a teardown deletes them
	stopRm(name string) bool                  // teardown; reports whether anything existed
	sweepStray(names []string) bool           // stop+rm the names under every OTHER installed runtime; reports whether anything existed
	settle(ports ...int)                      // wait for torn-down ports to be released
	sweepStaging()                            // /tmp/semiont-config.* removal (+ state forget)
	portChecks(ports []portNeed) bool
	portCheck(p portNeed) bool    // singular wording in plan mode
	recordPorts(ports []portNeed) // note claimed host ports in the belief record
	hostOllamaReachable(addr string, port int) bool
	stageAll(configFile, envName, addr string, traces bool) (string, bool) // per-service config copies + the collector's own; returns stage dir
	stageOne(svc, configFile, envName, addr string) (string, bool)         // one service's fresh private copy
	stageCollector(addr string) (string, bool)                             // the collector's own config: launcher-owned, no KB config involved
	stageMetrics(addr string) (string, bool)                               // Prometheus's scrape config: same launcher-owned pattern
	initStack(root, config, version, addr, stage string)                   // begin the belief record
	pull(img string) bool
	runDetached(args []string) (string, bool)                      // echo + run -d; returns runtime-reported id
	waitHTTP(label, url string, seconds int) (time.Duration, bool) // wall-clock budget, not attempts
	waitTCP(label, addr string, port, seconds int) (time.Duration, bool)
	waitPGAccepting(seconds int) bool       // the port gate does not prove PostgreSQL accepts sessions; initdb's temporary server is why
	probeTCP(role string, rp rolePlan) bool // external-role reachability
	gatewayReachable(addr string, port int) bool
	resolveAddr() (string, bool) // container→host address ("<host-addr>" in plan mode)
	either(cond func() bool, then, els func() int) int
	otelDetect(addr string) []string                     // --service: OTel iff the collector is up
	jwtSecret(root string) (string, bool)                // gateway token-signing key: env, else persisted per-root, else generated
	identityAdminPassword(root string) (string, bool)    // Keycloak's bootstrap admin password: same three sources
	serviceClientSecret(root, svc string) (string, bool) // one service's account credential, per root
	stageRealm(realm string, doc []byte) (string, bool)  // the realm file Keycloak imports; returns its staged path
	stageNatsConf(doc []byte) (string, bool)             // the broker's authorization block (no secret in it); returns its staged path
	createDatabase(user, name string) bool               // a database on the launcher-run PostgreSQL, if absent
	ollamaVolume(opts startOptions) string               // model-cache choice (prompt is live-only)
	record(role, id, image, provided, endpoint, driver string)
	providerOf(role string) string        // how an already-recorded role was provided
	noteContainer(role, container string) // stamp a launched container on a container-less role
	browserCurrent(desired string) bool   // running AND image identity matches
	browserRecord() *ServiceState         // the machine-level browser record
	recordBrowser(id, image, version string, port int)
	dumpLogs(container, svc string)                                                                                // failed health gate: show the crash where it is
	verifyRemoteModels(role, base, key string, models []string)                                                    // record /v1/models metadata; warn on unlisted
	preflightIdentity(issuerBase, audience string, secrets map[string]string, wantLifespan int, managed bool) bool // the realm honours every service credential AND the clients people sign in through, before anything holds one. `managed` = this launcher runs the realm, so `semiont identity sync` is the repair
	preflightBrowserMove(issuerBase string, port int) bool                                                         // the realm will redirect to, and accept a token exchange from, the port the Browser is moving to
	ensureModels(base string, models []modelNeed)                                                                  // pull configured ollama models that are absent
	stateMounts(role, image, root string) ([]string, bool)                                                         // persistent-state run args; !ok = refuse (data written by another image)
	stateMountsShared(role, root string) ([]string, bool)                                                          // the same mounts WITHOUT claiming the image stamp (a reader beside the stamp's owner)
	resolveStoreStamps(fc flowCtx) bool                                                                            // preflight: every store's mismatch refuse/clear, before the first container run (SHARED-STORE-CLEAR-PREFLIGHT)
	val(live, plan string) string                                                                                  // mode-scoped value (kb root, admin password)
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
	u  *UI
	rt string
	st *StackState
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

func (x *liveExec) snapshotLogs(root string, names []string) {
	if dir, n := writeLogSnapshot(x.rt, root, names); n > 0 {
		x.u.Log("Snapshotted %d container log(s) %s", n, x.u.Dim("("+dir+")"))
	}
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
			x.u.Warn("Removed %d stray Semiont container(s) under %s.", removed, rt)
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
	x.u.Warn("Ollama is running on the host but not reachable from containers.")
	fmt.Printf("   The gateway runs in a container and needs Ollama at %s:%d.\n", addr, port)
	fmt.Println()
	if runSilent("pgrep", "-f", "Ollama.app/Contents") == nil {
		fmt.Println("   Detected: Ollama Desktop app")
	} else if runSilent("pgrep", "-f", "ollama serve") == nil {
		fmt.Println("   Detected: ollama serve daemon")
	}
	fmt.Println()
	fmt.Println("   Fix: configure Ollama to listen on all interfaces:")
	fmt.Printf("     %s\n", x.u.Bold("launchctl setenv OLLAMA_HOST 0.0.0.0"))
	fmt.Println("   Then fully quit Ollama Desktop from the menu bar and relaunch it.")
	fmt.Println()
	fmt.Println("   (If launchctl doesn't stick, quit Ollama Desktop entirely and run")
	fmt.Printf("    %s from a terminal.)\n", x.u.Bold("OLLAMA_HOST=0.0.0.0:11434 ollama serve"))
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
			x.st = &StackState{
				Runtime: x.rt, KBRoot: x.root, KBDid: loadKBIdentity(x.root).didWeb(),
				Version: x.version, Services: map[string]ServiceState{},
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
		x.u.Fail("Cannot create config staging dir: %v", err)
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
var archivistDialers = map[string]bool{"gateway": true, "smelter": true, "librarian": true, "worker": true}

// kbIdentityStaged: the services that describe a KB tree they do not mount,
// and so must be handed its committed identity rather than reading it
// (SINGLE-KB-MOUNT P5/P6). The Archivist is absent because it HOLDS the
// tree; the Smelter and Worker are absent because they never name the KB.
var kbIdentityStaged = map[string]bool{"gateway": true, "librarian": true}

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
//	name   — how the Librarian and the gateway locate the views the Archivist
//	         materializes under the shared state mount.
//	domain — the KB's permanent did:web identity. The gateway REFUSES to boot
//	         without it (KB-IDENTITY decision 8), and once it stops mounting
//	         /kb this staged copy is the only way it can see the committed
//	         value. Omitted when the KB declares none, so the refusal still
//	         fires: staging a fabricated identity is the one thing worse than
//	         failing loudly.
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

func (x *liveExec) stageAll(configFile, envName, addr string, traces bool) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	cfg, err := os.ReadFile(configFile)
	if err != nil {
		x.u.Fail("Reading %s: %v", configFile, err)
		return "", false
	}
	for _, svc := range []string{"gateway", "worker", "smelter", "weaver", "archivist", "librarian", "dispatcher"} {
		out := x.stagedConfig(svc, cfg, envName, addr)
		if err := os.WriteFile(filepath.Join(stage, svc+".toml"), out, 0o644); err != nil {
			x.u.Fail("Staging config for %s: %v", svc, err)
			return "", false
		}
	}
	// The collector's config is launcher-owned, not a KB copy; the variant
	// follows --observe (traces → Jaeger or nop).
	if err := os.WriteFile(filepath.Join(stage, "collector.yaml"), []byte(collectorConfig(addr, traces)), 0o644); err != nil {
		x.u.Fail("Staging the collector config: %v", err)
		return "", false
	}
	if err := os.WriteFile(filepath.Join(stage, "prometheus.yml"), []byte(prometheusConfig(addr)), 0o644); err != nil {
		x.u.Fail("Staging the Prometheus config: %v", err)
		return "", false
	}
	return stage, true
}

func (x *liveExec) stageMetrics(addr string) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	if err := os.WriteFile(filepath.Join(stage, "prometheus.yml"), []byte(prometheusConfig(addr)), 0o644); err != nil {
		x.u.Fail("Staging the Prometheus config: %v", err)
		return "", false
	}
	return stage, true
}

// stageCollector: --service collector cannot use stageOne (no KB config to
// copy); it stages only the launcher-written YAML. Traces route to Jaeger
// iff Jaeger is actually up — the otelDetect rule.
func (x *liveExec) stageCollector(addr string) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	if err := os.WriteFile(filepath.Join(stage, "collector.yaml"), []byte(collectorConfig(addr, httpOK("http://localhost:16686"))), 0o644); err != nil {
		x.u.Fail("Staging the collector config: %v", err)
		return "", false
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
		x.u.Fail("Reading %s: %v", configFile, err)
		return "", false
	}
	if err := os.WriteFile(filepath.Join(stage, svc+".toml"), x.stagedConfig(svc, cfg, envName, addr), 0o644); err != nil {
		x.u.Fail("Staging config for %s: %v", svc, err)
		return "", false
	}
	return stage, true
}

func (x *liveExec) initStack(root, config, version, addr, stage string) {
	x.st = &StackState{
		Runtime: x.rt, KBRoot: root, KBDid: loadKBIdentity(root).didWeb(),
		Config: config, Version: version,
		HostAddr: addr, Stage: stage, Services: map[string]ServiceState{},
	}
}

func (x *liveExec) pull(img string) bool {
	args := pullArgs(x.rt, img)
	x.u.EchoCmd(x.rt, args...)
	if err := runVisible(x.rt, args...); err != nil {
		x.u.Fail("Pull failed: %s", img)
		return false
	}
	return true
}

func (x *liveExec) runDetached(args []string) (string, bool) {
	args = withLogOpts(x.rt, args)
	x.u.EchoCmd(x.rt, args...)
	id, err := runDetached(x.rt, args...)
	if err != nil {
		return "", false
	}
	return id, true
}

func (x *liveExec) waitHTTP(label, url string, seconds int) (time.Duration, bool) {
	return waitForHTTP(x.u, label, url, seconds)
}

func (x *liveExec) waitTCP(label, addr string, port, seconds int) (time.Duration, bool) {
	return waitForTCP(x.u, x.rt, label, addr, port, seconds)
}

func (x *liveExec) waitPGAccepting(seconds int) bool {
	return waitPGAccepting(x.u, x.rt, roles["database"].container, seconds)
}

func (x *liveExec) probeTCP(role string, rp rolePlan) bool {
	return verifyExternal(x.u, role, rp)
}

func (x *liveExec) gatewayReachable(addr string, port int) bool {
	x.u.Log("Verifying gateway reachable from containers...")
	t0 := time.Now()
	for i := 0; i < 20; i++ {
		if runSilent(x.rt, "run", "--rm", "busybox:1.38.0", "sh", "-c",
			fmt.Sprintf("wget -q -O- http://%s:%d/api/health", addr, port)) == nil {
			x.u.Ok("Gateway reachable from containers %s", x.u.Dim("("+took(time.Since(t0))+")"))
			return true
		}
		time.Sleep(time.Second)
	}
	x.u.Fail("Gateway not reachable from containers at %s:%d within 20s.", addr, port)
	return false
}

func (x *liveExec) resolveAddr() (string, bool) {
	addr := resolveHostAddr(x.rt)
	if addr == "" {
		x.u.Fail("Could not determine host address for container networking.")
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
	// Probe the COLLECTOR — it owns the port services export to. Its :24110
	// readout is a plain 200 when up; the OTLP receiver rejects GETs.
	if httpOK("http://localhost:24110/metrics") {
		x.u.Log("OTel collector detected — export enabled")
		return otelArgs(addr)
	}
	return nil
}

// jwtSecret is per-root and persisted, so a --service gateway restart resolves
// the SAME value a full start did. Every credential the launcher hands out now
// works this way; the inspect-based recovery that once read a never-persisted
// shared secret out of a running container is gone with the secret itself.
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

func (x *liveExec) identityAdminPassword(root string) (string, bool) {
	return loadOrCreateKeycloakAdminPassword(x.u, root)
}

func (x *liveExec) serviceClientSecret(root, svc string) (string, bool) {
	return loadOrCreateServiceClientSecret(x.u, root, svc)
}

func (x *liveExec) stageNatsConf(doc []byte) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	p := filepath.Join(stage, "nats-semiont.conf")
	if err := os.WriteFile(p, doc, 0o644); err != nil {
		x.u.Fail("Cannot stage the broker config at %s: %v", p, err)
		return "", false
	}
	return p, true
}

func (x *liveExec) stageRealm(realm string, doc []byte) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	p := filepath.Join(stage, "keycloak-"+realm+"-realm.json")
	if err := os.WriteFile(p, doc, 0o644); err != nil {
		x.u.Fail("Staging the Keycloak realm: %v", err)
		return "", false
	}
	return p, true
}

// createDatabase creates a database on the launcher-run PostgreSQL if it is
// absent — idempotent by construction (psql's \gexec runs the CREATE only when
// the WHERE finds nothing), so a second start is a no-op.
//
// Still retried, though waitPGAccepting now gates it: a session can be cut off
// mid-statement by the end of initdb ("terminating connection due to
// administrator command"), and a retry costs a second. The attempt's output is
// CAPTURED — printing the stderr of a failure the loop expects to absorb is
// how a recovered start came to look like a broken one.
func (x *liveExec) createDatabase(user, name string) bool {
	sql := fmt.Sprintf("SELECT 'CREATE DATABASE %s' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '%s')\\gexec\n", name, name)
	args := []string{"exec", "-i", roles["database"].container, "psql", "-U", user, "-v", "ON_ERROR_STOP=1", "-q"}
	x.u.EchoCmd(x.rt, args...)
	var err error
	var out string
	for i := 0; i < 5; i++ {
		if out, err = runWithStdinCaptured(x.rt, sql, args...); err == nil {
			x.u.Ok("PostgreSQL has database %q", name)
			return true
		}
		if i == 0 {
			x.u.Log("PostgreSQL is still settling — retrying %s", x.u.Dim("(a first start finishes initdb after the port opens)"))
		}
		time.Sleep(time.Second)
	}
	x.u.Fail("Creating database %q on PostgreSQL: %v", name, err)
	if s := strings.TrimSpace(out); s != "" {
		fmt.Fprintln(os.Stderr, indentLines(s, "    "))
	}
	return false
}

func (x *liveExec) ollamaVolume(opts startOptions) string {
	return chooseOllamaVolume(x.u, opts)
}

func (x *liveExec) record(role, id, image, provided, endpoint, driver string) {
	if x.st == nil { // --service mode: load, or create with full metadata
		x.st = loadLocalState()
		if x.st == nil {
			x.st = &StackState{
				Runtime: x.rt, KBRoot: x.root, KBDid: loadKBIdentity(x.root).didWeb(),
				Version: x.version, Services: map[string]ServiceState{},
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
		x.u.Log("Model metadata: %s", x.u.Dim("("+base+"/v1/models did not answer — skipping; status will show plain 'remote')"))
		return
	}
	metas := map[string]remoteModelMeta{}
	for _, m := range models {
		if meta, ok := listed[m]; ok {
			metas[m] = meta
			continue
		}
		metas[m] = remoteModelMeta{Available: false}
		x.u.Warn("Model %s is not listed for this API key — withdrawn, or a typo'd id? Jobs bound to it will fail.", m)
	}
	e, ok := x.st.Services[role]
	if !ok {
		return
	}
	e.RemoteModels = metas
	x.st.Services[role] = e
	saveStack(x.st)
}

// preflightBrowserMove checks both legs of a sign-in against the port the
// Browser is moving to: the realm must redirect there, and it must accept the
// token exchange that follows.
//
// The REDIRECT leg refuses, unlike the same condition inside preflightIdentity:
// there the stack is on the default port and works, so a pinned realm is
// something to know about later. Here the operator has ASKED for the port the
// realm will not redirect to, and proceeding produces a healthy Browser nobody
// can sign in to — the failure this whole preflight exists to prevent.
//
// The ORIGIN leg only warns, and the difference is not squeamishness: the
// repair needs this move to have happened first. `semiont identity sync` writes
// the origin for the port the Browser is RECORDED on, so refusing here would
// leave the operator unable to run the very command the message names. Move,
// sync, reload — which is the order the message asks for.
func (x *liveExec) preflightBrowserMove(issuerBase string, port int) bool {
	if f, bad := verifyBrowserRedirect(issuerBase, port); bad {
		x.u.Fail("The realm will not redirect to the port this Browser is being moved to.")
		fmt.Fprintln(os.Stderr, "  "+f.String())
		return false
	}
	if _, bad := verifyBrowserOrigin(issuerBase, port); bad {
		x.say(sayWarn, "The realm does not yet allow a token exchange from http://localhost:%d — run `semiont identity sync` once this move completes, then reload the Browser.", port)
	}
	return true
}

// preflightIdentity refuses the start when the realm will not honour the
// credentials this run is about to inject, or when nobody would be able to
// sign in through it.
//
// Refuses rather than warning: proceeding past a known-bad credential produces
// six services failing to authenticate and a log that explains none of it,
// while the operator could have been told up front which client and why. The
// one exception is a finding marked warnOnly — a realm that works but predates
// a change to the document, where refusing would strand a healthy deployment.
func (x *liveExec) preflightIdentity(issuerBase, audience string, secrets map[string]string, wantLifespan int, managed bool) bool {
	findings, observedLifespan := verifyServiceAccounts(issuerBase, audience, secrets)
	if len(findings) > 0 {
		x.u.Fail("The issuer does not honour the service-account credentials this start would inject.")
		for _, f := range findings {
			fmt.Fprintln(os.Stderr, "  "+f.String())
		}
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  A realm is imported on its FIRST boot and never again, so a realm created")
		fmt.Fprintln(os.Stderr, "  before these clients existed does not have them.")
		fmt.Fprintln(os.Stderr, "")
		// The repair, named rather than described (IDENTITY-PREFLIGHT P3) —
		// but named as the COMMANDS TO RUN, in order, with the follow-up.
		// `semiont identity sync` already ends by telling the operator to
		// start again; the half that DETECTS the problem used to stop at
		// naming a verb and leave the sequence to be inferred.
		if managed {
			fmt.Fprintf(os.Stderr, "  Fix it:  %s\n", x.u.Bold("semiont identity sync"))
			fmt.Fprintf(os.Stderr, "           %s\n", x.u.Dim("Adds the missing clients and reconciles an existing one's roles mapper. Touches no accounts."))
			fmt.Fprintln(os.Stderr, "")
			fmt.Fprintf(os.Stderr, "  Then:    %s\n", x.u.Bold("semiont start"))
			fmt.Fprintf(os.Stderr, "           %s\n", x.u.Dim("This start again, which will then get past this gate."))
			fmt.Fprintln(os.Stderr, "")
			// The case sync cannot repair, said plainly rather than left for
			// the operator to discover by looping. On a client that already
			// exists reconcileServiceClients touches only the roles mapper —
			// it never reconciles the secret — so "already correct" on a
			// client named above is not success, it is the other cause.
			fmt.Fprintln(os.Stderr, "  If sync reports a client above as already correct rather than created, that")
			fmt.Fprintln(os.Stderr, "  client exists with a DIFFERENT secret, which sync does not change. Delete it")
			fmt.Fprintln(os.Stderr, "  in the Keycloak admin console and run sync again.")
			return false
		}
		// Deliberately does NOT mention `semiont identity sync`, even to rule
		// it out: it needs an admin password this root never persisted for an
		// issuer it did not start, and a named command gets skimmed into an
		// instruction to run it.
		fmt.Fprintln(os.Stderr, "  This issuer is one you run, so its clients are yours to create.")
		fmt.Fprintln(os.Stderr, "  For each client named above: create it, enable the client-credentials grant,")
		fmt.Fprintf(os.Stderr, "  and supply its secret as %s — for example %s\n",
			x.u.Bold("SEMIONT_OIDC_CLIENT_SECRET_<SERVICE>"),
			serviceClientSecretEnv(findings[0].svc)+" for "+serviceClientID(findings[0].svc)+".")
		return false
	}
	x.u.Log("Service accounts: %s", x.u.Dim(fmt.Sprintf("%d verified at the realm", len(serviceClients))))

	// The realm imports on FIRST BOOT and never again, so a knowledge base can
	// configure a revocation window its realm has never heard of and nothing
	// would say so. The tokens just minted carry what the realm actually
	// stamps, which is the only reading available without administrator
	// credentials — see tokenLifespan.
	if wantLifespan > 0 && observedLifespan > 0 && observedLifespan != wantLifespan {
		x.u.Warn("This realm mints access tokens that live %ds, but the config asks for %ds.", observedLifespan, wantLifespan)
		fmt.Fprintln(os.Stderr, "    A realm is imported once, on its first boot — a lifespan changed afterwards does")
		fmt.Fprintln(os.Stderr, "    not reach it. The revocation window in force is the realm's, not the config's.")
		fmt.Fprintln(os.Stderr, "    Change it in the Keycloak console, or `semiont clean --store database` and start again.")
	}

	// The six machine identities being sound says nothing about whether a
	// PERSON can get in. Checked second so a broken realm reports its cause
	// once, at the layer that explains it.
	public := verifyPublicClients(issuerBase)
	var blocking []publicClientFinding
	for _, f := range public {
		if f.warnOnly {
			x.u.Warn("%s", f.String())
			continue
		}
		blocking = append(blocking, f)
	}
	if len(blocking) > 0 {
		x.u.Fail("The issuer would not let anyone sign in to this knowledge base.")
		for _, f := range blocking {
			fmt.Fprintln(os.Stderr, "  "+f.String())
		}
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  These are the clients PEOPLE authenticate through — the Browser's and the")
		fmt.Fprintln(os.Stderr, "  launcher's. The services above would start and talk to each other happily;")
		fmt.Fprintln(os.Stderr, "  nobody could open the knowledge base.")
		return false
	}
	x.u.Log("Sign-in clients: %s", x.u.Dim(browserClientID+" and "+CliClientID+" verified at the realm"))
	return true
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

func (x *liveExec) browserRecord() *ServiceState {
	return LoadStackSet().Browser
}

func (x *liveExec) recordBrowser(id, img, version string, port int) {
	saveBrowser(&ServiceState{
		Container: "semiont-browser", ID: id, Image: img, Provided: providedLauncher,
		Runtime: x.rt, Endpoint: fmt.Sprintf("http://localhost:%d", port),
		StartedAt: time.Now().UTC(),
	})
}

func (x *liveExec) ensureModels(base string, models []modelNeed) {
	ensureOllamaModels(x.u, base, models)
}

// resolveStoreStamp is THE decider for existing store data vs the launching
// image: refuse for the system of record (database — user rows), clear
// CONTENTS for projections (rebuildable from the log). Never unlinks the
// store dir: an attached share survives a contents-clear and is orphaned
// forever by delete-and-recreate (measured 2026-09-07).
func (x *liveExec) resolveStoreStamp(role, image, root string) bool {
	spec := stateStores[role]
	dir := stateRootDir(root)
	sd := spec.storeDir(root)
	meta := loadRootMeta(dir)
	prev := meta.Stores[role].Image
	if prev == "" || prev == image {
		return true
	}
	if storeDirNonEmpty(sd) {
		if !spec.projection {
			x.u.Fail("%s state at %s was written by %s; this config launches %s.", role, sd, prev, image)
			fmt.Fprintln(os.Stderr, "  That data is not auto-deleted. Remove it first: semiont clean --store "+role)
			return false
		}
		x.u.Log("%s state at %s was written by %s; this config launches %s — projections rebuild, so clearing it.",
			role, sd, prev, image)
		if err := clearStoreContents(sd); err != nil {
			x.u.Fail("cannot clear %s state %s: %v", role, sd, err)
			return false
		}
	}
	// Restamp NOW, not at the owner's prep: the old image's output is gone,
	// and a resolution that leaves the old stamp re-fires at the owner's own
	// stateMounts — clearing whatever an earlier-booting sharer wrote into
	// the store in between (the P5 live gate caught exactly this: the
	// gateway's fresh jobs tree, cleared at archivist prep).
	meta.Stores[role] = storeMeta{Image: image}
	saveRootMeta(dir, meta)
	return true
}

// resolveStoreStamps runs every store's stamp resolution in PREFLIGHT. The
// state store is shared — the gateway and librarian attach what the
// archivist stamps — so a clear at the owner's own prep lands mid-boot,
// after sharers attached (SHARED-STORE-CLEAR-PREFLIGHT).
func (x *liveExec) resolveStoreStamps(fc flowCtx) bool {
	for _, role := range slices.Sorted(maps.Keys(stateStores)) {
		spec := stateStores[role]
		var img string
		if rp, ok := fc.plan.Roles[spec.owner]; ok {
			if rp.Obligation != obligationProvided {
				continue // remote or absent: this boot mounts no such store
			}
			img = rp.Image
		} else {
			img = image(spec.owner, fc.version)
		}
		if !x.resolveStoreStamp(role, img, fc.root) {
			return false
		}
	}
	return true
}

// stateMounts prepares a role's persistent state dir and returns the run
// args that mount it (LAUNCHER-STATE.md). The image-mismatch split lives
// in resolveStoreStamp: database data is user rows — refuse, fix-it names
// the clean command; projections (vectors/graph) auto-clean and rebuild.
func (x *liveExec) stateMounts(role, image, root string) ([]string, bool) {
	args := stateMountArgs(role, root)
	if len(args) == 0 {
		return nil, true
	}
	spec := stateStores[role]
	dir := stateRootDir(root)
	sd := spec.storeDir(root)
	meta := loadRootMeta(dir)
	// A full start has already resolved the stamp in preflight (this re-check
	// no-ops on the emptied dir); single-service starts resolve here.
	if !x.resolveStoreStamp(role, image, root) {
		return nil, false
	}
	for _, m := range spec.mounts {
		mp := filepath.Join(sd, m.sub)
		if err := os.MkdirAll(mp, 0o755); err != nil {
			x.u.Fail("cannot create state dir %s: %v", mp, err)
			return nil, false
		}
		if spec.mode != 0 {
			// MkdirAll perms pass through the umask; the virtiofs gate needs
			// the literal mode, so stamp it explicitly.
			if err := os.Chmod(mp, spec.mode); err != nil {
				x.u.Fail("cannot chmod state dir %s: %v", mp, err)
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
			x.u.Fail("cannot chmod state dir %s: %v", sd, err)
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
// from the gateway to the Smelter in ANCHORED-TEXT-TO-SMELTER P5, once P4
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
			x.u.Fail("cannot create state dir %s: %v", filepath.Join(sd, m.sub), err)
			return nil, false
		}
	}
	return args, true
}

func (x *liveExec) val(live, _ string) string { return live }
func (x *liveExec) rtName() string            { return x.rt }
func (x *liveExec) dim(s string) string       { return x.u.Dim(s) }
func (x *liveExec) bold(s string) string      { return x.u.Bold(s) }

func (x *liveExec) banner(s string) { x.u.Banner(s) }

func (x *liveExec) say(kind sayKind, format string, a ...any) {
	switch kind {
	case sayLog:
		x.u.Log(format, a...)
	case sayOK:
		x.u.Ok(format, a...)
	case sayWarn:
		x.u.Warn(format, a...)
	case sayFail:
		x.u.Fail(format, a...)
	}
}

func (x *liveExec) note(string, ...any) {}

// --- plan (--dry-run) ---

type planExec struct {
	rt string
}

func (x *planExec) p(args ...string)          { fmt.Println(renderCmd(x.rt, args...)) }
func (x *planExec) c(format string, a ...any) { fmt.Printf("# "+format+"\n", a...) }
func (x *planExec) snapshotLogs(string, []string) {
	x.c("snapshot container logs into <state-root>/logs/<timestamp>/ before removal")
}
func (x *planExec) stopRm(name string) bool { x.p("stop", name); x.p("rm", name); return false }
func (x *planExec) settle(...int)           {} // plan mode tears nothing down
func (x *planExec) sweepStaging()           { x.c("remove staged config copies: /tmp/semiont-config.*") }

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

func (x *planExec) stageMetrics(string) (string, bool) {
	x.c("write <config-stage>/prometheus.yml (launcher-owned; scrapes the collector readout)")
	return "<config-stage>", true
}

func (x *planExec) stageCollector(string) (string, bool) {
	x.c("write <config-stage>/collector.yaml (launcher-owned; traces exporter iff Jaeger is up)")
	return "<config-stage>", true
}

func (x *planExec) stageAll(_, envName, _ string, _ bool) (string, bool) {
	x.c("stage per-service config copies under <config-stage>: gateway.toml worker.toml smelter.toml weaver.toml archivist.toml librarian.toml")
	x.c("write <config-stage>/collector.yaml (launcher-owned; traces exporter iff observing)")
	x.c("write <config-stage>/prometheus.yml (launcher-owned; scrapes the collector readout)")
	for _, svc := range []string{"gateway", "worker", "smelter", "librarian"} {
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
	x.p(withLogOpts(x.rt, args)...)
	return "", true
}

func (x *planExec) waitHTTP(_, url string, seconds int) (time.Duration, bool) {
	x.c("wait: %s (%ds)", url, seconds)
	return 0, true
}

func (x *planExec) waitPGAccepting(seconds int) bool {
	x.c("wait: %s exec %s pg_isready -h 127.0.0.1 (%ds) — the REAL server; initdb's temporary one answers the socket only",
		x.rt, roles["database"].container, seconds)
	return true
}

func (x *planExec) waitTCP(_, addr string, port, seconds int) (time.Duration, bool) {
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

func (x *planExec) gatewayReachable(addr string, port int) bool {
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

// Dry-run reaches for nothing: no file is read and none is minted, so a plan
// never has the side effect of creating a root's signing key.
func (x *planExec) jwtSecret(root string) (string, bool) { return "<jwt-secret>", true }

func (x *planExec) identityAdminPassword(string) (string, bool) {
	return "<keycloak-admin-password>", true
}

func (x *planExec) serviceClientSecret(_, svc string) (string, bool) {
	return "<" + svc + "-client-secret>", true
}

// The clients are read OUT OF the document rather than described alongside it.
// The sentence that stood here listed the realm, the Browser's public client
// and the audience mapper — written when that was all there was, and still
// saying so after six service accounts joined. A restatement of someone else's
// shape drifts the moment that shape grows; this cannot, because adding a
// client to keycloakRealmJSON adds it here too.
func (x *planExec) stageNatsConf(_ []byte) (string, bool) {
	x.c("stage the broker's authorization block (no credential in it — the daemon interpolates $NATS_USER/$NATS_PASSWORD from its own environment)")
	return "<stage>/nats-semiont.conf", true
}

func (x *planExec) stageRealm(realm string, doc []byte) (string, bool) {
	var parsed struct {
		Clients []struct {
			ClientID string `json:"clientId"`
		} `json:"clients"`
	}
	if err := json.Unmarshal(doc, &parsed); err != nil || len(parsed.Clients) == 0 {
		// No fallback sentence: a realm document this cannot read is a real
		// problem, and a plausible-looking line would hide it.
		x.c("write <config-stage>/keycloak-%s-realm.json (launcher-owned; UNREADABLE — its clients could not be listed)", realm)
		return "<config-stage>/keycloak-" + realm + "-realm.json", true
	}
	ids := make([]string, 0, len(parsed.Clients))
	for _, c := range parsed.Clients {
		ids = append(ids, c.ClientID)
	}
	x.c("write <config-stage>/keycloak-%s-realm.json (launcher-owned; realm %q, clients: %s)",
		realm, realm, strings.Join(ids, ", "))
	return "<config-stage>/keycloak-" + realm + "-realm.json", true
}

func (x *planExec) createDatabase(user, name string) bool {
	x.c("create database %s on PostgreSQL if absent: %s exec -i semiont-postgres psql -U %s (SQL on stdin)", name, x.rt, user)
	return true
}

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
func (x *planExec) browserRecord() *ServiceState              { return nil }
func (x *planExec) recordBrowser(string, string, string, int) {}

// --dry-run reaches for nothing: whether the realm honours a credential is a
// runtime fact. Name the grant each client would be asked for, and what the
// answer must carry.
func (x *planExec) preflightIdentity(issuerBase, audience string, _ map[string]string, wantLifespan int, _ bool) bool {
	for _, svc := range serviceClients {
		x.c("client-credentials grant at %s as %s — require flat `roles` containing %q and `aud` containing %s",
			issuerBase, serviceClientID(svc), serviceRole, audience)
	}
	x.c("device authorization at %s as %s — require the grant to be enabled for it", issuerBase, CliClientID)
	x.c("authorization request at %s as %s — require a redirect to %s", issuerBase, browserClientID, probeRedirect)
	x.c("the same request carrying NO code challenge — require it to be refused, so PKCE is enforced rather than merely offered")
	x.c("password grant at %s as %s and %s, sending no credential — require both to refuse it", issuerBase, browserClientID, CliClientID)
	if wantLifespan > 0 {
		x.c("compare `exp - iat` on those tokens against the configured %ds — warn if the realm was imported with another", wantLifespan)
	}
	return true
}

func (x *planExec) preflightBrowserMove(issuerBase string, port int) bool {
	x.c("authorization request at %s as %s — require a redirect to http://localhost:%d/en/auth/callback, the port this move puts the Browser on",
		issuerBase, browserClientID, port)
	return true
}

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

func (x *planExec) resolveStoreStamps(flowCtx) bool {
	x.c("resolve persistent-store stamps before any container runs: a database mismatch refuses; a projection mismatch clears the store's contents (the dir itself is kept, so attached shares survive)")
	return true
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
func verifyExternal(u *UI, role string, rp rolePlan) bool {
	addr := net.JoinHostPort(rp.Address, fmt.Sprintf("%d", rp.Port))
	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		u.Fail("%s is externally provided at %s but unreachable: %v", role, addr, err)
		return false
	}
	conn.Close()
	u.Ok("%s — externally provided at %s %s", role, addr, u.Dim("(reachable)"))
	return true
}
