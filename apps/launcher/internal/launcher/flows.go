package launcher

// flows.go — each launch sequence written ONCE, walked by an executor in
// live or plan mode (.plans/LAUNCHER-ROLE-EXECUTOR.md). Effects (argv,
// ports, URLs, gate tries, record contents) exist only here: start cannot
// change what it does without --dry-run showing the same change. Decoration
// (say vs note) is deliberately one-sided per mode.

import (
	"fmt"
	"strings"
)

type flowCtx struct {
	plan       *launchPlan
	opts       startOptions
	version    string
	root       string
	configFile string
	userEnv    []string
	// restart: this is `start --service <role>`, not a full start. The flows
	// are the SAME flows either way — it changes only what the banner says,
	// which is the whole of what a single-service start does differently
	// (LAUNCHER-SERVICE-MODEL P4). It used to change which implementation ran.
	restart bool
}

// roleBanner and startBanner: the heading a role's flow prints, in the voice
// of the verb that reached it. Every flow announces itself — that is what
// makes a flow callable from both walks, and what kept `start --service
// gateway` from losing its banner when the single-service verb stopped
// carrying a blanket one.
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
// pulls → traces (--observe) → collector → database → gateway → graph →
// vectors → inference → embedding → archivist → librarian → sidecars →
// Browser.
//
// embedding follows inference deliberately: an ollama-typed embedding is
// served BY the Ollama inference just brought up, so probing it any earlier
// would dial a port nothing is listening on yet.
func flowFullStart(x executor, fc flowCtx) int {
	addr, ok := x.resolveAddr()
	if !ok {
		return 1
	}
	x.say(sayLog, "Host address: %s", x.dim(addr))

	x.banner("Preflight")
	// Crash evidence first: the runtime's log capture is the only copy of the
	// prior stack's story, and the stop+rm below deletes it.
	x.snapshotLogs(fc.root, preflightNames)
	x.say(sayLog, "Removing prior containers %s", x.dim(fmt.Sprintf("(stop+rm, %d names; exact commands: semiont start --dry-run)", len(preflightNames))))
	removed := 0
	for _, c := range preflightNames {
		if x.stopRm(c) {
			removed++
		}
	}
	swept := x.sweepStray(preflightNames)
	x.sweepStaging()
	// The settle is for the runtime to release what we just tore down. With
	// nothing removed there is nothing to settle, and every first start paid
	// a second for it.
	// The ports this start is about to claim — computed once and used twice:
	// waited on here because the sweep may have just released any of them,
	// then verified free below. Deriving the wait from a second, hand-rolled
	// list is how the two drift: the earlier one missed the gateway, the three
	// sidecars and Neo4j's aux port (exactly what a torn-down stack still
	// holds) while including ports for roles bound to a REMOTE service, which
	// this start never binds.
	checks := planPortChecks(fc.plan, fc.opts.observe)
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

	stage, ok := x.stageAll(fc.configFile, fc.plan.EnvName, addr, fc.opts.observe)
	if !ok {
		return 1
	}
	x.initStack(fc.root, fc.opts.configName, fc.version, addr, stage)
	x.recordPorts(checks)

	// Store stamps resolve HERE, before the first container run: the state
	// store is shared, and a clear at its owner's prep would land after the
	// gateway attached it (SHARED-STORE-CLEAR-PREFLIGHT).
	if !x.resolveStoreStamps(fc) {
		return 1
	}

	x.banner("Pulling Images")
	if fc.version == "local" {
		x.say(sayLog, "Using locally-built %s images (skipping pull)", x.bold(":local"))
		x.note("SEMIONT_VERSION=local — using locally-built :local images (no pull)")
	} else {
		for _, svc := range stackServices {
			if !x.pull(image(svc, fc.version)) {
				return 1
			}
		}
		x.say(sayOK, "Images pulled")
	}

	if fc.opts.observe {
		if code := flowTraces(x, fc); code != 0 {
			return code
		}
		if code := flowMetrics(x, fc, stage); code != 0 {
			return code
		}
	}

	// The collector always runs; --no-observe declines only trace storage
	// (Jaeger, above), and the staged config then routes traces to `nop`.
	// After Jaeger, so a first trace export has somewhere to land.
	if code := flowCollector(x, fc, addr, stage); code != 0 {
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
	// The broker (NATS, when the config selects the nats signal driver or the
	// jetstream jobs driver) precedes the gateway for the signal plane's sake;
	// the dispatcher's JetStream queue dials the same server later. Absent
	// config = the in-process signal plane; nothing runs.
	if code := flowDepRole(x, "messaging", fc, addr); code != 0 {
		return code
	}
	// The identity provider (Keycloak, when [identity] selects it) is a
	// gateway dependency too: the gateway verifies human tokens against its
	// keys. After the database, whose PostgreSQL holds its realm.
	if code := flowDepRole(x, "identity", fc, addr); code != 0 {
		return code
	}

	if !ok {
		return 1
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

	// The Archivist boots BEFORE the sidecars: since the P3 cutover it
	// answers their boot-time bus requests (the smelter's reconcile opens
	// with browse:resources), and its /health only turns on after its bus
	// pumps attach — so gating here closes the startup race a 3.5-second
	// head start once lost a smelter to.
	if code := flowArchivist(x, fc, addr, stage, otel); code != 0 {
		return code
	}

	if code := flowLibrarian(x, fc, addr, stage, otel); code != 0 {
		return code
	}

	if code := flowDispatcher(x, fc, addr, stage, otel); code != 0 {
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
	return flowBrowser(x, fc.version, 3000, false)
}

// flowBrowser: the Browser is a MACHINE-LEVEL viewer, not a stack member
// (BROWSER-LIFECYCLE.md). Any start ensures it; none churns it: a running
// Browser is kept when its image matches what this start would run, and
// restarted when the image is stale (image identity, not tag order — tags
// like :latest and :local are mutable) or when the restart is explicit
// (--service browser, the port mover).
func flowBrowser(x executor, version string, port int, forceRestart bool) int {
	// forceRestart IS the single-service case (`--service browser`, the port
	// mover), so it is also what the heading should say.
	if forceRestart {
		x.banner("Restarting Browser")
	} else {
		x.banner("Browser")
	}
	desired := image("browser", version)
	x.note("browser: keep if running with image identity matching %s; else stop/rm + pull + run", desired)
	x.note("(the Browser is not a stack member: stop leaves it running; semiont stop --service browser stops it)")
	return x.either(func() bool { return !forceRestart && x.browserCurrent(desired) },
		func() int {
			endpoint := "http://localhost:3000"
			if b := x.browserRecord(); b != nil && b.Endpoint != "" {
				endpoint = b.Endpoint
			}
			x.say(sayOK, "Browser already running on %s %s", endpoint,
				x.dim("(current image — left alone; semiont stop --service browser stops it)"))
			return 0
		},
		func() int {
			if port != 3000 {
				// Not a CORS warning: the API is bearer-only with `cors({origin:'*'})`
				// (gateway index.ts, SDK-AUTH-CORS Phase 4), so no gateway rejects this
				// origin. It used to name `frontendURL`, a config key that was read by
				// nothing and has since been deleted (FRONTEND-IS-THE-BROWSER P6).
				// What IS true is that anything holding the default origin literally —
				// an OAuth app registration, a bookmark, a pinned integration — keeps
				// pointing at 3000.
				x.say(sayWarn, "Browser on port %d instead of 3000: anything with http://localhost:3000 baked in (OAuth app registrations, saved links) will not follow it.", port)
			}
			// stop+rm, not stop: without --rm (kept for crash forensics) a
			// stopped container HOLDS its name — the next run --name fails
			// with "already exists" on every runtime (Copilot review, PR
			// #1064; the same reason stop.go always rm's).
			x.stopRm("semiont-browser")
			x.settle(port)
			if !x.portCheck(portNeed{port, "Browser"}) {
				return 1
			}
			if version != "local" && !x.pull(desired) {
				return 1
			}
			args := browserArgs(version, port)
			id, ok := x.runDetached(args)
			if !ok {
				x.say(sayFail, "Browser failed to start.")
				return 1
			}
			d, ok := x.waitHTTP("Browser", fmt.Sprintf("http://localhost:%d", port), 30)
			if !ok {
				x.dumpLogs("semiont-browser", "browser")
				return 1
			}
			x.say(sayOK, "Browser on http://localhost:%d %s", port, x.dim("("+took(d)+")"))
			x.recordBrowser(id, desired, version, port)
			return 0
		})
}

// flowDepRole: the uniform dependency-role shape for graph / vectors /
// database, presence-dispatched.
// flowTraces, flowMetrics, flowCollector: the observability tier's launches,
// written once. `start --service traces` used to reach a second copy of each
// — same argv, separately maintained, and the pair had already drifted on
// which endpoint they recorded.
func flowTraces(x executor, fc flowCtx) int {
	x.banner(roleBanner(fc, "Traces (Jaeger)"))
	args := tracesArgs()
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "traces (Jaeger) failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("traces (Jaeger)", healthEndpoint("traces", "jaeger", fc.plan), 30)
	if !ok {
		x.dumpLogs(roleContainer("traces"), "traces")
		return 1
	}
	x.say(sayOK, "traces — Jaeger UI on %s %s", healthEndpoint("traces", "jaeger", fc.plan), x.dim("("+took(d)+")"))
	x.record("traces", id, args[len(args)-1], providedLauncher, healthEndpoint("traces", "jaeger", fc.plan), "jaeger")
	return 0
}

func flowMetrics(x executor, fc flowCtx, stage string) int {
	x.banner(roleBanner(fc, "Metrics (Prometheus)"))
	args := prometheusArgs(stage)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "metrics (Prometheus) failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("metrics (Prometheus)", healthEndpoint("metrics", "prometheus", fc.plan), 30)
	if !ok {
		x.dumpLogs(roleContainer("metrics"), "metrics")
		return 1
	}
	x.say(sayOK, "metrics — Prometheus on http://localhost:9090 %s", x.dim("("+took(d)+")"))
	x.record("metrics", id, args[len(args)-1], providedLauncher, healthEndpoint("metrics", "prometheus", fc.plan), "prometheus")
	return 0
}

func flowCollector(x executor, fc flowCtx, addr, stage string) int {
	x.banner(roleBanner(fc, "Telemetry (OTel Collector)"))
	args := collectorArgs(stage)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "collector failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("collector", healthEndpoint("collector", "otel", fc.plan), 30)
	if !ok {
		x.dumpLogs(roleContainer("collector"), "collector")
		return 1
	}
	x.say(sayOK, "collector — OTLP on %s:4318, metrics on %s %s", addr, healthEndpoint("collector", "otel", fc.plan), x.dim("("+took(d)+")"))
	x.record("collector", id, args[len(args)-1], providedLauncher, healthEndpoint("collector", "otel", fc.plan), "otel")
	return 0
}

func flowDepRole(x executor, role string, fc flowCtx, addr string) int {
	rp := fc.plan.Roles[role]
	// An embedding that OWNS the local Ollama (all-remote bindings — nothing
	// else runs it) is the same host-process dance inference runs when the
	// bindings are ollama-typed; only the owning role differs.
	if role == "embedding" && rp.Presence == presenceHostPreferred {
		return flowOllama(x, fc, "embedding", rp, addr)
	}
	// jobs without a [jobs] section is a WORKING DEFAULT, not a gap: the
	// gateway's built-in fs queue serves the stack. The generic "not
	// configured; skipping" banner block read as a misconfiguration to the
	// first person who saw it — say what IS running instead, in one line,
	// no banner. Same for identity without an [identity] section: the
	// gateway issues its own tokens.
	if role == "messaging" && rp.Presence == presenceAbsent {
		x.say(sayLog, "messaging — nothing to launch: jobs ride the gateway's fs queue; signals are in-process")
		x.note("messaging: nothing to launch (jobs: fs driver; signal: in-process)")
		x.record(role, "", "", providedNone, "", rp.Driver)
		return 0
	}
	if role == "identity" && rp.Presence == presenceAbsent {
		x.say(sayLog, "identity — nothing to launch: no [identity] section; the gateway issues its own tokens")
		x.note("identity: nothing to launch (no [identity] section; gateway-issued tokens)")
		x.record(role, "", "", providedNone, "", "")
		return 0
	}
	disp := driverDisplay(role, rp.Driver)
	x.banner(roleBanner(fc, depRoleTitles[role]+" ("+disp+")"))
	switch rp.Presence {
	case presenceLauncher:
		// Persistent state rides the run argv (LAUNCHER-STATE.md): roles in
		// stateStores mount their per-root dir; a database refusal (data
		// written by another image) stops the start here.
		// The LEAN daemon (SIGNAL-PLANE Open question 5 / DRIVER-SCOPED-
		// MOUNTS): a signal-only messaging root runs core NATS with no
		// store — provisioning follows the driver selection, and the
		// launcher mounts no space the selected shape won't use.
		var extra []string
		if !(role == "messaging" && rp.Driver == "nats") {
			var ok bool
			extra, ok = x.stateMounts(role, rp.Image, fc.root)
			if !ok {
				return 1
			}
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
		var svcSecrets map[string]string
		if role == "identity" {
			kc, secrets, ok := identityRunExtras(x, fc, addr)
			if !ok {
				return 1
			}
			extra = append(extra, kc...)
			svcSecrets = secrets
		}
		args := providedRunArgs(role, rp, extra...)
		id, ok := x.runDetached(args)
		if !ok {
			x.say(sayFail, "%s (%s) failed to start.", role, disp)
			return 1
		}
		switch role {
		case "identity":
			// Keycloak answers on the realm only once the import is done —
			// the wait is the realm gate as well as the liveness gate.
			d, ok := x.waitHTTP("identity ("+disp+")", healthEndpoint(role, rp.Driver, fc.plan), 90)
			if !ok {
				x.dumpLogs(roleContainer("identity"), "identity")
				return 1
			}
			x.say(sayOK, "identity — %s at %s %s", disp, identityEndpoint(rp), x.dim("("+took(d)+")"))
			// The realm is up and imported; prove it honours the credentials
			// this start is about to inject, BEFORE the first process that
			// holds one. `identityEndpoint` is the realm as THIS host reaches
			// it — see verifyServiceAccounts on why the token's `iss` is not
			// compared against it.
			if !x.preflightIdentity(identityEndpoint(rp), committedResource(fc.root), svcSecrets, rp.AccessTokenLifespan, true) {
				return 1
			}
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan), rp.Driver)
		case "graph":
			aux := fc.plan.AuxPorts("graph")[0].port
			d, ok := x.waitHTTP("graph ("+disp+")", healthEndpoint(role, rp.Driver, fc.plan), 30)
			if !ok {
				x.dumpLogs(roleContainer("graph"), "graph")
				return 1
			}
			x.say(sayOK, "graph — bolt://localhost:%d (browser: http://localhost:%d) %s", rp.Port, aux, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan), rp.Driver)
		case "vectors":
			d, ok := x.waitHTTP("vectors ("+disp+")", healthEndpoint(role, rp.Driver, fc.plan), 15)
			if !ok {
				x.dumpLogs(roleContainer("vectors"), "vectors")
				return 1
			}
			x.say(sayOK, "vectors — http://localhost:%d %s", rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan), rp.Driver)
		case "database":
			d, ok := x.waitTCP("PostgreSQL", addr, rp.Port, 20)
			if !ok {
				x.dumpLogs(roleContainer("database"), "database")
				return 1
			}
			// The port is the runtime's; sessions are the server's.
			if !x.waitPGAccepting(30) {
				x.dumpLogs(roleContainer("database"), "database")
				return 1
			}
			x.say(sayOK, "database — %s on port %d %s", disp, rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan), rp.Driver)
		case "messaging":
			// Same two-phase wait as Postgres: TCP up, then reachable on
			// the container path the gateway will dial.
			d, ok := x.waitTCP("NATS", addr, rp.Port, 15)
			if !ok {
				x.dumpLogs(roleContainer("messaging"), "messaging")
				return 1
			}
			x.say(sayOK, "messaging — %s on port %d %s", disp, rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan), rp.Driver)
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
		//
		// The base is the CONFIGURED issuer, not identityEndpoint's localhost
		// form — nothing of this one is on this host.
		if role == "identity" {
			secrets, ok := serviceClientSecrets(x, fc.root)
			if !ok {
				return 1
			}
			if !x.preflightIdentity(rp.Issuer, committedResource(fc.root), secrets, 0, false) {
				return 1
			}
		}
		// A role sharing another's Ollama reports how that Ollama is
		// provided, not a flat "external" — same process, same answer.
		provided := providedExternal
		if rp.SharesOllamaWith != "" {
			if p := x.providerOf(rp.SharesOllamaWith); p != "" {
				provided = p
			}
		}
		x.record(role, "", "", provided, externalEndpoint(role, rp), rp.Driver)
	}
	return 0
}

// saasBase reconstructs the https origin from a SaaS role plan. Port 443 is
// the real world; any other port is a test or proxy endpoint, spoken plainly.
func saasBase(rp rolePlan) string {
	if rp.Port == 443 {
		return "https://" + rp.Address
	}
	return fmt.Sprintf("http://%s:%d", rp.Address, rp.Port)
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
				x.verifyRemoteModels("inference", saasBase(rp), envValue(fc.userEnv, "ANTHROPIC_API_KEY"), rp.Models)
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

// flowOllama: host-Ollama reuse when serving and reachable from containers;
// else the semiont-ollama container with the model-cache choice. role names
// the OWNER — "inference" when the bindings run through Ollama, "embedding"
// when Ollama exists solely to serve embeddings (all-remote bindings).
func flowOllama(x executor, fc flowCtx, role string, rp rolePlan, addr string) int {
	title := "Inference"
	if role != "inference" {
		title = depRoleTitles[role]
	}
	x.banner(roleBanner(fc, title+" ("+driverDisplay(role, rp.Driver)+")"))
	x.note("probe: host Ollama at http://localhost:%d/api/version", rp.Port)
	x.note(`if present — probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://%s:%d/api/version" — and use it`, x.rtName(), addr, rp.Port)
	return x.either(probeHostOllama(rp.Port),
		func() int {
			if !x.hostOllamaReachable(addr, rp.Port) {
				return 1
			}
			x.say(sayOK, "%s — using host Ollama at http://localhost:%d", role, rp.Port)
			x.record(role, "", "", providedHost, healthEndpoint(role, rp.Driver, fc.plan), rp.Driver)
			x.ensureModels(fmt.Sprintf("http://localhost:%d", rp.Port), fc.plan.OllamaModels)
			return 0
		},
		func() int {
			x.say(sayLog, "No host Ollama detected — starting container...")
			// Same stop+rm rule as the Browser: --service inference has no
			// preflight rm ahead of it, so a stopped semiont-ollama would
			// hold the name (latent since the --rm removal; surfaced by the
			// same review).
			x.stopRm("semiont-ollama")
			x.settle(rp.Port)
			if !x.portCheck(portNeed{rp.Port, "Ollama"}) {
				return 1
			}
			x.recordPorts([]portNeed{{rp.Port, "Ollama"}})
			volume := x.ollamaVolume(fc.opts)
			// The container is semiont-ollama whichever role owns it — the
			// process is the same; only the accounting differs.
			args := ollamaRunArgs(rp, "-v", volume+":/root/.ollama")
			id, ok := x.runDetached(args)
			if !ok {
				x.say(sayFail, "Ollama container failed to start.")
				return 1
			}
			d, ok := x.waitHTTP(role+" (Ollama)", healthEndpoint(role, rp.Driver, fc.plan), 30)
			if !ok {
				x.dumpLogs("semiont-ollama", role)
				return 1
			}
			x.say(sayOK, "%s — Ollama container on http://localhost:%d (24 GB memory) %s", role, rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, healthEndpoint(role, rp.Driver, fc.plan), rp.Driver)
			if descriptorFor(role, "ollama").container == "" {
				// embedding owns this launch: record the container it ran,
				// or stop could never find it.
				x.noteContainer(role, "semiont-ollama")
			}
			x.ensureModels(fmt.Sprintf("http://localhost:%d", rp.Port), fc.plan.OllamaModels)
			return 0
		})
}

// flowGateway: run + host-side health gate + container-gateway reachability
// gate (the sidecars dial addr:port and fatally exit if their first gateway
// fetch fails — host health alone doesn't prove the path they need).
func flowGateway(x executor, fc flowCtx, addr, stage string, otel []string) int {
	port := fc.plan.GatewayPort
	x.banner(startBanner(fc, "Gateway"))
	x.say(sayLog, "http://localhost:%d", port)
	jwt, ok := x.jwtSecret(fc.root)
	if !ok {
		return 1
	}
	// No anchored-text mount: the gateway stopped reading and writing that
	// store when its HTTP faces went (ANCHORED-TEXT-TO-SMELTER P4), and the
	// stamp moved with the writer in P5. The Smelter owns it now.
	//
	// The shared XDG state tree (EXTRACT-ARCHIVIST D6): the Archivist
	// rebuilds the views in here; the gateway's Gatherer reads them. Shared,
	// not stamped — the Archivist owns this store's stamp.
	extra, ok := x.stateMountsShared("state", fc.root)
	if !ok {
		return 1
	}
	gatewayClientSecret, ok := x.serviceClientSecret(fc.root, "gateway")
	if !ok {
		return 1
	}
	bArgs := gatewayArgs(stage, addr, gatewayClientSecret, jwt, fc.version, port, fc.userEnv, otel, extra...)
	id, ok := x.runDetached(bArgs)
	if !ok {
		x.say(sayFail, "Gateway failed to start.")
		return 1
	}
	x.say(sayLog, "Waiting for gateway health...")
	d, ok := x.waitHTTP("Gateway", healthEndpoint("gateway", driverSemiont, fc.plan), 120)
	if !ok {
		x.dumpLogs("semiont-gateway", "gateway")
		return 1
	}
	x.say(sayOK, "Gateway healthy %s", x.dim("("+took(d)+")"))
	if !x.gatewayReachable(addr, port) {
		return 1
	}
	x.record("gateway", id, image("gateway", fc.version), providedLauncher, healthEndpoint("gateway", driverSemiont, fc.plan), driverSemiont)
	return 0
}

func flowSidecar(x executor, fc flowCtx, sc sidecarSpec, addr, stage string, otel []string) int {
	x.banner(startBanner(fc, sc.noun))
	// The Smelter derives the anchored-text artifacts, so it HOLDS the store
	// (ANCHORED-TEXT-TO-SMELTER P1) rather than reaching it over the content
	// transport — and since P5 it owns the STAMP too, stamped with its own
	// image. That pairing is the point: the stamp names the code whose output
	// the store holds, so an image change clears and re-derives. The worker
	// and weaver never touch anchored text.
	//
	// Exactly one service may pass the stamped path (D3.1) — the Archivist
	// keeps a SHARED read-only mount (D5), and the gateway dropped its mount
	// in the same change that made this one stamped.
	var extra []string
	if sc.svc == "smelter" {
		m, ok := x.stateMounts("anchored-text", image("smelter", fc.version), fc.root)
		if !ok {
			return 1
		}
		extra = m
	}
	clientSecret, ok := x.serviceClientSecret(fc.root, sc.svc)
	if !ok {
		return 1
	}
	args := sidecarArgs(sc.svc, sc.port, stage, addr, clientSecret, fc.version, fc.userEnv, otel, extra...)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "%s failed to start.", sc.label)
		return 1
	}
	d, ok := x.waitHTTP(sc.label, healthEndpoint(sc.svc, driverSemiont, fc.plan), 30)
	if !ok {
		x.dumpLogs(semiontDescriptor(sc.svc).container, sc.svc)
		return 1
	}
	x.say(sayOK, "%s healthy (http://localhost:%d) %s", sc.label, sc.port, x.dim("("+took(d)+")"))
	x.record(sc.svc, id, image(sc.svc, fc.version), providedLauncher, healthEndpoint(sc.svc, driverSemiont, fc.plan), driverSemiont)
	return 0
}

// flowArchivist: the Archivist starts right after the gateway and BEFORE
// the sidecars — since the P3 cutover it is the ONLY holder of the record
// (the gateway constructs no actors; this service owns event appends, the
// projection rebuild, and the git index, D4b), so the sidecars' boot-time
// bus requests are answered here and must find the pumps attached.
func flowArchivist(x executor, fc flowCtx, addr, stage string, otel []string) int {
	x.banner(startBanner(fc, "Archivist"))
	// anchored-text is a shared read (the Smelter holds that stamp); the
	// state tree is the inverse — the Archivist holds it as the projection
	// writer.
	extra, ok := x.stateMountsShared("anchored-text", fc.root)
	if !ok {
		return 1
	}
	state, ok := x.stateMounts("state", image("archivist", fc.version), fc.root)
	if !ok {
		return 1
	}
	extra = append(extra, state...)
	clientSecret, ok := x.serviceClientSecret(fc.root, "archivist")
	if !ok {
		return 1
	}
	args := archivistArgs(x.val(fc.root, "<kb-root>"), stage, addr, clientSecret, fc.version, fc.userEnv, otel, extra...)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "Archivist failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("Archivist", healthEndpoint("archivist", driverSemiont, fc.plan), 30)
	if !ok {
		x.dumpLogs("semiont-archivist", "archivist")
		return 1
	}
	x.say(sayOK, "Archivist healthy (http://localhost:24103) %s", x.dim("("+took(d)+")"))
	x.record("archivist", id, image("archivist", fc.version), providedLauncher, healthEndpoint("archivist", driverSemiont, fc.plan), driverSemiont)
	return 0
}

// flowLibrarian: the Librarian (the Matcher — match:* search) starts with
// the core services, BEFORE the sidecars: no sidecar boot path is known to
// ask match:* today, but health-after-pumps plus this ordering makes the
// question moot rather than racy (the smelter's 3.5s boot race against the
// Archivist is the cautionary tale). It reads everything and writes nothing
// durable — see librarianArgs.
func flowLibrarian(x executor, fc flowCtx, addr, stage string, otel []string) int {
	x.banner(startBanner(fc, "Librarian"))
	state, ok := x.stateMountsShared("state", fc.root)
	if !ok {
		return 1
	}
	clientSecret, ok := x.serviceClientSecret(fc.root, "librarian")
	if !ok {
		return 1
	}
	args := librarianArgs(stage, addr, clientSecret, fc.version, fc.userEnv, otel, state...)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "Librarian failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("Librarian", healthEndpoint("librarian", driverSemiont, fc.plan), 30)
	if !ok {
		x.dumpLogs("semiont-librarian", "librarian")
		return 1
	}
	x.say(sayOK, "Librarian healthy (http://localhost:24104) %s", x.dim("("+took(d)+")"))
	x.record("librarian", id, image("librarian", fc.version), providedLauncher, healthEndpoint("librarian", driverSemiont, fc.plan), driverSemiont)
	return 0
}

// flowDispatcher: the Dispatcher owns the job queue and answers job:* lifecycle
// commands (EXTRACT-JOBS). It mounts NOTHING — D7 moved its entity-type and
// tag-schema reads onto the bus (asked of the Archivist), retiring the state
// mount's last non-fs reason; the deployed jetstream driver holds no state tree,
// and an fs-by-omission driver fails loud rather than writing to a fabricated
// home. It dials the gateway for its token and the plane; it is a CONTROL PLANE
// (D5) and touches no bytes, so it never reads from the Archivist. Started after
// the Librarian — health-after-pumps makes ordering against other sidecars moot
// rather than racy.
func flowDispatcher(x executor, fc flowCtx, addr, stage string, otel []string) int {
	x.banner(startBanner(fc, "Dispatcher"))
	clientSecret, ok := x.serviceClientSecret(fc.root, "dispatcher")
	if !ok {
		return 1
	}
	args := dispatcherArgs(stage, addr, clientSecret, fc.version, fc.userEnv, otel)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "Dispatcher failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("Dispatcher", healthEndpoint("dispatcher", driverSemiont, fc.plan), 30)
	if !ok {
		x.dumpLogs("semiont-dispatcher", "dispatcher")
		return 1
	}
	x.say(sayOK, "Dispatcher healthy (http://localhost:24105) %s", x.dim("("+took(d)+")"))
	x.record("dispatcher", id, image("dispatcher", fc.version), providedLauncher, healthEndpoint("dispatcher", driverSemiont, fc.plan), driverSemiont)
	return 0
}

// flowOneService: `start --service` — the no-op presence gate, the
// service's own teardown/ports/pull, secret rejoin + OTel detection + fresh
// staging for config consumers, then the service's launch and gate.
func flowOneService(x executor, fc flowCtx) int {
	svc := fc.opts.service
	if fc.plan != nil {
		if rp, ok := fc.plan.Roles[svc]; ok {
			switch rp.Presence {
			case presenceExternal:
				x.say(sayWarn, "%s is externally provided per %s (%s:%d); nothing to launch.", svc, fc.configFile, rp.Address, rp.Port)
				x.note("%s: externally provided at %s:%d — verify reachability, launch nothing", svc, rp.Address, rp.Port)
				return 0
			case presenceAbsent:
				x.say(sayWarn, "%s is not referenced by %s; nothing to launch.", svc, fc.configFile)
				x.note("%s: not referenced by the config — nothing to launch", svc)
				return 0
			}
		}
	}

	// browser is handled entirely by flowBrowser (its own stop/port/pull) —
	// and its port must NEVER enter the STACK's recorded claims: stop
	// verifies stack-port release while the Browser deliberately keeps
	// running on its port.
	if svc != "inference" && svc != "browser" {
		ports := servicePortNeeds(svc, fc.plan, fc.opts)
		if x.stopRm(roleContainer(svc)) {
			x.say(sayLog, "Removed prior %s container", svc)
			x.settle(portNumbers(ports)...)
		}
		if !x.portChecks(ports) {
			return 1
		}
		x.recordPorts(ports)
	}

	addr := ""
	if serviceNeedsAddr(svc) {
		var ok bool
		if addr, ok = x.resolveAddr(); !ok {
			return 1
		}
		x.say(sayLog, "Host address: %s", x.dim(addr))
	}

	if isConfigConsumer(svc) || svc == "browser" {
		if fc.version == "local" {
			x.note("SEMIONT_VERSION=local — using locally-built :local images (no pull)")
		} else if !x.pull(image(svc, fc.version)) {
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
		if stage, ok = x.stageOne(svc, fc.configFile, fc.plan.EnvName, addr); !ok {
			return 1
		}
	}

	switch svc {
	case "collector":
		cstage, ok := x.stageCollector(addr)
		if !ok {
			return 1
		}
		if code := flowCollector(x, fc, addr, cstage); code != 0 {
			return code
		}
	case "metrics":
		mstage, ok := x.stageMetrics(addr)
		if !ok {
			return 1
		}
		if code := flowMetrics(x, fc, mstage); code != 0 {
			return code
		}
	case "traces":
		if code := flowTraces(x, fc); code != 0 {
			return code
		}
	case "graph", "vectors", "database", "messaging", "identity":
		// The same flow a full start walks. This branch used to be a second
		// implementation of it, and the copy had drifted: it staged no NATS
		// authorization file and mounted a state dir the lean signal-only
		// daemon never uses (DRIVER-SCOPED-MOUNTS).
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
	case "worker", "smelter", "weaver":
		for _, sc := range sidecarSpecs {
			if sc.svc == svc {
				if code := flowSidecar(x, fc, sc, addr, stage, otel); code != 0 {
					return code
				}
			}
		}
	case "browser":
		// Explicit --service browser is the one deliberate restart (and the
		// port mover): forceRestart bypasses keep-if-current.
		bp := browserPort(fc.opts)
		// Moving the Browser changes its redirect URI without touching the
		// realm, so this is the one flow that has to ask whether the realm
		// will follow. Only on a move: :3000 is what every realm registers.
		//
		// The nil plan is not a defensive check: the Browser is machine-level
		// (BROWSER-LIFECYCLE), so `--service browser` is the one start that
		// resolves no KB and therefore has no plan — the same case
		// runStartService and serviceEndpoint already name. No config, no
		// identity role, nothing to ask.
		if bp != 3000 && fc.plan != nil {
			if rp, ok := fc.plan.Roles["identity"]; ok && rp.Issuer != "" {
				base := rp.Issuer
				if rp.Presence == presenceLauncher {
					base = identityEndpoint(rp)
				}
				if !x.preflightBrowserMove(base, bp) {
					return 1
				}
			}
		}
		if code := flowBrowser(x, fc.version, bp, true); code != 0 {
			return code
		}
	}
	return 0
}

// servicePortNeeds: one service's must-be-free ports. Claims follow the
// plan for config-owned ports (dependency roles, gateway); the static role
// table covers only the launcher-fiat ports (sidecars, browser, traces).
func servicePortNeeds(svc string, plan *launchPlan, opts startOptions) []portNeed {
	ports := stackPortNeeds(svc)
	switch {
	case svc == "browser" && opts.port != 0:
		ports = []portNeed{{opts.port, "Browser"}}
	case svc == "gateway" && plan != nil:
		ports = []portNeed{{plan.GatewayPort, "Gateway"}}
	case plan != nil:
		if rp, ok := plan.Roles[svc]; ok && rp.Presence == presenceLauncher {
			spec := descriptorFor(svc, rp.Driver)
			ports = append(append([]portNeed{}, spec.auxPorts...), portNeed{rp.Port, spec.portLabel})
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
