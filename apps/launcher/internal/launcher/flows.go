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
}

// flowFullStart is THE full-start sequence: preflight → ports → staging →
// pulls → traces → graph → vectors → inference → database → backend →
// sidecars → frontend.
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
	args := frontendArgs(fc.version)
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
		x.record(role, "", "", providedExternal, externalEndpoint(role, rp), rp.Driver)
	}
	return 0
}

// externalEndpoint: the status probe for an externally-provided role.
func externalEndpoint(role string, rp rolePlan) string {
	switch role {
	case "vectors":
		return fmt.Sprintf("http://%s:%d/readyz", rp.Address, rp.Port)
	case "inference":
		return fmt.Sprintf("http://%s:%d/api/version", rp.Address, rp.Port)
	default: // graph, database: not HTTP — TCP dial
		return fmt.Sprintf("tcp:%s:%d", rp.Address, rp.Port)
	}
}

// flowInferenceRole: obligation dispatch for inference (the host-process
// dance lives in flowInference).
func flowInferenceRole(x executor, fc flowCtx, addr string) int {
	rp := fc.plan.Roles["inference"]
	switch rp.Obligation {
	case obligationHostProcess:
		return flowInference(x, fc, rp, addr)
	case obligationExternal:
		x.banner("Inference (" + driverDisplay("inference", rp.Driver) + ")")
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

// flowInference: host-Ollama reuse when serving and reachable from
// containers; else the semiont-ollama container with the model-cache choice.
func flowInference(x executor, fc flowCtx, rp rolePlan, addr string) int {
	x.banner("Inference (" + driverDisplay("inference", rp.Driver) + ")")
	x.note("probe: host Ollama at http://localhost:%d/api/version", rp.Port)
	x.note(`if present — probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://%s:%d/api/version" — and use it`, x.rtName(), addr, rp.Port)
	return x.either(probeHostOllama(rp.Port),
		func() int {
			if !x.hostOllamaReachable(addr, rp.Port) {
				return 1
			}
			x.say(sayOK, "inference — using host Ollama at http://localhost:%d", rp.Port)
			x.record("inference", "", "", providedHost, fmt.Sprintf("http://localhost:%d/api/version", rp.Port), rp.Driver)
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
			args := providedRunArgs("inference", rp, "-m", "24G", "-v", volume+":/root/.ollama")
			id, ok := x.runDetached(args)
			if !ok {
				x.say(sayFail, "Ollama container failed to start.")
				return 1
			}
			d, ok := x.waitHTTP("inference (Ollama)", fmt.Sprintf("http://localhost:%d/api/version", rp.Port), 30)
			if !ok {
				return 1
			}
			x.say(sayOK, "inference — Ollama container on http://localhost:%d (24 GB memory) %s", rp.Port, x.dim("("+took(d)+")"))
			x.record("inference", id, rp.Image, providedLauncher, fmt.Sprintf("http://localhost:%d/api/version", rp.Port), rp.Driver)
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
		ports := servicePortNeeds(svc, fc.plan)
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
		if code := flowInference(x, fc, fc.plan.Roles[svc], addr); code != 0 {
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
		args := frontendArgs(fc.version)
		id, ok := x.runDetached(args)
		if !ok {
			x.say(sayFail, "Frontend failed to start.")
			return 1
		}
		if d, ok = x.waitHTTP("Frontend", "http://localhost:3000", 30); !ok {
			return 1
		}
		x.record(svc, id, image("frontend", fc.version), providedLauncher, serviceEndpoint(svc, fc.plan), "")
	}
	if d > 0 {
		x.say(sayOK, "%s healthy %s", svc, x.dim("("+took(d)+")"))
	}
	return 0
}

// servicePortNeeds: one service's must-be-free ports. Claims follow the
// plan for config-owned ports (dependency roles, backend); the static role
// table covers only the launcher-fiat ports (sidecars, frontend, traces).
func servicePortNeeds(svc string, plan *launchPlan) []portNeed {
	ports := roles[svc].ports
	switch {
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
