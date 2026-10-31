package launcher

// executor.go — the two walking modes for launch flows. Flows (flows.go) touch the world only
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

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// stager: writes what a container will read: each service's configuration document, the launcher-owned
// collector and Prometheus configs, the realm document, the broker's authorization block.
type stager interface {
	stageAll(fc flowCtx, addr string) (string, bool)             // each service's configuration document + the collector's own; returns stage dir
	stageOne(svc string, fc flowCtx, addr string) (string, bool) // one service's configuration document, written afresh
	stageCollector(addr string) (string, bool)                   // the collector's own config: launcher-owned, no KB config involved
	stageMetrics(addr string) (string, bool)                     // Prometheus's scrape config: same launcher-owned pattern
	stageRealm(realm string, doc []byte) (string, bool)          // the realm file Keycloak imports; returns its staged path
	stageNatsConf(doc []byte) (string, bool)                     // the broker's authorization block (no secret in it); returns its staged path
	sweepStaging()                                               // /tmp/semiont-config.* removal (+ state forget)
}

// runner: the container lifecycle itself — pull, run, tear down, and show the crash where it
// happened when a gate fails.
type runner interface {
	verifyImage(svc, img string) (string, bool) // a Semiont image's build provenance, checked; returns it pinned to the digest that runs
	pull(img string) bool
	runDetached(args []string) (string, bool)        // echo + run -d; returns runtime-reported id
	stopRm(name string) bool                         // teardown; reports whether anything existed
	sweepStray(names []string) bool                  // stop+rm the names under every OTHER installed runtime; reports whether anything existed
	settle(ports ...int)                             // wait for torn-down ports to be released
	snapshotLogs(kb kbRoot, names []string)          // crash evidence: capture container logs into the root's state area before a teardown deletes them
	dumpLogs(container, svc string)                  // failed health gate: show the crash where it is
	issuerProxy(listen, upstream, realm string) bool // `network lan`: the detached filtering proxy that serves the issuer to the network, recorded
	retireIssuerProxy()                              // end the issuer proxy the record names, if one runs; before the ports it held are checked
}

// prober: asks whether something is up, and waits on a WALL-CLOCK budget rather than a count
// of attempts.
type prober interface {
	portChecks(ports []portNeed) bool
	portCheck(p portNeed) bool // singular wording in plan mode
	hostOllamaReachable(addr string, port int) bool
	waitHTTP(label, container, url string, seconds int) (time.Duration, bool)      // wall-clock budget, not attempts; ends when the container stops
	waitTCP(label, pollHost, addr string, port, seconds int) (time.Duration, bool) // polls pollHost from here, then asks addr once from a container's side
	waitPGAccepting(seconds int) bool                                              // the port gate does not prove PostgreSQL accepts sessions; initdb's temporary server is why
	probeTCP(role string, rp rolePlan) bool                                        // external-role reachability
	gatewayReachable(addr string, port int) bool
	resolveAddr() (string, bool)     // container→host address ("<host-addr>" in plan mode)
	otelDetect(addr string) []string // --service: OTel iff the collector is up
}

// recorder: the belief record: what this machine thinks is running, and how each role was
// provided. Written as the stack comes up, read by status and by the next start.
type recorder interface {
	initStack(kb kbRoot, config, addr, stage string) // begin the belief record
	recordPorts(ports []portNeed)                    // note claimed host ports in the belief record
	record(role, id, image, provided, endpoint, driver string)
	providerOf(role string) string        // how an already-recorded role was provided
	noteContainer(role, container string) // stamp a launched container on a container-less role
	browserCurrent(desired string) bool   // running AND image identity matches
	browserRecord() *ServiceState         // the machine-level browser record
	recordBrowser(id, image string, port int)
}

// keeper: credentials that must OUTLIVE the stack — generated once per root and persisted,
// because a regenerated one invalidates every token already issued.
type keeper interface {
	jwtSecret(kb kbRoot) (string, bool)                       // gateway token-signing key: env, else persisted per-root, else generated
	identityAdminPassword(kb kbRoot) (string, bool)           // Keycloak's bootstrap admin password: same three sources
	serviceClientSecret(kb kbRoot, svc string) (string, bool) // one service's account credential, per root
	workerKey() (workerKey, bool)                             // the key this machine's worker proves itself with, one per machine
	daemonPassword(kb kbRoot, role string) (string, bool)     // a launcher-run daemon's password, generated and kept per root
}

// admitter: proves the issuer will admit the services, and the people, BEFORE anything holds a
// credential or a person is sent to sign in.
type admitter interface {
	preflightIdentity(issuerBase, audience string, accounts realmAccounts, wantLifespan int, managed bool) bool // the realm honours every service credential AND the clients people sign in through, before anything holds one. `managed` = this launcher runs the realm, so `semiont identity sync` is the repair
	preflightBrowserMove(issuerBase string, port int) bool                                                      // the realm will redirect to, and accept a token exchange from, the port the Browser is moving to
	openAdminToThisMachine(password string)                                                                     // Keycloak's own admin answers this machine over plain HTTP, whatever address the runtime delivers its connections from
}

// storer: durable state on disk: which mounts a role gets, whose image stamped them, and the
// database a launcher-run PostgreSQL must already carry.
type storer interface {
	stateMounts(role, image string, kb kbRoot) ([]string, bool)   // persistent-state run args; !ok = refuse (data written by another image)
	stateMountsUnstamped(role string, kb kbRoot) ([]string, bool) // the same mounts for a store no image stamps
	resolveStoreStamps(fc flowCtx) bool                           // preflight: every store's mismatch refuse/clear, before the first container run
	createDatabase(user, name string) bool                        // a database on the launcher-run PostgreSQL, if absent
	ollamaVolume(opts startOptions) string                        // model-cache choice (prompt is live-only)
}

// modeler: the models a role serves — pulled when absent locally, verified when remote.
type modeler interface {
	verifyRemoteModels(role, base, key string, models []string) // record /v1/models metadata; warn on unlisted
	ensureModels(base string, models []modelNeed)               // pull configured ollama models that are absent
}

// narrator: what the operator sees. `say` narrates a live run and is silent in plan mode;
// `note` is the reverse, so one flow text serves both walks.
type narrator interface {
	banner(s string)
	dim(s string) string
	say(kind sayKind, format string, a ...any) // live narration; nothing in plan mode
	note(format string, a ...any)              // plan comment; nothing in live mode
}

// modeScope: the few places a flow must ask which walk it is on, rather than being written once
// for both.
type modeScope interface {
	val(live, plan string) string // mode-scoped value (kb root, admin password)
	rtName() string
	exposure(addr string) exposure // where this start publishes, its containers reaching the host at addr
	either(cond func() bool, then, els func() int) int
}

// executor: the seam that lets each launch flow be written ONCE and walked
// twice — live by liveExec, as a plan by planExec.
//
// A composition of roles rather than a list, since a list of 52 is something
// you append to without deciding anything. A new effect belongs to one of these
// roles; if it belongs to none, that is worth noticing before it is written,
// and executor_roles_test.go is what notices.
type executor interface {
	stager
	runner
	prober
	recorder
	keeper
	admitter
	storer
	modeler
	narrator
	modeScope
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
	kb       kbRoot // the KB root and its identity; zero for root-free services
	// plan lets record() stamp each role's configured models without every
	// flow having to pass them; models are config truth, so they belong to
	// the record the same way the driver does.
	plan *launchPlan
	// lan: this Mac's address on the network for a `network lan` start, else
	// empty (startNetwork).
	lan string
}

// present lists the semiont-* containers that EXIST under a runtime — running
// or stopped, because a stopped container still holds its name and the next
// `run --name` fails on it.
//
// ONE list per runtime, cached for the life of the command. Firing `stop`
// then `rm` at every name blindly, on every installed runtime, costs dozens of
// fork/execs to discover, usually, that nothing is there, and infers "did
// anything exist?" from the exit codes of commands EXPECTED to fail. Asking
// once is both faster and a straight answer.
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
	// and firing teardown at a runtime that would not answer a list spends
	// its spawns learning nothing.
	x.existing[rt] = names
	return names
}

func (x *liveExec) snapshotLogs(kb kbRoot, names []string) {
	if dir, n := writeLogSnapshot(x.rt, kb.key(), names); n > 0 {
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
// reach it, else print the Ollama-Desktop diagnostics and fail (Docker
// Desktop's bridge gateway does not reach the Mac host).
func (x *liveExec) hostOllamaReachable(addr string, port int) bool {
	if runSilent(x.rt, "run", "--rm", probeImage, "sh", "-c",
		fmt.Sprintf("wget -q -O- http://%s:%d/api/version", addr, port)) == nil {
		return true
	}
	fmt.Println()
	x.u.Warn("Ollama is running on the host but not reachable from containers.")
	fmt.Printf("   The gateway runs in a container and needs Ollama at %s:%d.\n", addr, port)
	fmt.Println()
	if found := ollamaOnHost(); found != "" {
		fmt.Println("   Detected: " + found)
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
				Runtime: x.rt, KBRoot: x.kb.dir, KBDid: x.kb.ident.didWeb(),
				Services: map[string]ServiceState{},
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

// stageDir makes a fresh directory per run and keeps it to its owner: that is
// what keeps the secrets staged in it — the realm's client secrets, the
// broker's credentials — from other users. The files inside stay 0644 because
// Docker on Linux and rootless Podman present a bind-mounted file with its host
// owner and mode, and the containers read them as their own users (Keycloak as
// uid 1000); a 0600 file would be readable only when the uids happen to match.
func (x *liveExec) stageDir() (string, bool) {
	stage, err := os.MkdirTemp(stagingParent(), "semiont-config.")
	if err != nil {
		x.u.Fail("Cannot create config staging dir: %v", err)
		return "", false
	}
	if err := ownerOnlyDir(stage); err != nil {
		x.u.Fail("Cannot keep config staging dir %s to its owner: %v", stage, err)
		return "", false
	}
	return stage, true
}

// gatewayDocumentFile: the document the gateway is configured by
// (gatewaydoc.go). One name, staged and mounted.
const gatewayDocumentFile = "gateway.json"

// gatewayDocumentTarget: where the gateway reads that document — the path its
// image passes to `--config`; TestConfigDocumentsAreWhereTheImagesLook holds
// the two together. Its own name and place: a resolved JSON artifact, not the
// documents it was derived from.
const gatewayDocumentTarget = "/etc/semiont/gateway.json"

// serviceDocuments: each stack service's configuration document — the file it
// is staged as, the name a refusal gives it, and its writer, handed the
// knowledge base the service serves. The worker's names it among the
// knowledge bases it serves, by its domain; the Archivist's names none: the
// Archivist reads its knowledge base's identity from the tree it keeps.
var serviceDocuments = map[string]struct {
	file, noun string
	write      func(p placement, served api.KbIdentity) ([]byte, error)
}{
	"gateway":    {gatewayDocumentFile, "the gateway's", gatewayDocument},
	"dispatcher": {dispatcherDocumentFile, "the dispatcher's", dispatcherDocument},
	"archivist":  {archivistDocumentFile, "the Archivist's", func(p placement, _ api.KbIdentity) ([]byte, error) { return archivistDocument(p) }},
	"worker": {workerDocumentFile, "the worker's", func(p placement, served api.KbIdentity) ([]byte, error) {
		added, err := loadAddedKBs()
		if err != nil {
			return nil, err
		}
		return workerDocument(p, served.Domain, added)
	}},
	"smelter":   {smelterDocumentFile, "the Smelter's", smelterDocument},
	"weaver":    {weaverDocumentFile, "the Weaver's", weaverDocument},
	"librarian": {librarianDocumentFile, "the Librarian's", librarianDocument},
}

// stageService writes one service's configuration document into the stage:
// the gateway's, the dispatcher's, the Archivist's, the worker's, the
// Smelter's, the Weaver's or the Librarian's. Every stack service has one.
func (x *liveExec) stageService(stage, svc string, fc flowCtx, addr string) bool {
	document, ok := serviceDocuments[svc]
	if !ok {
		x.u.Fail("%s has no configuration document to stage", svc)
		return false
	}
	served, err := fc.kb.served()
	var doc []byte
	if err == nil {
		doc, err = document.write(placementOf(fc, x.exposure(addr)), served)
	}
	if err == nil {
		err = os.WriteFile(filepath.Join(stage, document.file), doc, 0o644)
	}
	if err != nil {
		x.u.Fail("Writing %s configuration document: %v", document.noun, err)
		return false
	}
	return true
}

func (x *liveExec) stageAll(fc flowCtx, addr string) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	for _, svc := range stackServices {
		if !fc.plan.runs(svc) {
			continue
		}
		if !x.stageService(stage, svc, fc, addr) {
			return "", false
		}
	}
	// The collector's config is the launcher's own; the variant follows
	// --observe (traces → Jaeger or nop).
	if err := os.WriteFile(filepath.Join(stage, "collector.yaml"), []byte(collectorConfig(addr, fc.opts.observe)), 0o644); err != nil {
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

// stageCollector: --service collector has no document of the KB's stack; it
// stages only the launcher-written YAML. Traces route to Jaeger
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

func (x *liveExec) stageOne(svc string, fc flowCtx, addr string) (string, bool) {
	stage, ok := x.stageDir()
	if !ok {
		return "", false
	}
	if !x.stageService(stage, svc, fc, addr) {
		return "", false
	}
	return stage, true
}

func (x *liveExec) initStack(kb kbRoot, config, addr, stage string) {
	x.st = &StackState{
		Runtime: x.rt, KBRoot: kb.dir, KBDid: kb.ident.didWeb(),
		Config:   config,
		HostAddr: addr, LanAddr: x.lan, Stage: stage, Services: map[string]ServiceState{},
	}
}

func (x *liveExec) verifyImage(svc, img string) (string, bool) {
	release := semiontRelease(svc)
	digest, err := imageVerifier().Verify(img, release)
	if err != nil {
		x.u.Fail("%s does not run: %v", img, err)
		fmt.Fprintf(os.Stderr, "  An image of Semiont's runs only when a release built it: %s, run at a release tag (refs/tags/v…).\n", release.Workflow)
		fmt.Fprintln(os.Stderr, "  Name a released image in the document, or build it on this machine as :local, which runs unverified.")
		return "", false
	}
	return pinnedImage(img, digest), true
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
	argv, env := offCommandLine(withLogOpts(x.rt, args))
	x.u.EchoCmd(x.rt, argv...)
	id, err := runDetached(x.rt, env, argv...)
	if err != nil {
		return "", false
	}
	return id, true
}

func (x *liveExec) waitHTTP(label, container, url string, seconds int) (time.Duration, bool) {
	return waitForContainerHTTP(x.u, x.rt, label, container, url, seconds)
}

func (x *liveExec) waitTCP(label, pollHost, addr string, port, seconds int) (time.Duration, bool) {
	return waitForTCP(x.u, x.rt, label, pollHost, addr, port, seconds)
}

func (x *liveExec) waitPGAccepting(seconds int) bool {
	return waitPGAccepting(x.u, x.rt, descriptorFor("database", "postgres").container, seconds)
}

func (x *liveExec) probeTCP(role string, rp rolePlan) bool {
	return verifyExternal(x.u, role, rp)
}

func (x *liveExec) gatewayReachable(addr string, port int) bool {
	x.u.Log("Verifying gateway reachable from containers...")
	t0 := time.Now()
	for i := 0; i < 20; i++ {
		if runSilent(x.rt, "run", "--rm", probeImage, "sh", "-c",
			fmt.Sprintf("wget -q -O- http://%s:%d/api/health", addr, port)) == nil {
			x.u.Ok("Gateway reachable from containers %s", x.u.Dim("("+took(time.Since(t0))+")"))
			return true
		}
		time.Sleep(time.Second)
	}
	x.u.Fail("Gateway not reachable from containers at %s:%d within 20s.", addr, port)
	return false
}

// hostProbeBudget bounds the wait for a runtime whose daemon answers but which
// cannot run a container yet — docker-in-docker seconds after dockerd starts,
// which is exactly when a codespace's post-start runs on resume (eight
// seconds is not enough). A daemon that does not answer at all is not waited
// for; that is daemonDownFixit's case.
const hostProbeBudget = 30 * time.Second

func (x *liveExec) resolveAddr() (string, bool) {
	t0 := time.Now()
	announced := false
	for {
		addr, why := resolveHostAddr(x.rt)
		if addr != "" {
			return addr, true
		}
		if fixit := daemonDownFixit(x.rt); fixit != "" {
			x.u.Fail("Could not determine host address for container networking.")
			fmt.Fprintln(os.Stderr, "  "+fixit)
			return "", false
		}
		if time.Since(t0) >= hostProbeBudget {
			x.u.Fail("Could not determine host address for container networking: the runtime answers, but its probe container did not run within %s.", took(hostProbeBudget))
			if why != "" {
				fmt.Fprintln(os.Stderr, "  "+x.rt+" said: "+why)
			}
			return "", false
		}
		if !announced {
			x.u.Log("The runtime answers but cannot run a container yet — waiting %s", x.u.Dim("(up to "+took(hostProbeBudget)+"; a daemon that just started)"))
			announced = true
		}
		time.Sleep(2 * time.Second)
	}
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
	if httpOK(fmt.Sprintf("http://%s:24110/metrics", x.exposure(addr).probeHost("collector", 24110))) {
		x.u.Log("OTel collector detected — export enabled")
		return otelArgs(addr)
	}
	return nil
}

// jwtSecret is per-root and persisted, so a --service gateway restart resolves
// the SAME value a full start did. Every credential the launcher hands out
// works this way.
//
// kb is the flow's resolved root, passed rather than found from the working
// directory: a key found that way keys a signing key off whatever directory
// a chdir a few hundred lines away happened to leave.
func (x *liveExec) jwtSecret(kb kbRoot) (string, bool) {
	return loadOrCreateJWTSecret(x.u, kb.key())
}

func (x *liveExec) identityAdminPassword(kb kbRoot) (string, bool) {
	return loadOrCreateKeycloakAdminPassword(x.u, kb.key())
}

func (x *liveExec) serviceClientSecret(kb kbRoot, svc string) (string, bool) {
	return loadOrCreateServiceClientSecret(x.u, kb.key(), svc)
}

func (x *liveExec) workerKey() (workerKey, bool) {
	return loadOrCreateWorkerKey(x.u)
}

func (x *liveExec) daemonPassword(kb kbRoot, role string) (string, bool) {
	return loadOrCreateDaemonPassword(x.u, kb.key(), role)
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
// Retried even though waitPGAccepting gates it: a session can be cut off
// mid-statement by the end of initdb ("terminating connection due to
// administrator command"), and a retry costs a second. The attempt's output is
// CAPTURED — printing the stderr of a failure the loop expects to absorb
// makes a recovered start look like a broken one.
func (x *liveExec) createDatabase(user, name string) bool {
	sql := fmt.Sprintf("SELECT 'CREATE DATABASE %s' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '%s')\\gexec\n", name, name)
	args := []string{"exec", "-i", descriptorFor("database", "postgres").container, "psql", "-U", user, "-v", "ON_ERROR_STOP=1", "-q"}
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
	var models []servedModel
	if x.plan != nil {
		models = x.plan.Roles[role].Models
	}
	x.stack().recordService(role, id, image, provided, endpoint, driver, models)
}

// stack: the record this start writes to. A full start began it (initStack);
// a --service start loads the running stack's, or creates one with full
// metadata.
func (x *liveExec) stack() *StackState {
	if x.st == nil {
		x.st = loadLocalState()
		if x.st == nil {
			x.st = &StackState{
				Runtime: x.rt, KBRoot: x.kb.dir, KBDid: x.kb.ident.didWeb(),
				Services: map[string]ServiceState{},
			}
		}
	}
	return x.st
}

func (x *liveExec) issuerProxy(listen, upstream, realm string) bool {
	pid, ok := spawnIssuerProxy(x.u, listen, upstream, realm)
	if !ok {
		return false
	}
	st := x.stack()
	st.IssuerProxy = &issuerProxyRecord{PID: pid, Listen: listen, Upstream: upstream, Realm: realm}
	st.LanAddr = x.lan
	saveStack(st)
	x.u.Log("Issuer proxy running %s", x.u.Dim(fmt.Sprintf("(detached, pid %d, %s → %s — recorded; semiont stop ends it)", pid, listen, upstream)))
	return true
}

func (x *liveExec) retireIssuerProxy() { retireIssuerProxy(x.u) }

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
// or a typo'd id): the remote analog of a MISSING ollama model, and the
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

// openAdminToThisMachine: Keycloak's own admin lives in its master realm, which
// keeps Keycloak's default `sslRequired: external` — plain HTTP only from a
// private address. Which address this machine's connections arrive from is the
// runtime's affair: Docker Desktop delivers them from one that is not private,
// and there every admin call `identity sync` and `useradd` make from here is
// refused "HTTPS required". From inside the container the connection is local,
// and the change is allowed. The password crosses as the runtime's own environment:
// named in argv, never valued there.
//
// Warns rather than refusing: the stack runs without the admin, and only those
// two commands need it — but they will be refused, and this says why first.
func (x *liveExec) openAdminToThisMachine(password string) {
	args := append([]string{"exec", "--env", "KC_CLI_PASSWORD", roleContainer("identity")}, masterRealmOverHTTP()...)
	x.u.EchoCmd(x.rt, args...)
	out, err := runCapturedWithEnv([]string{"KC_CLI_PASSWORD=" + password}, x.rt, args...)
	if err != nil {
		x.say(sayWarn, "Keycloak's admin is not reachable from this machine, so `semiont useradd` and `semiont identity sync` will be refused: %v", err)
		if s := strings.TrimSpace(out); s != "" {
			fmt.Fprintln(os.Stderr, indentLines(s, "    "))
		}
		return
	}
	x.say(sayLog, "Keycloak admin: %s", x.dim("reachable from this machine over HTTP"))
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
func (x *liveExec) preflightIdentity(issuerBase, audience string, accounts realmAccounts, wantLifespan int, managed bool) bool {
	findings, observedLifespan := verifyServiceAccounts(issuerBase, audience, accounts)
	if len(findings) > 0 {
		x.u.Fail("The issuer does not honour the service-account credentials this start would inject.")
		for _, f := range findings {
			fmt.Fprintln(os.Stderr, "  "+f.String())
		}
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  A realm is imported on its FIRST boot and never again, so a realm created")
		fmt.Fprintln(os.Stderr, "  before these clients existed does not have them.")
		fmt.Fprintln(os.Stderr, "")
		// The repair, named rather than described — but named as the
		// COMMANDS TO RUN, in order, with the follow-up: naming a verb
		// alone leaves the sequence to be inferred.
		secretFinding := slices.IndexFunc(findings, func(f serviceAccountFinding) bool { return f.svc != "worker" })
		workerFinding := slices.ContainsFunc(findings, func(f serviceAccountFinding) bool { return f.svc == "worker" })
		if managed {
			fmt.Fprintf(os.Stderr, "  Fix it:  %s\n", x.u.Bold("semiont identity sync"))
			fmt.Fprintf(os.Stderr, "           %s\n", x.u.Dim("Adds the missing clients, and reconciles an existing one's roles and kind mappers and the worker's key. Touches no accounts."))
			fmt.Fprintln(os.Stderr, "")
			fmt.Fprintf(os.Stderr, "  Then:    %s\n", x.u.Bold("semiont start"))
			fmt.Fprintf(os.Stderr, "           %s\n", x.u.Dim("This start again, which will then get past this gate."))
			if secretFinding >= 0 {
				// The case sync cannot repair, said plainly rather than left for
				// the operator to discover by looping. On a client that already
				// exists reconcileServiceClients never reconciles the secret —
				// it cannot know it — so "already correct" on a secret client
				// named above is not success, it is the other cause. The
				// worker's key it does know, and reconciles.
				fmt.Fprintln(os.Stderr, "")
				fmt.Fprintln(os.Stderr, "  If sync reports a client above as already correct rather than created, that")
				fmt.Fprintln(os.Stderr, "  client exists with a DIFFERENT secret, which sync does not change. Delete it")
				fmt.Fprintln(os.Stderr, "  in the Keycloak admin console and run sync again.")
			}
			return false
		}
		// Deliberately does NOT mention `semiont identity sync`, even to rule
		// it out: it needs an admin password this root never persisted for an
		// issuer it did not start, and a named command gets skimmed into an
		// instruction to run it.
		fmt.Fprintln(os.Stderr, "  This issuer is one you run, so its clients are yours to create.")
		if secretFinding >= 0 {
			svc := findings[secretFinding].svc
			fmt.Fprintln(os.Stderr, "  For each client named above: create it, enable the client-credentials grant,")
			fmt.Fprintf(os.Stderr, "  and supply its secret as %s — for example %s\n",
				x.u.Bold("SEMIONT_OIDC_CLIENT_SECRET_<SERVICE>"),
				serviceClientSecretEnv(svc)+" for "+serviceClientID(svc)+".")
		}
		if workerFinding {
			fmt.Fprintf(os.Stderr, "  For %s: create it with the signed-JWT client authenticator, enable the\n", serviceClientID("worker"))
			fmt.Fprintf(os.Stderr, "  client-credentials grant, and register on it the key %s prints.\n", x.u.Bold("semiont worker key"))
		}
		return false
	}
	x.u.Log("Service accounts: %s", x.u.Dim(fmt.Sprintf("%d verified at the realm", len(secretClients)+1)))

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
	x.u.Log("Sign-in clients: %s", x.u.Dim(semiont.BrowserClientID+" and "+semiont.ScriptClientID+" verified at the realm"))
	return true
}

// dumpLogs prints the tail of a just-launched container's own logs when its
// health gate fails. The crash cause is usually sitting right there, in
// `logs` for the whole wait, while the launcher says only "did not become
// ready".
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

func (x *liveExec) recordBrowser(id, img string, port int) {
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
// forever by delete-and-recreate.
func (x *liveExec) resolveStoreStamp(role, image, key string) bool {
	spec := stateStores[role]
	dir := stateRootDir(key)
	sd := spec.storeDir(key)
	meta := loadRootMeta(dir)
	prev, stamp := meta.Stores[role].Image, stampOf(image)
	if prev == "" || prev == stamp {
		return true
	}
	if storeDirNonEmpty(sd) {
		if !spec.projection {
			x.u.Fail("%s state at %s was written by %s; this config launches %s.", role, sd, prev, stamp)
			fmt.Fprintln(os.Stderr, "  That data is not auto-deleted. Remove it first: semiont clean --store "+role)
			return false
		}
		x.u.Log("%s state at %s was written by %s; this config launches %s — projections rebuild, so clearing it.",
			role, sd, prev, stamp)
		if err := clearStoreContents(x.rt, sd); err != nil {
			x.u.Fail("cannot clear %s state %s: %v", role, sd, err)
			return false
		}
	}
	// Restamp here, not at the owner's prep: the stamped image's output is
	// gone, and a resolution that leaves its stamp re-fires at the owner's own
	// stateMounts.
	meta.Stores[role] = storeMeta{Image: stamp}
	saveRootMeta(dir, meta)
	return true
}

// resolveStoreStamps runs every store's stamp resolution in PREFLIGHT, so a
// clear lands before any container runs rather than mid-boot.
func (x *liveExec) resolveStoreStamps(fc flowCtx) bool {
	for _, role := range slices.Sorted(maps.Keys(stateStores)) {
		spec := stateStores[role]
		if spec.unstamped {
			continue
		}
		var img string
		if rp, ok := fc.plan.Roles[spec.owner]; ok {
			if rp.Presence != presenceLauncher {
				continue // remote or absent: this boot mounts no such store
			}
			img = rp.Image
		} else {
			img = fc.plan.Images[spec.owner]
		}
		if !x.resolveStoreStamp(role, img, fc.kb.key()) {
			return false
		}
	}
	return true
}

// stateMounts prepares a role's persistent state dir and returns the run
// args that mount it. The image-mismatch split lives in resolveStoreStamp:
// database data is user rows — refuse, fix-it names the clean command;
// projections (vectors/graph) auto-clean and rebuild.
func (x *liveExec) stateMounts(role, image string, kb kbRoot) ([]string, bool) {
	key := kb.key()
	args := stateMountArgs(role, key)
	if len(args) == 0 {
		return nil, true
	}
	spec := stateStores[role]
	dir := stateRootDir(key)
	meta := loadRootMeta(dir)
	// A full start has already resolved the stamp in preflight (this re-check
	// no-ops on the emptied dir); single-service starts resolve here.
	if !x.resolveStoreStamp(role, image, key) {
		return nil, false
	}
	if !x.openStoreDirs(spec, key) {
		return nil, false
	}
	meta.KBRoot = kb.dir
	meta.Did = kb.ident.didWeb()
	meta.Stores[role] = storeMeta{Image: stampOf(image)}
	saveRootMeta(dir, meta)
	return args, true
}

// stateMountsUnstamped: a store's mounts for its owner when no image stamps
// it — the anchored-text store and the gateway's and the Librarian's
// supervisor logs. An anchored-text entry says what derived it, and a log
// line is what happened whichever image wrote it, so no image change clears
// either; the bind is the one stateMounts makes, without the stamp.
func (x *liveExec) stateMountsUnstamped(role string, kb kbRoot) ([]string, bool) {
	args := stateMountArgs(role, kb.key())
	if len(args) == 0 {
		return nil, true
	}
	if !x.openStoreDirs(stateStores[role], kb.key()) {
		return nil, false
	}
	return args, true
}

// openStoreDirs creates a store's mount dirs with the store's mode and clamps
// the root's state dir to owner-only. Both mount paths run it, so the mode
// belongs to the store, not to one path's prep.
func (x *liveExec) openStoreDirs(spec stateStoreSpec, key string) bool {
	sd := spec.storeDir(key)
	for _, m := range spec.mounts {
		mp := filepath.Join(sd, m.sub)
		if err := os.MkdirAll(mp, 0o755); err != nil {
			x.u.Fail("cannot create store directory %s: %v", mp, err)
			return false
		}
		if spec.mode != 0 {
			// MkdirAll perms pass through the umask; stamp the literal mode.
			if err := os.Chmod(mp, spec.mode); err != nil {
				x.u.Fail("cannot chmod store directory %s: %v", mp, err)
				return false
			}
		}
	}
	// A mount dir may be open to every uid. The root's state dir is the
	// unmounted parent of all of them — no container sees it — so owner-only
	// here keeps other local users from traversing to any store.
	dir := stateRootDir(key)
	if err := ownerOnlyDir(dir); err != nil {
		x.u.Fail("cannot keep this knowledge base's stores directory %s to its owner: %v", dir, err)
		return false
	}
	return true
}

func (x *liveExec) val(live, _ string) string { return live }
func (x *liveExec) rtName() string            { return x.rt }
func (x *liveExec) dim(s string) string       { return x.u.Dim(s) }
func (x *liveExec) exposure(addr string) exposure {
	return exposure{rt: x.rt, addr: addr, lan: x.lan}
}

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
	// lan: "<lan-addr>" for a `network lan` start, else empty (startNetwork).
	lan string
}

func (x *planExec) p(args ...string)          { fmt.Println(renderCmd(x.rt, args...)) }
func (x *planExec) c(format string, a ...any) { fmt.Printf("# "+format+"\n", a...) }
func (x *planExec) snapshotLogs(kbRoot, []string) {
	x.c("snapshot container logs into <state-root>/logs/<timestamp>/ before removal")
}
func (x *planExec) stopRm(name string) bool { x.p("stop", name); x.p("rm", name); return false }
func (x *planExec) settle(...int)           {} // plan mode tears nothing down
func (x *planExec) sweepStaging()           { x.c("remove staged configs: %s", stagingPattern()) }

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

func (x *planExec) stageAll(fc flowCtx, addr string) (string, bool) {
	x.c("write <config-stage>/%s (the gateway's configuration document: GatewayConfig, resolved)", gatewayDocumentFile)
	x.c("write <config-stage>/%s (the dispatcher's configuration document: DispatcherConfig, resolved)", dispatcherDocumentFile)
	x.c("write <config-stage>/%s (the Archivist's configuration document: ArchivistConfig, resolved)", archivistDocumentFile)
	if fc.plan.runs("worker") {
		x.c("write <config-stage>/%s (the worker's configuration document: WorkerConfig, resolved)", workerDocumentFile)
	}
	x.c("write <config-stage>/%s (the Smelter's configuration document: SmelterConfig, resolved)", smelterDocumentFile)
	x.c("write <config-stage>/%s (the Weaver's configuration document: WeaverConfig, resolved)", weaverDocumentFile)
	x.c("write <config-stage>/%s (the Librarian's configuration document: LibrarianConfig, resolved)", librarianDocumentFile)
	x.c("write into each document the addresses this start places, as literals (launcher-placed topology):")
	for _, line := range placementOf(fc, x.exposure(addr)).placedLines() {
		x.c("  %s", line)
	}
	x.c("write <config-stage>/collector.yaml (launcher-owned; traces exporter iff observing)")
	x.c("write <config-stage>/prometheus.yml (launcher-owned; scrapes the collector readout)")
	return "<config-stage>", true
}

func (x *planExec) stageOne(svc string, _ flowCtx, _ string) (string, bool) {
	if svc == "gateway" {
		x.c("write a fresh <config-stage>/%s (the gateway's configuration document: GatewayConfig, resolved)", gatewayDocumentFile)
		return "<config-stage>", true
	}
	if svc == "dispatcher" {
		x.c("write a fresh <config-stage>/%s (the dispatcher's configuration document: DispatcherConfig, resolved)", dispatcherDocumentFile)
		return "<config-stage>", true
	}
	if svc == "archivist" {
		x.c("write a fresh <config-stage>/%s (the Archivist's configuration document: ArchivistConfig, resolved)", archivistDocumentFile)
		return "<config-stage>", true
	}
	if svc == "worker" {
		x.c("write a fresh <config-stage>/%s (the worker's configuration document: WorkerConfig, resolved)", workerDocumentFile)
		return "<config-stage>", true
	}
	if svc == "smelter" {
		x.c("write a fresh <config-stage>/%s (the Smelter's configuration document: SmelterConfig, resolved)", smelterDocumentFile)
		return "<config-stage>", true
	}
	if svc == "weaver" {
		x.c("write a fresh <config-stage>/%s (the Weaver's configuration document: WeaverConfig, resolved)", weaverDocumentFile)
		return "<config-stage>", true
	}
	if svc == "librarian" {
		x.c("write a fresh <config-stage>/%s (the Librarian's configuration document: LibrarianConfig, resolved)", librarianDocumentFile)
		return "<config-stage>", true
	}
	x.c("%s has no configuration document to stage", svc)
	return "", false
}

func (x *planExec) initStack(kbRoot, string, string, string) {}

func (x *planExec) verifyImage(svc, img string) (string, bool) {
	x.c("verify %s: its build provenance, signed by %s at a release tag (refs/tags/v…); then pull and run it by its digest", img, semiontWorkflow(svc))
	return pinnedImage(img, "sha256:<verified>"), true
}

func (x *planExec) pull(img string) bool {
	x.p(pullArgs(x.rt, img)...)
	return true
}

func (x *planExec) runDetached(args []string) (string, bool) {
	argv, _ := offCommandLine(withLogOpts(x.rt, args))
	x.p(argv...)
	return "", true
}

func (x *planExec) waitHTTP(_, _, url string, seconds int) (time.Duration, bool) {
	x.c("wait: %s (%ds)", url, seconds)
	return 0, true
}

func (x *planExec) waitPGAccepting(seconds int) bool {
	x.c("wait: %s exec %s pg_isready -h 127.0.0.1 (%ds) — the REAL server; initdb's temporary one answers the socket only",
		x.rt, descriptorFor("database", "postgres").container, seconds)
	return true
}

func (x *planExec) waitTCP(_, pollHost, addr string, port, seconds int) (time.Duration, bool) {
	x.c("wait: tcp %s:%d (%ds)", pollHost, port, seconds)
	x.c("probe: %s run --rm %s nc -z -w 2 %s %d", x.rt, probeImage, addr, port)
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
	x.c(`probe: %s run --rm %s sh -c "wget -q -O- http://%s:%d/api/health" (up to 20 tries)`, x.rt, probeImage, addr, port)
	return true
}

func (x *planExec) resolveAddr() (string, bool) {
	switch x.rt {
	case "container":
		x.c(`probe: container run --rm %s sh -c "ip route | awk '/default/{print $3}'" → <host-addr>`, probeImage)
	case "docker":
		x.c("probe: docker run --rm %s nslookup host.docker.internal (fallback: default-gateway probe) → <host-addr>", probeImage)
	case "podman":
		x.c("probe: podman run --rm %s nslookup host.containers.internal (fallback: default-gateway probe) → <host-addr>", probeImage)
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
func (x *planExec) jwtSecret(kbRoot) (string, bool) { return "<jwt-secret>", true }

func (x *planExec) identityAdminPassword(kbRoot) (string, bool) {
	return "<keycloak-admin-password>", true
}

func (x *planExec) serviceClientSecret(_ kbRoot, svc string) (string, bool) {
	return "<" + svc + "-client-secret>", true
}

func (x *planExec) workerKey() (workerKey, bool) {
	return workerKey{registeredKey: registeredKey{public: "<worker-public-key>", thumbprint: "<worker-key-thumbprint>"}, private: "<worker-key>"}, true
}

func (x *planExec) daemonPassword(_ kbRoot, role string) (string, bool) {
	return "<" + daemonPasswords[role].custody + ">", true
}

func (x *planExec) stageNatsConf(_ []byte) (string, bool) {
	x.c("stage the broker's authorization block (no credential in it — the daemon interpolates $NATS_USER/$NATS_PASSWORD from its own environment)")
	return "<stage>/nats-semiont.conf", true
}

// The clients are read OUT OF the document rather than described alongside it.
// A restatement of someone else's shape drifts the moment that shape grows;
// this cannot, because adding a client to keycloakRealmJSON adds it here too.
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

func (x *planExec) issuerProxy(listen, upstream, realm string) bool {
	x.c("run detached: semiont %s — the issuer at the network address, passing the realm's paths alone (recorded; semiont stop ends it)", strings.Join(issuerProxyArgs(listen, upstream, realm), " "))
	return true
}

func (x *planExec) retireIssuerProxy() {
	x.c("end the issuer proxy the record names, if one runs")
}

// --dry-run: the keep-or-restart decision is a runtime fact; either() shows
// both branches, so these answer neutrally.
func (x *planExec) browserCurrent(string) bool        { return false }
func (x *planExec) browserRecord() *ServiceState      { return nil }
func (x *planExec) recordBrowser(string, string, int) {}

// --dry-run reaches for nothing: whether the realm honours a credential is a
// runtime fact. Name the grant each client would be asked for, and what the
// answer must carry.
func (x *planExec) preflightIdentity(issuerBase, audience string, accounts realmAccounts, wantLifespan int, _ bool) bool {
	for _, svc := range secretClients {
		x.c("client-credentials grant at %s as %s — require flat `roles` containing %q and `aud` containing %s",
			issuerBase, serviceClientID(svc), serviceRole, audience)
	}
	x.c("client-credentials grant at %s as %s, by an assertion signed with the machine's worker key (%s) — require flat `roles` containing %q and %q, and `aud` containing %s",
		issuerBase, serviceClientID("worker"), accounts.worker.thumbprint, serviceRole, workerRole, audience)
	x.c("device authorization at %s as %s — require the grant to be enabled for it", issuerBase, semiont.ScriptClientID)
	x.c("authorization request at %s as %s — require a redirect to %s", issuerBase, semiont.BrowserClientID, probeRedirect)
	x.c("the same request carrying NO code challenge — require it to be refused, so PKCE is enforced rather than merely offered")
	x.c("password grant at %s as %s and %s, sending no credential — require both to refuse it", issuerBase, semiont.BrowserClientID, semiont.ScriptClientID)
	if wantLifespan > 0 {
		x.c("compare `exp - iat` on those tokens against the configured %ds — warn if the realm was imported with another", wantLifespan)
	}
	return true
}

func (x *planExec) openAdminToThisMachine(string) {
	x.c("open Keycloak's admin to this machine over HTTP: %s exec --env KC_CLI_PASSWORD %s %s",
		x.rt, roleContainer("identity"), strings.Join(masterRealmOverHTTP(), " "))
}

func (x *planExec) preflightBrowserMove(issuerBase string, port int) bool {
	x.c("authorization request at %s as %s — require a redirect to http://localhost:%d/en/auth/callback, the port this move puts the Browser on",
		issuerBase, semiont.BrowserClientID, port)
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
func (x *planExec) stateMounts(role, _ string, kb kbRoot) ([]string, bool) {
	args := stateMountArgs(role, kb.key())
	if len(args) > 0 {
		x.c("%s state: %s (created if absent; reused across restarts)",
			role, stateStores[role].storeDir(kb.key()))
	}
	return args, true
}

func (x *planExec) stateMountsUnstamped(role string, kb kbRoot) ([]string, bool) {
	x.c("mount %s state (no image stamps it: an image change clears nothing)", role)
	return stateMountArgs(role, kb.key()), true
}

func (x *planExec) resolveStoreStamps(flowCtx) bool {
	x.c("resolve persistent-store stamps before any container runs: a database mismatch refuses; a projection mismatch clears the store's contents (the dir itself is kept, so attached shares survive)")
	return true
}

func (x *planExec) val(_, plan string) string { return plan }
func (x *planExec) rtName() string            { return x.rt }
func (x *planExec) dim(s string) string       { return s }
func (x *planExec) exposure(addr string) exposure {
	return exposure{rt: x.rt, addr: addr, lan: x.lan}
}

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
	conn, err := dialTCP(rp.Address, rp.Port, 3*time.Second)
	if err != nil {
		u.Fail("%s is externally provided at %s but unreachable: %v", role, addr, err)
		return false
	}
	conn.Close()
	u.Ok("%s — externally provided at %s %s", role, addr, u.Dim("(reachable)"))
	return true
}
