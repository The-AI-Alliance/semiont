package launcher

// executor.go — the two walking modes for launch flows (see
// .plans/LAUNCHER-ROLE-EXECUTOR.md). Flows (flows.go) touch the world only
// through this interface; liveExec runs the stack, planExec renders
// --dry-run. EFFECT methods are the drift-proof boundary: argv, ports, URLs,
// tries, and record contents exist once, in the flow. DECORATION methods are
// deliberately one-sided (say = live narration, note = plan comments): a
// plan is a plan, not a transcript.

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type executor interface {
	// --- effects ---
	stopRm(name string) bool   // teardown; reports whether anything existed
	sweepStray(names []string) // stop+rm the names under every OTHER installed runtime
	pause()                    // the settle sleep after teardown
	sweepStaging()             // /tmp/semiont-config.* removal (+ state forget)
	portChecks(ports []portNeed) bool
	portCheck(p portNeed) bool    // singular wording in plan mode
	recordPorts(ports []portNeed) // note claimed host ports in the belief record
	stopEcho(name string)         // the echoed best-effort stop (ollama teardown)
	hostOllamaReachable(addr string, port int) bool
	stageAll(configFile string) (string, bool)           // per-service config copies; returns stage dir
	stageOne(svc, configFile string) (string, bool)      // one service's fresh private copy
	initStack(root, config, version, addr, stage string) // begin the belief record
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
	ollamaVolume(opts startOptions) string // model-cache choice (prompt is live-only)
	record(role, id, image, provided, endpoint, driver string)
	providerOf(role string) string             // how an already-recorded role was provided
	noteContainer(role, container string)      // stamp a launched container on a container-less role
	ensureModels(base string, models []string) // pull configured ollama models that are absent
	val(live, plan string) string              // mode-scoped value (kb root, admin password)
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
	u       *ui
	rt      string
	st      *stackState
	version string // SEMIONT_VERSION, for records created lazily (--service mode)
	root    string // KB root, ditto ("" for root-free services)
	// plan lets record() stamp each role's configured models without every
	// flow having to pass them; models are config truth, so they belong to
	// the record the same way the driver does.
	plan *launchPlan
}

func (x *liveExec) stopRm(name string) bool {
	stopped := runSilent(x.rt, "stop", name) == nil
	rmed := runSilent(x.rt, "rm", name) == nil
	return stopped || rmed
}

// sweepStray: the cross-runtime belt-and-braces — after this, no semiont-*
// container exists under ANY installed runtime, so a port holder at check
// time is provably foreign. Idempotent no-ops when clean.
func (x *liveExec) sweepStray(names []string) {
	for _, rt := range installedRuntimes() {
		if rt == x.rt {
			continue
		}
		removed := 0
		for _, c := range names {
			stopped := runSilent(rt, "stop", c) == nil
			rmed := runSilent(rt, "rm", c) == nil
			if stopped || rmed {
				removed++
			}
		}
		if removed > 0 {
			x.u.warn("Removed %d stray Semiont container(s) under %s.", removed, rt)
		}
	}
}

func (x *liveExec) pause() { time.Sleep(time.Second) }

func (x *liveExec) portCheck(p portNeed) bool {
	return requirePortFree(x.u, p.port, p.label)
}

func (x *liveExec) stopEcho(name string) {
	x.u.echoCmd(x.rt, "stop", name)
	runPassthrough(x.rt, "stop", name)
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

func (x *liveExec) stageAll(configFile string) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	cfg, err := os.ReadFile(configFile)
	if err != nil {
		x.u.fail("Reading %s: %v", configFile, err)
		return "", false
	}
	for _, svc := range []string{"backend", "worker", "smelter", "weaver"} {
		if err := os.WriteFile(filepath.Join(stage, svc+".toml"), cfg, 0o644); err != nil {
			x.u.fail("Staging config for %s: %v", svc, err)
			return "", false
		}
	}
	return stage, true
}

func (x *liveExec) stageOne(svc, configFile string) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	cfg, err := os.ReadFile(configFile)
	if err != nil {
		x.u.fail("Reading %s: %v", configFile, err)
		return "", false
	}
	if err := os.WriteFile(filepath.Join(stage, svc+".toml"), cfg, 0o644); err != nil {
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
		fmt.Fprintln(os.Stderr, "  Neither the runtime's host alias nor the default-gateway probe returned a result.")
		return "", false
	}
	return addr, true
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

func (x *liveExec) ensureModels(base string, models []string) {
	ensureOllamaModels(x.u, base, models)
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
func (x *planExec) pause()                    {}
func (x *planExec) sweepStaging()             { x.c("remove staged config copies: /tmp/semiont-config.*") }

func (x *planExec) sweepStray(names []string) {
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

func (x *planExec) stageAll(string) (string, bool) {
	x.c("stage per-service config copies under <config-stage>: backend.toml worker.toml smelter.toml weaver.toml")
	return "<config-stage>", true
}

func (x *planExec) stageOne(svc, _ string) (string, bool) {
	x.c("stage a fresh private config copy under <config-stage>: %s.toml", svc)
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

func (x *planExec) stopEcho(name string) { x.p("stop", name) }

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

// --dry-run reaches for nothing: which models are ABSENT is a runtime fact,
// so the plan can only name what would be checked.
func (x *planExec) ensureModels(base string, models []string) {
	if len(models) > 0 {
		x.c("ensure ollama models present at %s (pull each missing one): %s", base, strings.Join(models, ", "))
	}
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
