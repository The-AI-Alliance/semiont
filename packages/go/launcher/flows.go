package launcher

// flows.go — each launch sequence written ONCE, walked by an executor in
// live or plan mode. Effects (argv,
// ports, URLs, gate tries, record contents) exist only here: start cannot
// change what it does without --dry-run showing the same change. Decoration
// (say vs note) is deliberately one-sided per mode.

import (
	"fmt"
	"net"
	"slices"
	"strconv"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

type flowCtx struct {
	plan *launchPlan
	// stack: the knowledge base's documents the plan was derived from; nil
	// for a start that reads none (`--service browser`).
	stack   *stack.Stack
	opts    startOptions
	kb      kbRoot
	userEnv []string
	// restart: this is `start --service <role>`, not a full start. The flows
	// are the SAME flows either way — it changes only what the banner says,
	// which is the whole of what a single-service start does differently.
	restart bool
	// browser: the Browser's document, for the starts that read it
	// (startReadsBrowserDocument): what the Browser runs, and the port the
	// realm allows its sign-in from.
	browser browserDocument
}

// withDaemonCredentials adds the kept passwords of the daemons this plan runs
// to the start's resolved variables: the daemon starts with its own
// (daemonLaunchEnv), and each service is handed the ones its document names
// (envFor). Loaded once, before anything is torn down or started,
// so a store the launcher holds no password for refuses first.
func withDaemonCredentials(x executor, fc flowCtx) (flowCtx, bool) {
	if fc.plan == nil {
		return fc, true
	}
	env := append([]string{}, fc.userEnv...)
	for _, role := range []string{"graph", "database", "messaging"} {
		if fc.plan.Roles[role].Presence != presenceLauncher {
			continue
		}
		pw, ok := x.daemonPassword(fc.kb, role)
		if !ok {
			return fc, false
		}
		if role == "messaging" {
			env = append(env, "--env", "NATS_USER="+brokerUser)
		}
		env = append(env, "--env", daemonPasswords[role].env+"="+pw)
	}
	fc.userEnv = env
	return fc, true
}

// userEnvVars: the NAME=value pairs of a start's resolved --env list.
func userEnvVars(userEnv []string) map[string]string {
	vars := map[string]string{}
	for i := 0; i+1 < len(userEnv); i += 2 {
		if userEnv[i] == "--env" {
			if name, value, ok := strings.Cut(userEnv[i+1], "="); ok {
				vars[name] = value
			}
		}
	}
	return vars
}

// daemonLaunchEnv: the credential a launcher-run daemon starts with, in the
// form that daemon reads — its kept password, or, for Keycloak, PostgreSQL's:
// kept when the launcher runs that PostgreSQL, read from the variable the
// Issuer document names when it does not.
func daemonLaunchEnv(fc flowCtx, role string, rp rolePlan) ([]string, error) {
	kept := func(role string) string {
		return userEnvVars(fc.userEnv)[daemonPasswords[role].env]
	}
	switch role {
	case "graph":
		return []string{"NEO4J_AUTH=" + rp.User + "/" + kept("graph")}, nil
	case "database":
		return []string{"POSTGRES_PASSWORD=" + kept("database")}, nil
	case "messaging":
		return []string{"NATS_USER=" + natsConfString(brokerUser), "NATS_PASSWORD=" + natsConfString(kept("messaging"))}, nil
	case "identity":
		if rp.ExternalDBPassword == "" {
			return []string{"KC_DB_PASSWORD=" + kept("database")}, nil
		}
		pw, err := userEnvValue("spec.database.external.password", rp.ExternalDBPassword, fc.userEnv)
		if err != nil {
			return nil, err
		}
		return []string{"KC_DB_PASSWORD=" + pw}, nil
	}
	return nil, nil
}

// envFor: the user variables svc is handed — the --env pairs of userEnv whose
// names its configuration document names (launchPlan.ServiceVars). userEnv
// itself keeps every resolved value: the launcher's own reads (the gateway's
// document, the remote-model check) need them.
func (fc flowCtx) envFor(svc string) []string {
	var out []string
	for i := 0; i+1 < len(fc.userEnv); i += 2 {
		name, _, _ := strings.Cut(fc.userEnv[i+1], "=")
		if contains(fc.plan.ServiceVars[svc], name) {
			out = append(out, fc.userEnv[i], fc.userEnv[i+1])
		}
	}
	return out
}

// roleBanner and startBanner: the heading a role's flow prints, in the voice
// of the verb that reached it. Every flow announces itself — that is what
// makes a flow callable from both walks.
func roleBanner(fc flowCtx, title string) string {
	if fc.restart {
		return "Restarting " + title
	}
	return title
}

func startBanner(fc flowCtx, noun string) string {
	if fc.restart {
		return "Restarting " + noun
	}
	return "Starting " + noun
}

var depRoleTitles = map[string]string{
	"graph": "Graph", "vectors": "Vectors", "database": "Database",
	"embedding": "Embedding", "messaging": "Messaging", "identity": "Identity",
}

// flowFullStart is THE full-start sequence: preflight → ports → staging →
// pulls → the machine's traces and metrics (--observe) → its collector → database → messaging →
// identity → gateway → graph → vectors → inference → embedding → archivist →
// librarian → dispatcher → sidecars → Browser.
//
// embedding follows inference deliberately: an ollama-typed embedding is
// served BY the Ollama inference just brought up, so probing it any earlier
// would dial a port nothing is listening on yet.
func flowFullStart(x executor, fc flowCtx) int {
	addr, ok := x.resolveAddr()
	if !ok {
		return 1
	}
	if fc, ok = withDaemonCredentials(x, fc); !ok {
		return 1
	}
	x.say(sayLog, "Host address: %s", x.dim(addr))

	// Before anything is torn down: a start whose images do not verify leaves
	// the running stack as it was.
	x.banner("Verifying Images")
	var services []string
	for _, svc := range stackServices {
		if fc.plan.runs(svc) {
			services = append(services, svc)
		}
	}
	// The worker's is verified with them, and pulled by its own flow, only as
	// it restarts.
	verified := services
	if fc.plan.workerRuns() {
		verified = append(slices.Clone(services), "worker")
	}
	if !verifyStackImages(x, fc, verified) {
		return 1
	}

	x.banner("Preflight")
	// Crash evidence first: the runtime's log capture is the only copy of the
	// prior stack's story, and the stop+rm below deletes it.
	//
	// The sweep is this knowledge base's stack alone: another's runs under
	// names of its own. The machine's containers are not in it — the
	// telemetry, the worker, the machine's Ollama and the Browser serve every
	// KB here, and each is kept or replaced from its own record by its own
	// flow (flowMachine, flowOllama, flowBrowser).
	prior := stackContainers(fc.kb.key())
	x.snapshotLogs(fc.kb, prior)
	x.say(sayLog, "Removing prior containers %s", x.dim(fmt.Sprintf("(stop+rm, %d names; exact commands: semiont start --dry-run)", len(prior))))
	removed := 0
	for _, c := range prior {
		if x.stopRm(c) {
			removed++
		}
	}
	swept := x.sweepStray(prior)
	// A prior `network lan` start's issuer proxy holds the issuer's port at
	// the network address, whatever this start's setting.
	x.retireIssuerProxy()
	x.sweepStaging()
	// The settle is for the runtime to release what we just tore down. With
	// nothing removed there is nothing to settle.
	// The ports this start is about to claim — computed once and used twice:
	// waited on here because the sweep may have just released any of them,
	// then verified free below. Deriving the wait from a second, hand-rolled
	// list is how the two drift: one that misses the gateway, the sidecars or
	// Neo4j's aux port (exactly what a torn-down stack still holds), or
	// includes ports for roles bound to a REMOTE service, which this start
	// never binds.
	checks := planPortChecks(fc.plan, x.exposure(addr))
	if removed > 0 || swept {
		x.settle(portNumbers(checks)...)
	}
	if removed == 0 {
		x.say(sayOK, "No prior containers")
	} else {
		x.say(sayOK, "Removed %d prior container(s)", removed)
	}

	if !x.portChecks(checks) {
		return 1
	}
	x.say(sayOK, "Required ports are free")

	stage, ok := x.stageAll(fc, addr)
	if !ok {
		return 1
	}
	x.initStack(fc.kb, fc.opts.configName, addr, stage)
	x.recordPorts(checks)

	// Store stamps resolve HERE, before the first container run, so no clear
	// lands on a directory a container has already attached.
	if !x.resolveStoreStamps(fc) {
		return 1
	}

	x.banner("Pulling Images")
	pulled := false
	for _, svc := range services {
		if locallyBuilt(fc.plan.Images[svc]) {
			continue
		}
		if !x.pull(fc.plan.Images[svc]) {
			return 1
		}
		pulled = true
	}
	if pulled {
		x.say(sayOK, "Images pulled")
	}

	// --no-observe skips the backends, Jaeger and Prometheus, and leaves
	// running ones alone: they are the machine's.
	if fc.opts.observe {
		if code := flowTraces(x, fc, addr); code != 0 {
			return code
		}
		if code := flowMetrics(x, fc, addr); code != 0 {
			return code
		}
	}

	// The collector always runs. After Jaeger, so a first trace export has
	// somewhere to land.
	if code := flowCollector(x, fc, addr); code != 0 {
		return code
	}
	otel := otelArgs(addr)

	// Database, messaging and identity — everything the Gateway itself needs —
	// AHEAD of the stores the actors use. The gateway dials no graph, vector or
	// embedding client, and no database of its own: the PostgreSQL started here
	// is Keycloak's, whose realm lives in it. What the gateway does wait for is
	// the broker its signal plane dials (when [signal] selects nats) and the
	// issuer whose keys it verifies tokens against, both below. It has the most
	// ways to fail, so it precedes the stores.
	// Invariant: everything below needs the Gateway; nothing above it does.
	if code := flowDepRole(x, "database", fc, addr); code != 0 {
		return code
	}
	// The broker (NATS: the dispatcher's JetStream queue, and the nats signal
	// driver when [signal] selects it) precedes the gateway for the signal
	// plane's sake; the dispatcher dials the same server later.
	if code := flowDepRole(x, "messaging", fc, addr); code != 0 {
		return code
	}
	// The identity provider (Keycloak, when the stack has an Issuer document) is a
	// gateway dependency too: the gateway verifies human tokens against its
	// keys. After the database, whose PostgreSQL holds its realm.
	if code := flowDepRole(x, "identity", fc, addr); code != 0 {
		return code
	}

	if code := flowGateway(x, fc, addr, stage, otel); code != 0 {
		return code
	}

	// The stores the actors dial: each gates the Archivist/Librarian/sidecars
	// below; none gates the Gateway above.
	if code := flowDepRole(x, "graph", fc, addr); code != 0 {
		return code
	}
	if code := flowDepRole(x, "vectors", fc, addr); code != 0 {
		return code
	}
	if code := flowInferenceRole(x, fc, addr); code != 0 {
		return code
	}
	if code := flowDepRole(x, "embedding", fc, addr); code != 0 {
		return code
	}

	// The Archivist boots BEFORE the sidecars: as the owner of the record it
	// answers their boot-time bus requests (the smelter's reconcile opens
	// with browse:resources), and its /health only turns on after its bus
	// pumps attach — so gating here closes the startup race.
	if code := flowArchivist(x, fc, addr, stage, otel); code != 0 {
		return code
	}

	if code := flowLibrarian(x, fc, addr, stage, otel); code != 0 {
		return code
	}

	if code := flowDispatcher(x, fc, addr, stage, otel); code != 0 {
		return code
	}

	// The machine's worker, from its list as this start leaves it: after the
	// dispatcher, whose queue it claims from.
	if code := flowWorker(x, fc, addr, otel); code != 0 {
		return code
	}

	// The weaver note: the graph projection is standalone-only — without the
	// weaver the graph stays empty and every gather 404s at the
	// buildKnowledgeGraph barrier.
	for _, sc := range sidecarSpecs {
		if code := flowSidecar(x, fc, sc, addr, stage, otel); code != 0 {
			return code
		}
	}

	// The Browser rides every start but belongs to no stack.
	return flowBrowser(x, addr, fc.browser, false)
}

// flowBrowser: the Browser is a MACHINE-LEVEL viewer, not a stack member,
// and runs what its document says. Any start ensures it; none churns it: a
// running Browser is kept when it runs the image this start would (image
// identity, not tag order — tags like :latest and :local are mutable) and its
// record says it was started with the port and memory its document names. It
// is restarted otherwise, and when the restart is explicit
// (--service browser).
func flowBrowser(x executor, addr string, doc browserDocument, forceRestart bool) int {
	// forceRestart IS the single-service case (`--service browser`), so it is
	// also what the heading should say.
	if forceRestart {
		x.banner("Restarting Browser")
	} else {
		x.banner("Browser")
	}
	// Verified first, so a running Browser is kept only when it runs the very
	// digest a release built, and a moved tag restarts it.
	desired := doc.spec.Image
	if locallyBuilt(desired) {
		warnUnverified(x, []string{desired})
	} else {
		pinned, ok := x.verifyImage("browser", desired)
		if !ok {
			return 1
		}
		desired = pinned
	}
	x.note("browser: keep if running with image identity matching %s, recorded at %s with %s; else stop/rm + pull + run",
		desired, doc.endpoint(), doc.spec.Resources.Limits.Memory)
	x.note("(the Browser is not a stack member: semiont stop --service browser stops it alone)")
	return x.either(func() bool {
		return !forceRestart && recordedAs(x.machineRecord(machineContainer("browser")), doc) && x.containerCurrent(machineContainer("browser"), desired)
	},
		func() int {
			x.say(sayOK, "Browser already running on %s %s", doc.endpoint(),
				x.dim("(as its document says — left alone; semiont stop --service browser stops it)"))
			return 0
		},
		func() int {
			// stop+rm, not stop: without --rm (kept for crash forensics) a
			// stopped container HOLDS its name — the next run --name fails
			// with "already exists" on every runtime (the same reason
			// stop.go always rm's).
			x.stopRm(machineContainer("browser"))
			e := x.exposure(addr)
			browser := portNeed{doc.spec.Port, "Browser"}
			needs := append([]portNeed{browser}, e.containersSideNeed("browser", browser, semiontDescriptor("browser").defaultPort)...)
			x.settle(portNumbers(needs)...)
			for _, need := range needs {
				if !x.portCheck(need) {
					return 1
				}
			}
			if !locallyBuilt(desired) && !x.pull(desired) {
				return 1
			}
			args := browserArgs(e, doc, desired)
			id, ok := x.runDetached(args)
			if !ok {
				x.say(sayFail, "Browser failed to start.")
				return 1
			}
			d, ok := x.waitHTTP("Browser", machineContainer("browser"), doc.endpoint(), 30)
			if !ok {
				x.dumpLogs(machineContainer("browser"), "browser")
				return 1
			}
			x.say(sayOK, "Browser on %s %s", doc.endpoint(), x.dim("("+took(d)+")"))
			x.recordMachine(ServiceState{Container: machineContainer("browser"), ID: id, Image: desired,
				Endpoint: doc.endpoint(), Memory: doc.spec.Resources.Limits.Memory, Ports: portNumbers(needs)})
			return 0
		})
}

// recordedAs: whether the Browser's record says it was started on the port,
// and with the memory, its document names. No record says nothing, so a
// Browser running without one is restarted into one.
func recordedAs(rec *ServiceState, doc browserDocument) bool {
	return rec != nil && rec.Endpoint == doc.endpoint() && rec.Memory == doc.spec.Resources.Limits.Memory
}

// machineRun: one of the containers the launcher runs for the machine — the
// telemetry's and the worker — as this start would run it.
type machineRun struct {
	role, driver string
	ready        string // what is said once it answers
	// image: what it runs. memory: the ceiling it runs with, kept in its
	// record; none for the telemetry, which runs with no ceiling of ours.
	image, memory string
	// pull: pulled as it (re)starts, as a Semiont image is, so it runs what
	// was verified.
	pull bool
	// file and config: the launcher's own config for it, written to file
	// only as it (re)starts; no file for one that reads none.
	file, config string
	args         func(e exposure, configPath string) []string
	// notThisKB: it runs for the machine, and this start's knowledge base is
	// not among what it serves, so the stack's record of the role is not its.
	notThisKB bool
}

// flowMachine: a container the launcher runs for the machine rather than for
// one stack (each record is the machine's, in StackSet.Machine): the
// telemetry — one collector takes every KB's signals, each labelled with the
// KB that sent it, with Jaeger and Prometheus behind it — and the worker,
// which serves every KB on its list. A start keeps a running one when its
// record says it runs under this start's runtime, answers where this start
// would probe it and has the memory this start would give it, its config file
// says what this start would write, and it runs the image this start would;
// `start --service` restarts it. Otherwise it is stopped wherever its record
// says it runs, and run afresh. Its caller says what it is (banner).
func flowMachine(x executor, fc flowCtx, m machineRun, addr string) int {
	d := descriptorFor(m.role, m.driver)
	name := machineContainer(m.role)
	rec := x.machineRecord(name)
	e := x.exposure(addr)
	health := healthEndpoint(m.role, m.driver, fc.plan, e)
	memoryClause := ""
	if m.memory != "" {
		memoryClause = " with " + m.memory
	}
	configClause := ""
	if m.file != "" {
		configClause = ", its " + m.file + " is what this start writes,"
	}
	x.note("%s: keep %s if its record says %s under %s%s%s and it runs %s; else stop/rm it, then run it",
		m.role, name, health, x.rtName(), memoryClause, configClause, m.image)
	served := func() {
		if !m.notThisKB {
			x.servedByMachine(m.role, name, health, m.driver)
		}
	}
	return x.either(func() bool {
		return !fc.restart && rec != nil && rec.Runtime == x.rtName() && rec.Endpoint == health && rec.Memory == m.memory &&
			(m.file == "" || x.machineConfigCurrent(m.file, m.config)) && x.containerCurrent(name, m.image)
	},
		func() int {
			x.say(sayOK, "%s — %s already running %s", m.role, d.display,
				x.dim("(kept: it serves every KB here; semiont stop --service "+m.role+" stops it)"))
			served()
			return 0
		},
		func() int {
			needs := stackPortNeeds(m.role)
			if x.stopMachine(name, rec) {
				x.settle(portNumbers(needs)...)
			}
			if !x.portChecks(needs) {
				return 1
			}
			if m.pull && !locallyBuilt(m.image) && !x.pull(m.image) {
				return 1
			}
			path := ""
			if m.file != "" {
				var ok bool
				if path, ok = x.writeMachineConfig(m.file, m.config); !ok {
					return 1
				}
			}
			args := m.args(e, path)
			id, ok := x.runDetached(args)
			if !ok {
				x.say(sayFail, "%s (%s) failed to start.", m.role, d.display)
				return 1
			}
			waited, ok := x.waitHTTP(m.role+" ("+d.display+")", name, health, 30)
			if !ok {
				x.dumpLogs(name, m.role)
				return 1
			}
			x.say(sayOK, "%s — %s %s", m.role, m.ready, x.dim("("+took(waited)+")"))
			x.recordMachine(ServiceState{Container: name, ID: id, Image: m.image, Endpoint: health, Memory: m.memory, Ports: portNumbers(needs)})
			served()
			return 0
		})
}

func flowTraces(x executor, fc flowCtx, addr string) int {
	x.banner(roleBanner(fc, "Traces (Jaeger)"))
	return flowMachine(x, fc, machineRun{
		role: "traces", driver: "jaeger", image: descriptorFor("traces", "jaeger").image,
		ready: "Jaeger UI on " + healthEndpoint("traces", "jaeger", fc.plan, x.exposure(addr)),
		args:  func(e exposure, _ string) []string { return tracesArgs(e) },
	}, addr)
}

func flowMetrics(x executor, fc flowCtx, addr string) int {
	x.banner(roleBanner(fc, "Metrics (Prometheus)"))
	return flowMachine(x, fc, machineRun{
		role: "metrics", driver: "prometheus", image: descriptorFor("metrics", "prometheus").image,
		ready: "Prometheus on http://localhost:9090",
		file:  "prometheus.yml", config: prometheusConfig(addr),
		args: prometheusArgs,
	}, addr)
}

// flowCollector: its traces go to Jaeger when Jaeger answers by now — the
// one rule, whether a full start ran Jaeger just before it, --no-observe
// left a running one alone, or `--service collector` finds one.
func flowCollector(x executor, fc flowCtx, addr string) int {
	x.banner(roleBanner(fc, "Telemetry (OTel Collector)"))
	traces := x.tracesUp(healthEndpoint("traces", "jaeger", fc.plan, x.exposure(addr)))
	return flowMachine(x, fc, machineRun{
		role: "collector", driver: "otel", image: descriptorFor("collector", "otel").image,
		ready: fmt.Sprintf("OTLP on %s:4318, metrics on %s", addr, healthEndpoint("collector", "otel", fc.plan, x.exposure(addr))),
		file:  "collector.yaml", config: collectorConfig(addr, traces),
		args: collectorArgs,
	}, addr)
}

// flowWorker: the machine's one worker, which serves every knowledge base on
// its list (workerkbs.go). This start's knowledge base goes on the list when
// one of its jobs has an engine, as this start places it, and off when none
// does; the local ones whose gateway port this start takes are off it already
// (planWorkerServing). An added one offered the engines of a knowledge base
// not on the list goes unserved, and is said. With nothing to serve, the
// worker is stopped. Else it runs as the list and the machine's worker
// document say, kept or restarted as every machine container is
// (flowMachine): so it restarts only when what it serves, or how the
// machine's document runs it, changes.
func flowWorker(x executor, fc flowCtx, addr string, otel []string) int {
	x.banner(roleBanner(fc, "Worker"))
	list := fc.plan.Serving.others
	thisKB := fc.plan.runs("worker")
	if thisKB {
		served, err := fc.kb.served()
		var entry api.WorkerKnowledgeBaseConfig
		if err == nil {
			entry, err = workerEntry(placementOf(fc, x.exposure(addr)), served.Domain)
		}
		if err != nil {
			x.say(sayFail, "Writing the worker's entry for this knowledge base: %v", err)
			return 1
		}
		list.put(entry)
	} else {
		at := jobEnginesAt(fc.plan.Inference)
		x.say(sayLog, "worker — no job has an engine, so it does not serve this knowledge base %s", x.dim("(give one an engine in "+at+")"))
		x.note("worker: no job has an engine — this knowledge base is not on its list (give one an engine in %s)", at)
		x.record("worker", "", "", providedNone, "", "")
	}
	for _, domain := range fc.plan.Serving.displaced {
		x.say(sayWarn, "worker — %s leaves its list: this start's gateway takes the port its gateway was on", domain)
		x.note("worker: %s leaves its list — this start's gateway takes the port its gateway was on", domain)
	}
	entries, unserved := list.served()
	for _, kb := range unserved {
		x.say(sayWarn, "worker — %s goes unserved: it is offered the engines of %s, which is not on its list %s", kb.Domain, kb.EnginesOf, x.dim("(a start of "+kb.EnginesOf+" serves it again)"))
		x.note("worker: %s goes unserved — it is offered the engines of %s, which is not on its list", kb.Domain, kb.EnginesOf)
	}
	if !x.keepWorkerList(list) {
		return 1
	}
	name := machineContainer("worker")
	if len(entries) == 0 {
		x.note("worker: serves no knowledge base — stop/rm %s wherever its record says it runs", name)
		if x.stopMachine(name, x.machineRecord(name)) {
			x.say(sayOK, "worker — serves no knowledge base; stopped")
		}
		x.forgetMachine(name)
		return 0
	}
	doc, err := workerDocument(entries, fc.plan.Worker)
	if err != nil {
		x.say(sayFail, "Writing the worker's configuration document: %v", err)
		return 1
	}
	image := fc.plan.Images["worker"]
	key, ok := x.workerKey()
	if !ok {
		return 1
	}
	memory := fc.plan.Memory["worker"]
	var domains []string
	for _, entry := range entries {
		domains = append(domains, entry.Domain)
	}
	return flowMachine(x, fc, machineRun{
		role: "worker", driver: driverSemiont, image: image, memory: memory, pull: true,
		ready: "serves " + strings.Join(domains, ", "),
		file:  workerDocumentFile, config: string(doc),
		args: func(e exposure, path string) []string {
			return workerArgs(path, e, key.private, image, memory, fc.envFor("worker"), otel)
		},
		notThisKB: !thisKB,
	}, addr)
}

// flowDepRole: the uniform dependency-role shape for database / messaging /
// identity / graph / vectors / embedding, presence-dispatched.
func flowDepRole(x executor, role string, fc flowCtx, addr string) int {
	rp := fc.plan.Roles[role]
	// An embedding that OWNS the local Ollama (all-remote bindings — nothing
	// else runs it) is the same host-process dance inference runs when the
	// bindings are ollama-typed; only the owning role differs.
	if role == "embedding" && rp.Presence == presenceHostPreferred {
		return flowOllama(x, fc, "embedding", rp, addr)
	}
	disp := driverDisplay(role, rp.Driver)
	x.banner(roleBanner(fc, depRoleTitles[role]+" ("+disp+")"))
	switch rp.Presence {
	case presenceLauncher:
		// Persistent state rides the run argv: roles in stateStores mount
		// their per-root dir; a database refusal (data written by another
		// image) stops the start here.
		extra, ok := x.stateMounts(role, rp.Image, fc.kb)
		if !ok {
			return 1
		}
		// An authenticated broker needs its authorization block; the plan already
		// points `-c` at the fixed path, so all that is left is putting the file
		// there. The file holds no secret — the credentials arrive as the
		// daemon's environment, like every other service credential here.
		if role == "messaging" && len(rp.CmdExtra) > 0 {
			conf, ok := x.stageNatsConf(natsConf())
			if !ok {
				return 1
			}
			extra = append(extra, "-v", conf+":"+natsConfPath+":ro")
		}
		var accounts realmAccounts
		var adminPassword string
		if role == "identity" {
			kc, held, password, ok := identityRunExtras(x, fc, addr)
			if !ok {
				return 1
			}
			extra = append(extra, kc...)
			accounts, adminPassword = held, password
		}
		creds, err := daemonLaunchEnv(fc, role, rp)
		if err != nil {
			x.say(sayFail, "%v", err)
			return 1
		}
		rp.Env = append(append([]string{}, rp.Env...), creds...)
		args := providedRunArgs(x.exposure(addr), fc.plan, rp, fc.kb.key(), extra...)
		id, ok := x.runDetached(args)
		if !ok {
			x.say(sayFail, "%s (%s) failed to start.", role, disp)
			return 1
		}
		switch role {
		case "identity":
			// Keycloak answers on the realm only once the import is done —
			// the wait is the realm gate as well as the liveness gate. It asks
			// Keycloak itself, which under `network lan` is behind the proxy.
			e := x.exposure(addr)
			d, ok := x.waitHTTP("identity ("+disp+")", roleContainer("identity", fc.kb.key()), keycloakEndpoint(rp, e), 90)
			if !ok {
				x.dumpLogs(roleContainer("identity", fc.kb.key()), "identity")
				return 1
			}
			if e.behindProxy(role) {
				host, port := e.keycloakAt(rp.Port)
				listen := net.JoinHostPort(e.lan, strconv.Itoa(rp.Port))
				if !x.issuerProxy(listen, net.JoinHostPort(host, strconv.Itoa(port)), keycloakRealm(issuerPath(rp.Issuer))) {
					return 1
				}
				// The issuer where everyone dials it, through the proxy (D5).
				if _, ok := x.waitHTTP("identity (the issuer proxy)", roleContainer("identity", fc.kb.key()), healthEndpoint(role, rp.Driver, fc.plan, e), 15); !ok {
					return 1
				}
			}
			x.say(sayOK, "identity — %s at %s %s", disp, identityEndpoint(rp, e), x.dim("("+took(d)+")"))
			x.openAdminToThisMachine(adminPassword)
			// The realm is up and imported; prove it honours the credentials
			// this start is about to inject, BEFORE the first process that
			// holds one, at the issuer those processes sign in at — see
			// verifyServiceAccounts on why not where the launcher reaches it.
			if !x.preflightIdentity(placementOf(fc, e).issuer(), fc.kb.ident.resource(), accounts, rp.AccessTokenLifespan, fc.browser.spec.Port, true) {
				return 1
			}
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan, x.exposure(addr)), rp.Driver)
		case "graph":
			aux := fc.plan.AuxPorts("graph")[0].port
			d, ok := x.waitHTTP("graph ("+disp+")", roleContainer("graph", fc.kb.key()), healthEndpoint(role, rp.Driver, fc.plan, x.exposure(addr)), 30)
			if !ok {
				x.dumpLogs(roleContainer("graph", fc.kb.key()), "graph")
				return 1
			}
			x.say(sayOK, "graph — bolt://localhost:%d (browser: http://localhost:%d) %s", rp.Port, aux, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan, x.exposure(addr)), rp.Driver)
		case "vectors":
			d, ok := x.waitHTTP("vectors ("+disp+")", roleContainer("vectors", fc.kb.key()), healthEndpoint(role, rp.Driver, fc.plan, x.exposure(addr)), 15)
			if !ok {
				x.dumpLogs(roleContainer("vectors", fc.kb.key()), "vectors")
				return 1
			}
			x.say(sayOK, "vectors — http://localhost:%d %s", rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan, x.exposure(addr)), rp.Driver)
		case "database":
			d, ok := x.waitTCP("PostgreSQL", x.exposure(addr).probeHost(role, descriptorFor(role, rp.Driver).defaultPort), addr, rp.Port, 20)
			if !ok {
				x.dumpLogs(roleContainer("database", fc.kb.key()), "database")
				return 1
			}
			// The port is the runtime's; sessions are the server's.
			if !x.waitPGAccepting(30) {
				x.dumpLogs(roleContainer("database", fc.kb.key()), "database")
				return 1
			}
			x.say(sayOK, "database — %s on port %d %s", disp, rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan, x.exposure(addr)), rp.Driver)
		case "messaging":
			// Same two-phase wait as Postgres: TCP up, then reachable on
			// the container path the gateway will dial.
			d, ok := x.waitTCP("NATS", x.exposure(addr).probeHost(role, descriptorFor(role, rp.Driver).defaultPort), addr, rp.Port, 15)
			if !ok {
				x.dumpLogs(roleContainer("messaging", fc.kb.key()), "messaging")
				return 1
			}
			x.say(sayOK, "messaging — %s on port %d %s", disp, rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan, x.exposure(addr)), rp.Driver)
		}
	case presenceAbsent:
		x.say(sayLog, "%s — not configured; skipping", role)
		x.note("%s: not referenced by the config — nothing to launch", role)
		x.record(role, "", "", providedNone, "", "")
	case presenceHostPreferred:
		x.note("%s: host process at localhost:%d — verify reachability, launch nothing", role, rp.Port)
		if !x.probeTCP(role, rp) {
			return 1
		}
		x.record(role, "", "", providedExternal, externalEndpoint(role, rp), rp.Driver)
	case presenceExternal:
		x.note("%s: externally provided at %s:%d — verify reachability, launch nothing", role, rp.Address, rp.Port)
		if !x.probeTCP(role, rp) {
			return 1
		}
		// An issuer someone ELSE runs gets the same preflight as one the
		// launcher starts, and needs it more: a launcher-run realm is imported
		// from the launcher's own document and is correct by construction,
		// while an external one had its clients created by hand. Reachability
		// alone says nothing about whether the six service accounts grant a
		// usable token, or whether anybody can sign in.
		if role == "identity" {
			accounts, ok := realmAccountsOf(x, fc.kb)
			if !ok {
				return 1
			}
			if !x.preflightIdentity(placementOf(fc, x.exposure(addr)).issuer(), fc.kb.ident.resource(), accounts, 0, fc.browser.spec.Port, false) {
				return 1
			}
		}
		// A role sharing another's Ollama reports how that Ollama is
		// provided, not a flat "external" — same process, same answer.
		switch shared := x.recorded(rp.SharesOllamaWith); shared.Provided {
		case "":
			x.record(role, "", "", providedExternal, externalEndpoint(role, rp), rp.Driver)
		case providedMachine:
			x.servedByMachine(role, shared.Container, externalEndpoint(role, rp), rp.Driver)
		default:
			x.record(role, "", "", shared.Provided, externalEndpoint(role, rp), rp.Driver)
		}
	}
	return 0
}

// saasBase reconstructs the https origin from a SaaS provider's address
// (remoteProviderAddress). Port 443 is the real world; any other port is a
// test or proxy endpoint, spoken plainly.
func saasBase(host string, port int) string {
	if port == 443 {
		return "https://" + host
	}
	return fmt.Sprintf("http://%s:%d", host, port)
}

// envValue digs VAR=value out of the resolved user env.
func envValue(env []string, name string) string {
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, name+"="); ok {
			return v
		}
	}
	return ""
}

// externalEndpoint: the status probe for a role somebody else runs. The
// PATH is the driver's and comes from the descriptor; what stays here is the
// policy about the remote SERVICE — a SaaS API answers nothing a
// credential-free probe may read, so reachability is all this can honestly
// assert, and that is a TCP dial.
func externalEndpoint(role string, rp rolePlan) string {
	dial := fmt.Sprintf("tcp:%s:%d", rp.Address, rp.Port)
	probe := fmt.Sprintf("http://%s:%d%s", rp.Address, rp.Port, descriptorFor(role, rp.Driver).health.path)
	switch role {
	case "embedding", "inference":
		// Only an Ollama answers Ollama's version endpoint; Voyage and
		// Anthropic are HTTPS SaaS whose APIs need a key.
		if rp.Driver == "ollama" {
			return probe
		}
		return dial
	case "vectors":
		return probe
	default: // graph, database, identity: not an unauthenticated HTTP route
		return dial
	}
}

// flowInferenceRole: presence dispatch for inference (the host-process
// dance lives in flowOllama).
func flowInferenceRole(x executor, fc flowCtx, addr string) int {
	rp := fc.plan.Roles["inference"]
	switch rp.Presence {
	case presenceHostPreferred:
		return flowOllama(x, fc, "inference", rp, addr)
	case presenceExternal:
		x.banner("Inference (" + driverDisplay("inference", rp.Driver) + ")")
		if rp.Driver != "ollama" {
			// Remote SaaS (Anthropic): nothing to launch, and a start-time
			// TCP dial proves nothing a job won't discover — the API key is
			// the real gate. Recorded so status carries the honest row.
			x.say(sayLog, "inference — %s is remote SaaS; nothing to launch", driverDisplay("inference", rp.Driver))
			x.note("inference: remote SaaS (%s) at %s:%d — nothing to launch or probe", rp.Driver, rp.Address, rp.Port)
			x.record("inference", "", "", providedExternal, externalEndpoint("inference", rp), rp.Driver)
			// One free GET while the key is in hand: /v1/models metadata,
			// and — the actionable part — whether each configured model is
			// LISTED for this key. anthropic only; other SaaS providers can
			// join when their driver knows a models endpoint.
			if rp.Driver == "anthropic" {
				key := ""
				if rp.APIKey != "" {
					var err error
					if key, err = userEnvValue(fc.plan.Inference+" spec.providers.anthropic.apiKey", rp.APIKey, fc.userEnv); err != nil {
						x.say(sayFail, "%v", err)
						return 1
					}
				}
				x.verifyRemoteModels("inference", saasBase(rp.Address, rp.Port), key, servedBy(rp.Models, "anthropic"))
			}
			return 0
		}
		x.note("inference: externally provided at %s:%d — verify reachability, launch nothing", rp.Address, rp.Port)
		if !x.probeTCP("inference", rp) {
			return 1
		}
		x.record("inference", "", "", providedExternal, externalEndpoint("inference", rp), rp.Driver)
	case presenceAbsent:
		x.banner("Inference")
		x.say(sayLog, "inference — not referenced by the config; skipping")
		x.note("inference: not referenced by the config — nothing to launch")
		x.record("inference", "", "", providedNone, "", "")
	}
	return 0
}

// flowOllama: the machine's Ollama, which runs outside every stack (its
// record is the machine's, in StackSet.Machine) and serves every KB whose engines
// name Ollama. A start keeps the running one when its record says it is
// published where this start would publish it, under this start's runtime,
// with the model cache --ollama-cache asks for (any, when it asks none), and
// it runs the image this start would. `start --service` restarts it, as
// `--service browser` restarts the Browser. Otherwise: host-Ollama reuse when
// serving and reachable from containers; else the semiont-ollama container
// with the model-cache choice. role names the role this stack records it
// under — "inference" when the engines run through Ollama, "embedding" when
// Ollama exists solely to serve embeddings (all-remote engines).
func flowOllama(x executor, fc flowCtx, role string, rp rolePlan, addr string) int {
	title := "Inference"
	if role != "inference" {
		title = depRoleTitles[role]
	}
	x.banner(roleBanner(fc, title+" ("+driverDisplay(role, rp.Driver)+")"))
	rec := x.machineRecord(machineContainer("inference"))
	health := healthEndpoint(role, rp.Driver, fc.plan, x.exposure(addr))
	base := fmt.Sprintf("http://%s:%d", x.exposure(addr).probeHost(role, rp.Port), rp.Port)
	asked := ollamaCacheAsked(fc.opts.ollamaCache)
	x.note("ollama: keep the machine's Ollama if its record says %s under %s%s and it runs %s; else stop/rm it, then reuse a host Ollama or run the container",
		base, x.rtName(), cacheClause(asked), rp.Image)
	return x.either(func() bool {
		return !fc.restart && ollamaRecordedAs(rec, x.rtName(), base, asked) && x.containerCurrent(machineContainer("inference"), rp.Image)
	},
		func() int {
			x.say(sayOK, "%s — the machine's Ollama already running on %s %s", role, base,
				x.dim("(kept: it serves every KB here; semiont stop --service "+role+" stops it)"))
			x.servedByMachine(role, machineContainer("inference"), health, rp.Driver)
			x.ensureModels(base, fc.plan.OllamaModels)
			return 0
		},
		func() int {
			// The machine's own container goes BEFORE the probe: a
			// semiont-ollama left running publishes the same port and answers
			// the same /api/version, so probing first would take it for a
			// host install. It goes wherever it runs — its record may name
			// another runtime — and with no record, by name under this one.
			if x.stopMachine(machineContainer("inference"), rec) {
				x.settle(rp.Port)
			}
			x.note("probe: host Ollama at http://localhost:%d/api/version", rp.Port)
			x.note(`if present — probe: %s run --rm %s sh -c "wget -q -O- http://%s:%d/api/version" — and use it`, x.rtName(), probeImage, addr, rp.Port)
			return x.either(probeHostOllama(rp.Port),
				func() int {
					if !x.hostOllamaReachable(addr, rp.Port) {
						return 1
					}
					x.say(sayOK, "%s — using host Ollama at http://localhost:%d", role, rp.Port)
					x.forgetMachine(machineContainer("inference"))
					x.record(role, "", "", providedHost, healthEndpoint(role, rp.Driver, fc.plan, exposure{}), rp.Driver)
					x.ensureModels(fmt.Sprintf("http://localhost:%d", rp.Port), fc.plan.OllamaModels)
					return 0
				},
				func() int {
					x.say(sayLog, "No host Ollama detected — starting container...")
					need := portNeed{rp.Port, "Ollama"}
					if !x.portCheck(need) {
						return 1
					}
					volume := x.ollamaVolume(fc.opts)
					// The container is semiont-ollama whichever role this
					// stack records it under — the process is the same.
					args := ollamaRunArgs(x.exposure(addr), rp, "-v", volume+":/root/.ollama")
					id, ok := x.runDetached(args)
					if !ok {
						x.say(sayFail, "Ollama container failed to start.")
						return 1
					}
					d, ok := x.waitHTTP(role+" (Ollama)", machineContainer("inference"), health, 30)
					if !ok {
						x.dumpLogs(machineContainer("inference"), role)
						return 1
					}
					x.say(sayOK, "%s — Ollama container on %s (24 GB memory) %s", role, base, x.dim("("+took(d)+")"))
					x.recordMachine(ServiceState{Container: machineContainer("inference"), ID: id, Image: rp.Image,
						Endpoint: base, Cache: volume, Ports: portNumbers([]portNeed{need})})
					x.servedByMachine(role, machineContainer("inference"), health, rp.Driver)
					x.ensureModels(base, fc.plan.OllamaModels)
					return 0
				})
		})
}

// ollamaRecordedAs: whether the machine's Ollama record says it was started
// where this start would publish it (base), under its runtime rt, and on the
// model cache asked for, when one is. No record says nothing, so an Ollama
// running without one is restarted into one.
func ollamaRecordedAs(rec *ServiceState, rt, base, asked string) bool {
	return rec != nil && rec.Runtime == rt && rec.Endpoint == base && (asked == "" || rec.Cache == asked)
}

// cacheClause: the plan note's words for the cache a start asks for.
func cacheClause(asked string) string {
	if asked == "" {
		return ""
	}
	return " on the model cache " + asked
}

// flowGateway: run + host-side health gate + container-gateway reachability
// gate (the sidecars dial addr:port and fatally exit if their first gateway
// fetch fails — host health alone doesn't prove the path they need).
func flowGateway(x executor, fc flowCtx, addr, stage string, otel []string) int {
	port := fc.plan.GatewayPort
	x.banner(startBanner(fc, "Gateway"))
	x.say(sayLog, "http://localhost:%d", port)
	jwt, ok := x.jwtSecret(fc.kb)
	if !ok {
		return 1
	}
	// The gateway's one state mount is its own store, for its supervisor's
	// events log (gatewayArgs). No image stamps it. It mounts neither the
	// Archivist's state tree nor the anchored-text store: no store is mounted
	// by two containers.
	extra, ok := x.stateMountsUnstamped("gateway", fc.kb)
	if !ok {
		return 1
	}
	gatewayClientSecret, ok := x.serviceClientSecret(fc.kb, "gateway")
	if !ok {
		return 1
	}
	bArgs := gatewayArgs(fc.kb.key(), stage, x.exposure(addr), gatewayClientSecret, jwt, fc.plan.Images["gateway"], fc.plan.Memory["gateway"], port, fc.envFor("gateway"), otel, extra...)
	id, ok := x.runDetached(bArgs)
	if !ok {
		x.say(sayFail, "Gateway failed to start.")
		return 1
	}
	x.say(sayLog, "Waiting for gateway health...")
	d, ok := x.waitHTTP("Gateway", roleContainer("gateway", fc.kb.key()), healthEndpoint("gateway", driverSemiont, fc.plan, x.exposure(addr)), 120)
	if !ok {
		x.dumpLogs(roleContainer("gateway", fc.kb.key()), "gateway")
		return 1
	}
	x.say(sayOK, "Gateway healthy %s", x.dim("("+took(d)+")"))
	if !x.gatewayReachable(addr, x.exposure(addr).containersPort("gateway", port, port)) {
		return 1
	}
	x.record("gateway", id, fc.plan.Images["gateway"], providedLauncher, healthEndpoint("gateway", driverSemiont, fc.plan, x.exposure(addr)), driverSemiont)
	return 0
}

func flowSidecar(x executor, fc flowCtx, sc sidecarSpec, addr, stage string, otel []string) int {
	spec := semiontDescriptor(sc.svc)
	x.banner(startBanner(fc, sc.noun))
	// No sidecar mounts a store: the Smelter keeps its anchored text on the
	// Archivist's surface, and the Weaver keeps nothing. Each reads its own
	// configuration document, staged for it, and proves itself with the
	// root's secret for it.
	var args []string
	switch sc.svc {
	case "smelter":
		clientSecret, ok := x.serviceClientSecret(fc.kb, sc.svc)
		if !ok {
			return 1
		}
		args = smelterArgs(fc.kb.key(), stage, x.exposure(addr), fc.plan.servicePort(sc.svc), clientSecret, fc.plan.Images[sc.svc], fc.plan.Memory[sc.svc], fc.envFor(sc.svc), otel)
	case "weaver":
		clientSecret, ok := x.serviceClientSecret(fc.kb, sc.svc)
		if !ok {
			return 1
		}
		args = weaverArgs(fc.kb.key(), stage, x.exposure(addr), fc.plan.servicePort(sc.svc), clientSecret, fc.plan.Images[sc.svc], fc.plan.Memory[sc.svc], fc.envFor(sc.svc), otel)
	}
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "%s failed to start.", sc.label)
		return 1
	}
	d, ok := x.waitHTTP(sc.label, spec.containerName(fc.kb.key()), healthEndpoint(sc.svc, driverSemiont, fc.plan, x.exposure(addr)), 30)
	if !ok {
		x.dumpLogs(spec.containerName(fc.kb.key()), sc.svc)
		return 1
	}
	x.say(sayOK, "%s healthy (http://%s:%d) %s", sc.label, x.exposure(addr).probeHost(sc.svc, spec.ports[0].port), fc.plan.servicePort(sc.svc), x.dim("("+took(d)+")"))
	x.record(sc.svc, id, fc.plan.Images[sc.svc], providedLauncher, healthEndpoint(sc.svc, driverSemiont, fc.plan, x.exposure(addr)), driverSemiont)
	return 0
}

// flowArchivist: the Archivist starts right after the gateway and BEFORE
// the sidecars — it is the ONLY holder of the record (the gateway
// constructs no actors; this service owns event appends, the projection
// rebuild, and the git index, whose single writer it is), so the sidecars'
// boot-time bus requests are answered here and must find the pumps attached.
func flowArchivist(x executor, fc flowCtx, addr, stage string, otel []string) int {
	x.banner(startBanner(fc, "Archivist"))
	// The anchored-text store is the Archivist's alone and no image stamps
	// it; the state tree it stamps, as the projection writer.
	extra, ok := x.stateMountsUnstamped("anchored-text", fc.kb)
	if !ok {
		return 1
	}
	state, ok := x.stateMounts("state", fc.plan.Images["archivist"], fc.kb)
	if !ok {
		return 1
	}
	extra = append(extra, state...)
	clientSecret, ok := x.serviceClientSecret(fc.kb, "archivist")
	if !ok {
		return 1
	}
	args := archivistArgs(fc.kb.key(), x.val(fc.kb.dir, "<kb-root>"), stage, x.exposure(addr), fc.plan.servicePort("archivist"), clientSecret, fc.plan.Images["archivist"], fc.plan.Memory["archivist"], fc.envFor("archivist"), otel, extra...)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "Archivist failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("Archivist", roleContainer("archivist", fc.kb.key()), healthEndpoint("archivist", driverSemiont, fc.plan, x.exposure(addr)), 30)
	if !ok {
		x.dumpLogs(roleContainer("archivist", fc.kb.key()), "archivist")
		return 1
	}
	x.say(sayOK, "Archivist healthy (http://%s:%d) %s", x.exposure(addr).probeHost("archivist", semiontDescriptor("archivist").ports[0].port), fc.plan.servicePort("archivist"), x.dim("("+took(d)+")"))
	x.record("archivist", id, fc.plan.Images["archivist"], providedLauncher, healthEndpoint("archivist", driverSemiont, fc.plan, x.exposure(addr)), driverSemiont)
	return 0
}

// flowLibrarian: the Librarian (search, match and gather) starts with the
// core services, BEFORE the sidecars: no sidecar boot path is known to ask
// match:*, but health-after-pumps plus this ordering makes the question moot
// rather than racy. It reads everything and writes nothing durable, and reads
// its own configuration document, staged for it — see librarianArgs.
func flowLibrarian(x executor, fc flowCtx, addr, stage string, otel []string) int {
	x.banner(startBanner(fc, "Librarian"))
	// Its own store, for its supervisor's events log; no image stamps it. It
	// reads the views on the bus, not from the Archivist's state tree.
	state, ok := x.stateMountsUnstamped("librarian", fc.kb)
	if !ok {
		return 1
	}
	clientSecret, ok := x.serviceClientSecret(fc.kb, "librarian")
	if !ok {
		return 1
	}
	args := librarianArgs(fc.kb.key(), stage, x.exposure(addr), fc.plan.servicePort("librarian"), clientSecret, fc.plan.Images["librarian"], fc.plan.Memory["librarian"], fc.envFor("librarian"), otel, state...)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "Librarian failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("Librarian", roleContainer("librarian", fc.kb.key()), healthEndpoint("librarian", driverSemiont, fc.plan, x.exposure(addr)), 30)
	if !ok {
		x.dumpLogs(roleContainer("librarian", fc.kb.key()), "librarian")
		return 1
	}
	x.say(sayOK, "Librarian healthy (http://%s:%d) %s", x.exposure(addr).probeHost("librarian", semiontDescriptor("librarian").ports[0].port), fc.plan.servicePort("librarian"), x.dim("("+took(d)+")"))
	x.record("librarian", id, fc.plan.Images["librarian"], providedLauncher, healthEndpoint("librarian", driverSemiont, fc.plan, x.exposure(addr)), driverSemiont)
	return 0
}

// flowDispatcher: the Dispatcher owns the job queue and answers job:* lifecycle
// commands. It mounts nothing but its configuration document
// (dispatcherdoc.go): its entity-type and tag-schema reads are asked of the
// Archivist over the bus, and its queue is JetStream, which holds no state tree
// here. It dials the gateway for its token and the plane; it is a CONTROL PLANE
// and touches no bytes, so it never reads from the Archivist. Started after the
// Librarian — health-after-pumps makes ordering against other sidecars moot
// rather than racy.
func flowDispatcher(x executor, fc flowCtx, addr, stage string, otel []string) int {
	x.banner(startBanner(fc, "Dispatcher"))
	clientSecret, ok := x.serviceClientSecret(fc.kb, "dispatcher")
	if !ok {
		return 1
	}
	args := dispatcherArgs(fc.kb.key(), stage, x.exposure(addr), fc.plan.servicePort("dispatcher"), clientSecret, fc.plan.Images["dispatcher"], fc.plan.Memory["dispatcher"], fc.envFor("dispatcher"), otel)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "Dispatcher failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("Dispatcher", roleContainer("dispatcher", fc.kb.key()), healthEndpoint("dispatcher", driverSemiont, fc.plan, x.exposure(addr)), 30)
	if !ok {
		x.dumpLogs(roleContainer("dispatcher", fc.kb.key()), "dispatcher")
		return 1
	}
	x.say(sayOK, "Dispatcher healthy (http://%s:%d) %s", x.exposure(addr).probeHost("dispatcher", semiontDescriptor("dispatcher").ports[0].port), fc.plan.servicePort("dispatcher"), x.dim("("+took(d)+")"))
	x.record("dispatcher", id, fc.plan.Images["dispatcher"], providedLauncher, healthEndpoint("dispatcher", driverSemiont, fc.plan, x.exposure(addr)), driverSemiont)
	return 0
}

// flowOneService: `start --service` — the no-op presence gate, the
// service's own teardown/ports/pull, secret rejoin + OTel detection + fresh
// staging for config consumers, then the service's launch and gate.
func flowOneService(x executor, fc flowCtx) int {
	fc, ok := withDaemonCredentials(x, fc)
	if !ok {
		return 1
	}
	svc := fc.opts.service
	if rp, nothing := nothingToLaunch(fc.plan, svc); nothing {
		if rp.Presence == presenceExternal {
			x.say(sayWarn, "%s is externally provided per %s (%s:%d); nothing to launch.", svc, roleDocument(fc.stack, svc), rp.Address, rp.Port)
			x.note("%s: externally provided at %s:%d — verify reachability, launch nothing", svc, rp.Address, rp.Port)
			return 0
		}
		x.say(sayWarn, "%s is not referenced by the knowledge base's documents; nothing to launch.", svc)
		x.note("%s: not referenced by the documents — nothing to launch", svc)
		return 0
	}
	// A worker the plan does not run has no image to pull and no job to do.
	if svc == "worker" && !fc.plan.runs("worker") {
		x.say(sayFail, "%v", errNoJobEngine(fc.stack.Files.Inference))
		return 1
	}

	// An image of Semiont's, a stack service's or the worker's, is verified
	// before its container is touched, so a refusal leaves the running one as
	// it was.
	if (isConfigConsumer(svc) || svc == "worker") && !verifyStackImages(x, fc, []string{svc}) {
		return 1
	}

	// The machine's containers are handled entirely by their own flows (their
	// own stop, ports and run) — and their ports must NEVER enter the STACK's
	// recorded claims: stop verifies stack-port release while the machine's
	// containers deliberately keep running on theirs.
	if !contains(machineRoles, svc) {
		ports := servicePortNeeds(svc, fc.plan, fc.browser, x.exposure(""))
		if x.stopRm(roleContainer(svc, fc.kb.key())) {
			x.say(sayLog, "Removed prior %s container", svc)
			x.settle(portNumbers(ports)...)
		}
		// The issuer proxy holds the issuer's port at the network address; it
		// goes with the issuer, before the ports are checked.
		if svc == "identity" {
			x.retireIssuerProxy()
		}
		if !x.portChecks(ports) {
			return 1
		}
		x.recordPorts(ports)
	}

	addr := ""
	if serviceNeedsAddr(svc, x.exposure("")) {
		var ok bool
		if addr, ok = x.resolveAddr(); !ok {
			return 1
		}
		x.say(sayLog, "Host address: %s", x.dim(addr))
	}

	if isConfigConsumer(svc) {
		if img := fc.plan.Images[svc]; !locallyBuilt(img) && !x.pull(img) {
			return 1
		}
	}

	var otel []string
	if isConfigConsumer(svc) {
		otel = x.otelDetect(addr)
	}
	stage := ""
	if isConfigConsumer(svc) {
		var ok bool
		if stage, ok = x.stageOne(svc, fc, addr); !ok {
			return 1
		}
	}

	switch svc {
	case "collector":
		if code := flowCollector(x, fc, addr); code != 0 {
			return code
		}
	case "metrics":
		if code := flowMetrics(x, fc, addr); code != 0 {
			return code
		}
	case "traces":
		if code := flowTraces(x, fc, addr); code != 0 {
			return code
		}
	case "graph", "vectors", "database", "messaging", "identity":
		// The same flow a full start walks — one implementation, so a
		// dependency started alone cannot differ from one started with the
		// stack.
		if code := flowDepRole(x, svc, fc, addr); code != 0 {
			return code
		}
	case "inference":
		if code := flowInferenceRole(x, fc, addr); code != 0 {
			return code
		}
	case "embedding":
		// An external role has nothing to start — the same reason `--service
		// embedding` still verifies and reports: status is the whole of what
		// the launcher can do for it.
		if code := flowDepRole(x, "embedding", fc, addr); code != 0 {
			return code
		}
	case "gateway":
		if code := flowGateway(x, fc, addr, stage, otel); code != 0 {
			return code
		}
	case "archivist":
		if code := flowArchivist(x, fc, addr, stage, otel); code != 0 {
			return code
		}
	case "librarian":
		if code := flowLibrarian(x, fc, addr, stage, otel); code != 0 {
			return code
		}
	case "dispatcher":
		if code := flowDispatcher(x, fc, addr, stage, otel); code != 0 {
			return code
		}
	case "worker":
		if code := flowWorker(x, fc, addr, x.otelDetect(addr)); code != 0 {
			return code
		}
	case "smelter", "weaver":
		for _, sc := range sidecarSpecs {
			if sc.svc == svc {
				if code := flowSidecar(x, fc, sc, addr, stage, otel); code != 0 {
					return code
				}
			}
		}
	case "browser":
		// Explicit --service browser is the one deliberate restart:
		// forceRestart bypasses keep-if-current.
		if code := flowBrowser(x, addr, fc.browser, true); code != 0 {
			return code
		}
	}
	return 0
}

// nothingToLaunch: whether `start --service svc` is a no-op — a dependency the
// documents hand to somebody else, or do not reference. ONE decider for the
// flow's gate and the summary that follows it. Never one of Semiont's own
// services: a worker asked for when no job has an engine is refused before
// anything runs (flowOneService), not passed over.
func nothingToLaunch(plan *launchPlan, svc string) (rolePlan, bool) {
	if plan == nil {
		return rolePlan{}, false
	}
	rp, planned := plan.Roles[svc]
	if !planned || rp.Driver == driverSemiont {
		return rolePlan{}, false
	}
	return rp, rp.Presence == presenceExternal || rp.Presence == presenceAbsent
}

// servicePortNeeds: one service's must-be-free ports. Claims follow the
// plan for config-owned ports (dependency roles, gateway), and the Browser's
// document for its port; the static role table covers only the launcher-fiat
// ports (sidecars, traces), where the plan publishes them. A port a person and
// the containers both dial claims its containers' side too (e).
func servicePortNeeds(svc string, plan *launchPlan, browser browserDocument, e exposure) []portNeed {
	ports := plan.portNeeds(svc)
	switch {
	case svc == "browser":
		need := portNeed{browser.spec.Port, "Browser"}
		ports = append([]portNeed{need}, e.containersSideNeed("browser", need, semiontDescriptor("browser").defaultPort)...)
	case svc == "gateway" && plan != nil:
		gateway := portNeed{plan.GatewayPort, "Gateway"}
		ports = append([]portNeed{gateway}, e.containersSideNeed("gateway", gateway, plan.GatewayPort)...)
	case plan != nil:
		if rp, ok := plan.Roles[svc]; ok && rp.Presence == presenceLauncher && rp.Port != 0 {
			spec := descriptorFor(svc, rp.Driver)
			need := portNeed{rp.Port, spec.portLabel}
			ports = append(append(plan.AuxPorts(svc), need), e.containersSideNeed(svc, need, spec.defaultPort)...)
		}
	}
	return ports
}

// portNumbers strips a port-need list to bare numbers, for settle.
func portNumbers(needs []portNeed) []int {
	out := make([]int, 0, len(needs))
	for _, n := range needs {
		out = append(out, n.port)
	}
	return out
}
