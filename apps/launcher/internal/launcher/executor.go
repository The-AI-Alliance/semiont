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
	stopRm(name string) bool // teardown; reports whether anything existed
	pause()                  // the settle sleep after teardown
	sweepStaging()           // /tmp/semiont-config.* removal (+ state forget)
	portChecks(ports []portNeed, forceKill bool) bool
	portCheck(p portNeed, forceKill bool) bool // singular wording in plan mode
	stopEcho(name string)                      // the echoed best-effort stop (ollama teardown)
	hostOllamaReachable(addr string, port int) bool
	stageAll(configFile string) (string, bool)           // per-service config copies; returns stage dir
	stageOne(svc, configFile string) (string, bool)      // one service's fresh private copy
	initStack(root, config, version, addr, stage string) // begin the belief record
	pull(img string) bool
	runDetached(args []string) (string, bool) // echo + run -d; returns runtime-reported id
	waitHTTP(label, url string, tries int) (time.Duration, bool)
	waitPG(addr string, port, tries int) (time.Duration, bool)
	probeTCP(role string, rp rolePlan) bool // external-role reachability
	backendReachable(addr string, port int) bool
	resolveAddr() (string, bool) // container→host address ("<host-addr>" in plan mode)
	either(cond func() bool, then, els func() int) int
	otelDetect(addr string) []string       // --service: OTel iff traces is up
	recoverSecret() (string, bool)         // --service: rejoin the running stack's secret
	workerSecret() (string, bool)          // full start: env or generated
	ollamaVolume(opts startOptions) string // model-cache choice (prompt is live-only)
	record(role, id, image, provided, endpoint, driver string)
	val(live, plan string) string // mode-scoped value (kb root, admin password)
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
}

func (x *liveExec) stopRm(name string) bool {
	stopped := runSilent(x.rt, "stop", name) == nil
	rmed := runSilent(x.rt, "rm", name) == nil
	return stopped || rmed
}

func (x *liveExec) pause() { time.Sleep(time.Second) }

func (x *liveExec) portCheck(p portNeed, forceKill bool) bool {
	return requirePortFree(x.u, p.port, p.label, forceKill)
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
	removeState()
}

func (x *liveExec) portChecks(ports []portNeed, forceKill bool) bool {
	for _, pc := range ports {
		if !requirePortFree(x.u, pc.port, pc.label, forceKill) {
			return false
		}
	}
	return true
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

func (x *liveExec) waitHTTP(label, url string, tries int) (time.Duration, bool) {
	return waitForHTTP(x.u, label, url, tries)
}

func (x *liveExec) waitPG(addr string, port, tries int) (time.Duration, bool) {
	return waitForPG(x.u, x.rt, addr, port, tries)
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
		x.st = loadState()
		if x.st == nil {
			x.st = &stackState{
				Runtime: x.rt, KBRoot: x.root, KBDid: loadKBIdentity(x.root).didWeb(),
				Version: x.version, Services: map[string]serviceState{},
			}
		}
	}
	x.st.recordService(role, id, image, provided, endpoint, driver)
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

func (x *planExec) portChecks(ports []portNeed, _ bool) bool {
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

func (x *planExec) waitHTTP(_, url string, tries int) (time.Duration, bool) {
	x.c("wait: %s (%ds)", url, tries)
	return 0, true
}

func (x *planExec) waitPG(addr string, port, tries int) (time.Duration, bool) {
	x.c("wait: tcp localhost:%d (%ds)", port, tries)
	x.c("probe: %s run --rm busybox:1.38.0 nc -z -w 2 %s %d", x.rt, addr, port)
	return 0, true
}

func (x *planExec) probeTCP(string, rolePlan) bool { return true }

func (x *planExec) portCheck(p portNeed, _ bool) bool {
	x.c("require free port: %d", p.port)
	return true
}

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
