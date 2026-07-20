package launcher

// flows.go — each launch sequence written ONCE, walked by an executor in
// live or plan mode (.plans/LAUNCHER-ROLE-EXECUTOR.md). Effects (argv,
// ports, URLs, gate tries, record contents) exist only here: start cannot
// change what it does without --dry-run showing the same change. Decoration
// (say vs note) is deliberately one-sided per mode.

import (
	"fmt"
	"time"
)

type flowCtx struct {
	plan       *launchPlan
	opts       startOptions
	version    string
	root       string
	configFile string
	userEnv    []string
}

var depRoleTitles = map[string]string{
	"graph": "Graph", "vectors": "Vectors", "database": "Database",
	"embedding": "Embedding",
}

// flowFullStart is THE full-start sequence: preflight → ports → staging →
// pulls → traces → graph → vectors → inference → embedding → database →
// backend → sidecars → frontend.
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
	x.say(sayLog, "Removing prior containers %s", x.dim(fmt.Sprintf("(stop+rm, %d names; exact commands: semiont start --dry-run)", len(preflightNames))))
	removed := 0
	for _, c := range preflightNames {
		if x.stopRm(c) {
			removed++
		}
	}
	x.sweepStray(preflightNames)
	x.sweepStaging()
	x.pause()
	if removed == 0 {
		x.say(sayOK, "No prior containers")
	} else {
		x.say(sayOK, "Removed %d prior container(s)", removed)
	}

	checks := planPortChecks(fc.plan, fc.opts.observe)
	if !x.portChecks(checks) {
		return 1
	}
	x.say(sayOK, "Required ports are free")

	stage, ok := x.stageAll(fc.configFile)
	if !ok {
		return 1
	}
	x.initStack(fc.root, fc.opts.configName, fc.version, addr, stage)
	x.recordPorts(checks)

	x.banner("Pulling Images")
	if fc.version == "local" {
		x.say(sayLog, "Using locally-built %s images (skipping pull)", x.bold(":local"))
		x.note("SEMIONT_VERSION=local — using locally-built :local images (no pull)")
	} else {
		for _, svc := range semiontServices {
			if !x.pull(image(svc, fc.version)) {
				return 1
			}
		}
		x.say(sayOK, "Images pulled")
	}

	var otel []string
	if fc.opts.observe {
		x.banner("Traces (Jaeger)")
		args := tracesArgs()
		id, ok := x.runDetached(args)
		if !ok {
			x.say(sayFail, "traces (Jaeger) failed to start.")
			return 1
		}
		d, ok := x.waitHTTP("traces (Jaeger)", "http://localhost:16686", 30)
		if !ok {
			return 1
		}
		x.say(sayOK, "traces — Jaeger UI on http://localhost:16686 (OTLP collector: %s:4318) %s", addr, x.dim("("+took(d)+")"))
		x.record("traces", id, args[len(args)-1], providedLauncher, "http://localhost:16686", "jaeger")
		otel = otelArgs(addr)
	}

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
	if code := flowDepRole(x, "database", fc, addr); code != 0 {
		return code
	}

	secret, ok := x.workerSecret()
	if !ok {
		return 1
	}

	x.banner("Starting Backend")
	x.say(sayLog, "http://localhost:%d", fc.plan.BackendPort)
	x.say(sayLog, "Worker secret: %s", x.dim("(generated)"))
	if code := flowBackend(x, fc, addr, stage, secret, otel); code != 0 {
		return code
	}

	// The weaver note: the graph projection is standalone-only — without the
	// weaver the graph stays empty and every gather 404s at the
	// buildKnowledgeGraph barrier.
	for _, sc := range sidecarSpecs {
		x.banner(sc.banner)
		if code := flowSidecar(x, fc, sc, addr, stage, secret, otel); code != 0 {
			return code
		}
	}

	// Frontend: a static SPA server — no config mount and no service env.
	x.banner("Starting Frontend")
	args := frontendArgs(fc.version, 3000)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "Frontend failed to start.")
		return 1
	}
	d, ok := x.waitHTTP("Frontend", "http://localhost:3000", 30)
	if !ok {
		return 1
	}
	x.say(sayOK, "Frontend on http://localhost:3000 %s", x.dim("("+took(d)+")"))
	x.record("frontend", id, image("frontend", fc.version), providedLauncher, "http://localhost:3000", "")
	return 0
}

// flowDepRole: the uniform dependency-role shape for graph / vectors /
// database, obligation-dispatched.
func flowDepRole(x executor, role string, fc flowCtx, addr string) int {
	rp := fc.plan.Roles[role]
	// An embedding that OWNS the local Ollama (all-remote bindings — nothing
	// else runs it) is the same host-process dance inference runs when the
	// bindings are ollama-typed; only the owning role differs.
	if role == "embedding" && rp.Obligation == obligationHostProcess {
		return flowOllama(x, fc, "embedding", rp, addr)
	}
	disp := driverDisplay(role, rp.Driver)
	x.banner(depRoleTitles[role] + " (" + disp + ")")
	switch rp.Obligation {
	case obligationProvided:
		args := providedRunArgs(role, rp)
		id, ok := x.runDetached(args)
		if !ok {
			x.say(sayFail, "%s (%s) failed to start.", role, disp)
			return 1
		}
		switch role {
		case "graph":
			aux := fc.plan.AuxPorts("graph")[0].port
			d, ok := x.waitHTTP("graph ("+disp+")", fmt.Sprintf("http://localhost:%d", aux), 30)
			if !ok {
				return 1
			}
			x.say(sayOK, "graph — bolt://localhost:%d (browser: http://localhost:%d) %s", rp.Port, aux, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, fmt.Sprintf("http://localhost:%d", aux), rp.Driver)
		case "vectors":
			d, ok := x.waitHTTP("vectors ("+disp+")", fmt.Sprintf("http://localhost:%d/readyz", rp.Port), 15)
			if !ok {
				return 1
			}
			x.say(sayOK, "vectors — http://localhost:%d %s", rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, fmt.Sprintf("http://localhost:%d/readyz", rp.Port), rp.Driver)
		case "database":
			d, ok := x.waitPG(addr, rp.Port, 20)
			if !ok {
				return 1
			}
			x.say(sayOK, "database — %s on port %d %s", disp, rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, fmt.Sprintf("tcp:localhost:%d", rp.Port), rp.Driver)
		}
	case obligationAbsent:
		x.say(sayLog, "%s — not configured; skipping", role)
		x.note("%s: not referenced by the config — nothing to launch", role)
		x.record(role, "", "", providedNone, "", "")
	case obligationHostProcess:
		x.note("%s: host process at localhost:%d — verify reachability, launch nothing", role, rp.Port)
		if !x.probeTCP(role, rp) {
			return 1
		}
		x.record(role, "", "", providedExternal, externalEndpoint(role, rp), rp.Driver)
	case obligationExternal:
		x.note("%s: externally provided at %s:%d — verify reachability, launch nothing", role, rp.Address, rp.Port)
		if !x.probeTCP(role, rp) {
			return 1
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

// externalEndpoint: the status probe for an externally-provided role.
func externalEndpoint(role string, rp rolePlan) string {
	switch role {
	case "embedding":
		// An ollama-served embedding answers Ollama's own version endpoint;
		// Voyage is HTTPS SaaS whose API needs a key, so reachability is all
		// a credential-free probe can honestly assert — a TCP dial.
		if rp.Driver == "ollama" {
			return fmt.Sprintf("http://%s:%d/api/version", rp.Address, rp.Port)
		}
		return fmt.Sprintf("tcp:%s:%d", rp.Address, rp.Port)
	case "vectors":
		return fmt.Sprintf("http://%s:%d/readyz", rp.Address, rp.Port)
	case "inference":
		// Only an Ollama answers Ollama's version endpoint; a remote SaaS
		// provider (anthropic) gets a bare reachability dial.
		if rp.Driver != "ollama" {
			return fmt.Sprintf("tcp:%s:%d", rp.Address, rp.Port)
		}
		return fmt.Sprintf("http://%s:%d/api/version", rp.Address, rp.Port)
	default: // graph, database: not HTTP — TCP dial
		return fmt.Sprintf("tcp:%s:%d", rp.Address, rp.Port)
	}
}

// flowInferenceRole: obligation dispatch for inference (the host-process
// dance lives in flowOllama).
func flowInferenceRole(x executor, fc flowCtx, addr string) int {
	rp := fc.plan.Roles["inference"]
	switch rp.Obligation {
	case obligationHostProcess:
		return flowOllama(x, fc, "inference", rp, addr)
	case obligationExternal:
		x.banner("Inference (" + driverDisplay("inference", rp.Driver) + ")")
		if rp.Driver != "ollama" {
			// Remote SaaS (Anthropic): nothing to launch, and a start-time
			// TCP dial proves nothing a job won't discover — the API key is
			// the real gate. Recorded so status carries the honest row.
			x.say(sayLog, "inference — %s is remote SaaS; nothing to launch", driverDisplay("inference", rp.Driver))
			x.note("inference: remote SaaS (%s) at %s:%d — nothing to launch or probe", rp.Driver, rp.Address, rp.Port)
			x.record("inference", "", "", providedExternal, externalEndpoint("inference", rp), rp.Driver)
			return 0
		}
		x.note("inference: externally provided at %s:%d — verify reachability, launch nothing", rp.Address, rp.Port)
		if !x.probeTCP("inference", rp) {
			return 1
		}
		x.record("inference", "", "", providedExternal, externalEndpoint("inference", rp), rp.Driver)
	case obligationAbsent:
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
	x.banner(title + " (" + driverDisplay(role, rp.Driver) + ")")
	x.note("probe: host Ollama at http://localhost:%d/api/version", rp.Port)
	x.note(`if present — probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://%s:%d/api/version" — and use it`, x.rtName(), addr, rp.Port)
	return x.either(probeHostOllama(rp.Port),
		func() int {
			if !x.hostOllamaReachable(addr, rp.Port) {
				return 1
			}
			x.say(sayOK, "%s — using host Ollama at http://localhost:%d", role, rp.Port)
			x.record(role, "", "", providedHost, fmt.Sprintf("http://localhost:%d/api/version", rp.Port), rp.Driver)
			x.ensureModels(fmt.Sprintf("http://localhost:%d", rp.Port), fc.plan.OllamaModels)
			return 0
		},
		func() int {
			x.say(sayLog, "No host Ollama detected — starting container...")
			x.stopEcho("semiont-ollama")
			x.pause()
			if !x.portCheck(portNeed{rp.Port, "Ollama"}) {
				return 1
			}
			x.recordPorts([]portNeed{{rp.Port, "Ollama"}})
			volume := x.ollamaVolume(fc.opts)
			// The container is semiont-ollama whichever role owns it — the
			// process is the same; only the accounting differs.
			args := ollamaRunArgs(rp, "-m", "24G", "-v", volume+":/root/.ollama")
			id, ok := x.runDetached(args)
			if !ok {
				x.say(sayFail, "Ollama container failed to start.")
				return 1
			}
			d, ok := x.waitHTTP(role+" (Ollama)", fmt.Sprintf("http://localhost:%d/api/version", rp.Port), 30)
			if !ok {
				return 1
			}
			x.say(sayOK, "%s — Ollama container on http://localhost:%d (24 GB memory) %s", role, rp.Port, x.dim("("+took(d)+")"))
			x.record(role, id, rp.Image, providedLauncher, fmt.Sprintf("http://localhost:%d/api/version", rp.Port), rp.Driver)
			if roles[role].container == "" {
				// embedding owns this launch: record the container it ran,
				// or stop could never find it.
				x.noteContainer(role, "semiont-ollama")
			}
			x.ensureModels(fmt.Sprintf("http://localhost:%d", rp.Port), fc.plan.OllamaModels)
			return 0
		})
}

// flowBackend: run + host-side health gate + container-gateway reachability
// gate (the sidecars dial addr:port and fatally exit if their first backend
// fetch fails — host health alone doesn't prove the path they need).
func flowBackend(x executor, fc flowCtx, addr, stage, secret string, otel []string) int {
	port := fc.plan.BackendPort
	bArgs := backendArgs(x.val(fc.root, "<kb-root>"), stage, addr, secret, fc.version, port, fc.userEnv, otel)
	id, ok := x.runDetached(bArgs)
	if !ok {
		x.say(sayFail, "Backend failed to start.")
		return 1
	}
	x.say(sayLog, "Waiting for backend health...")
	d, ok := x.waitHTTP("Backend", fmt.Sprintf("http://localhost:%d/api/health", port), 120)
	if !ok {
		return 1
	}
	x.say(sayOK, "Backend healthy %s", x.dim("("+took(d)+")"))
	if !x.backendReachable(addr, port) {
		return 1
	}
	x.record("backend", id, image("backend", fc.version), providedLauncher, fmt.Sprintf("http://localhost:%d/api/health", port), "")
	return 0
}

func flowSidecar(x executor, fc flowCtx, sc sidecarSpec, addr, stage, secret string, otel []string) int {
	args := sidecarArgs(sc.svc, sc.mem, sc.port, stage, addr, secret, fc.version, fc.userEnv, otel)
	id, ok := x.runDetached(args)
	if !ok {
		x.say(sayFail, "%s failed to start.", sc.label)
		return 1
	}
	d, ok := x.waitHTTP(sc.label, fmt.Sprintf("http://localhost:%d/health", sc.port), 30)
	if !ok {
		return 1
	}
	x.say(sayOK, "%s healthy (http://localhost:%d) %s", sc.label, sc.port, x.dim("("+took(d)+")"))
	x.record(sc.svc, id, image(sc.svc, fc.version), providedLauncher, fmt.Sprintf("http://localhost:%d/health", sc.port), "")
	return 0
}

// flowOneService: `start --service` — the no-op obligation gate, the
// service's own teardown/ports/pull, secret rejoin + OTel detection + fresh
// staging for config consumers, then the service's launch and gate.
func flowOneService(x executor, fc flowCtx) int {
	svc := fc.opts.service
	if fc.plan != nil {
		if rp, ok := fc.plan.Roles[svc]; ok {
			switch rp.Obligation {
			case obligationExternal:
				x.say(sayWarn, "%s is externally provided per %s (%s:%d); nothing to launch.", svc, fc.configFile, rp.Address, rp.Port)
				x.note("%s: externally provided at %s:%d — verify reachability, launch nothing", svc, rp.Address, rp.Port)
				return 0
			case obligationAbsent:
				x.say(sayWarn, "%s is not referenced by %s; nothing to launch.", svc, fc.configFile)
				x.note("%s: not referenced by the config — nothing to launch", svc)
				return 0
			}
		}
	}

	x.banner("Restarting " + roleTitle(svc))
	if svc != "inference" {
		if x.stopRm(roles[svc].container) {
			x.say(sayLog, "Removed prior %s container", svc)
			x.pause()
		}
		ports := servicePortNeeds(svc, fc.plan, fc.opts)
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

	if isConfigConsumer(svc) || svc == "frontend" {
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
	secret, stage := "", ""
	if isConfigConsumer(svc) {
		var ok bool
		if secret, ok = x.recoverSecret(); !ok {
			return 1
		}
		if stage, ok = x.stageOne(svc, fc.configFile); !ok {
			return 1
		}
	}

	var d time.Duration
	switch svc {
	case "traces":
		args := tracesArgs()
		id, ok := x.runDetached(args)
		if !ok {
			x.say(sayFail, "traces (Jaeger) failed to start.")
			return 1
		}
		if d, ok = x.waitHTTP("traces (Jaeger UI)", "http://localhost:16686", 30); !ok {
			return 1
		}
		x.record(svc, id, args[len(args)-1], providedLauncher, serviceEndpoint(svc, fc.plan), "jaeger")
	case "graph", "vectors", "database":
		rp := fc.plan.Roles[svc]
		disp := driverDisplay(svc, rp.Driver)
		args := providedRunArgs(svc, rp)
		id, ok := x.runDetached(args)
		if !ok {
			x.say(sayFail, "%s (%s) failed to start.", svc, disp)
			return 1
		}
		switch svc {
		case "graph":
			if d, ok = x.waitHTTP("graph ("+disp+")", fmt.Sprintf("http://localhost:%d", fc.plan.AuxPorts("graph")[0].port), 30); !ok {
				return 1
			}
		case "vectors":
			if d, ok = x.waitHTTP("vectors ("+disp+")", fmt.Sprintf("http://localhost:%d/readyz", rp.Port), 15); !ok {
				return 1
			}
		case "database":
			if d, ok = x.waitPG(addr, rp.Port, 20); !ok {
				return 1
			}
		}
		x.record(svc, id, rp.Image, providedLauncher, serviceEndpoint(svc, fc.plan), rp.Driver)
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
	case "backend":
		if code := flowBackend(x, fc, addr, stage, secret, otel); code != 0 {
			return code
		}
	case "worker", "smelter", "weaver":
		for _, sc := range sidecarSpecs {
			if sc.svc == svc {
				if code := flowSidecar(x, fc, sc, addr, stage, secret, otel); code != 0 {
					return code
				}
			}
		}
	case "frontend":
		bp := browserPort(fc.opts)
		if bp != 3000 {
			x.say(sayWarn, "Browser on port %d: backends configured with frontendURL http://localhost:3000 may reject this origin (OAuth redirects / CORS).", bp)
		}
		args := frontendArgs(fc.version, bp)
		id, ok := x.runDetached(args)
		if !ok {
			x.say(sayFail, "Frontend failed to start.")
			return 1
		}
		if d, ok = x.waitHTTP("Frontend", fmt.Sprintf("http://localhost:%d", bp), 30); !ok {
			return 1
		}
		x.record(svc, id, image("frontend", fc.version), providedLauncher, fmt.Sprintf("http://localhost:%d", bp), "")
	}
	if d > 0 {
		x.say(sayOK, "%s healthy %s", svc, x.dim("("+took(d)+")"))
	}
	return 0
}

// servicePortNeeds: one service's must-be-free ports. Claims follow the
// plan for config-owned ports (dependency roles, backend); the static role
// table covers only the launcher-fiat ports (sidecars, frontend, traces).
func servicePortNeeds(svc string, plan *launchPlan, opts startOptions) []portNeed {
	ports := roles[svc].ports
	switch {
	case svc == "frontend" && opts.port != 0:
		ports = []portNeed{{opts.port, "Frontend"}}
	case svc == "backend" && plan != nil:
		ports = []portNeed{{plan.BackendPort, "Backend"}}
	case plan != nil:
		if rp, ok := plan.Roles[svc]; ok && rp.Obligation == obligationProvided {
			spec := driverCatalog[svc][rp.Driver]
			ports = append(append([]portNeed{}, spec.auxPorts...), portNeed{rp.Port, spec.portLabel})
		}
	}
	return ports
}
