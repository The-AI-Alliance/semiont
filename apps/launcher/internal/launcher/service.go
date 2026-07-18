package launcher

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// startableServices: everything `start --service` accepts, with the ports it
// must have free. Ollama is listed with no ports — startOllama owns its port
// check (a host instance may make the container unnecessary).
var startableServices = map[string][]struct {
	port  int
	label string
}{
	"jaeger":   {{16686, "Jaeger UI"}, {4318, "Jaeger OTLP"}},
	"neo4j":    {{7474, "Neo4j HTTP"}, {7687, "Neo4j Bolt"}},
	"qdrant":   {{6333, "Qdrant"}},
	"ollama":   {},
	"postgres": {{5432, "PostgreSQL"}},
	"backend":  {{4000, "Backend"}},
	"worker":   {{9090, "Worker"}},
	"smelter":  {{9091, "Smelter"}},
	"weaver":   {{9092, "Weaver"}},
	"frontend": {{3000, "Frontend"}},
}

func isConfigConsumer(svc string) bool {
	return svc == "backend" || svc == "worker" || svc == "smelter" || svc == "weaver"
}

func serviceNeedsAddr(svc string) bool {
	return isConfigConsumer(svc) || svc == "postgres" || svc == "ollama"
}

// recoverWorkerSecret pulls SEMIONT_WORKER_SECRET out of a running Semiont
// container's env via the runtime's inspect — restarting one service rejoins
// the incumbent stack's secret instead of minting a fresh one (which would
// silently break sidecar↔backend auth). Returns the secret and the container
// it came from, or "".
func recoverWorkerSecret(rt string) (string, string) {
	for _, c := range []string{"semiont-backend", "semiont-worker", "semiont-smelter", "semiont-weaver"} {
		out, err := capture(rt, "inspect", c)
		if err != nil || out == "" {
			continue
		}
		var entries []map[string]any
		if json.Unmarshal([]byte(out), &entries) != nil || len(entries) == 0 {
			continue
		}
		for _, env := range inspectEnv(entries[0]) {
			if v, ok := strings.CutPrefix(env, "SEMIONT_WORKER_SECRET="); ok && v != "" {
				return v, c
			}
		}
	}
	return "", ""
}

// inspectEnv digs the env list out of one inspect entry, wherever the
// runtime keeps it: Apple container at configuration.initProcess.environment,
// docker/podman at Config.Env.
func inspectEnv(entry map[string]any) []string {
	dig := func(m map[string]any, path ...string) any {
		var cur any = m
		for _, k := range path {
			mm, ok := cur.(map[string]any)
			if !ok {
				return nil
			}
			cur = mm[k]
		}
		return cur
	}
	for _, raw := range []any{
		dig(entry, "configuration", "initProcess", "environment"),
		dig(entry, "Config", "Env"),
	} {
		list, ok := raw.([]any)
		if !ok {
			continue
		}
		envs := make([]string, 0, len(list))
		for _, e := range list {
			if s, ok := e.(string); ok {
				envs = append(envs, s)
			}
		}
		if len(envs) > 0 {
			return envs
		}
	}
	return nil
}

// serviceSecret resolves the worker secret for a --service start: a running
// stack's secret wins (rejoin, don't break), then the environment, then a
// fresh one (nothing running to disagree with).
func serviceSecret(u *ui, rt string) (string, bool) {
	if s, from := recoverWorkerSecret(rt); s != "" {
		u.log("Worker secret: %s", u.dim("(recovered from "+from+")"))
		return s, true
	}
	if s := os.Getenv("SEMIONT_WORKER_SECRET"); s != "" {
		u.log("Worker secret: %s", u.dim("(from environment)"))
		return s, true
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		u.fail("Generating worker secret: %v", err)
		return "", false
	}
	u.log("Worker secret: %s", u.dim("(generated — no running stack to join)"))
	return hex.EncodeToString(b), true
}

// runStartService is `semiont start --service <name>`: one service's slice of
// the full-start flow — its own stop+rm, port checks, pull, fresh private
// config copy, run, and health gate. The rest of the stack is untouched.
func runStartService(u *ui, rt, version, root, configFile string, opts startOptions, userEnv []string) int {
	t0 := time.Now()
	svc := opts.service
	cname := "semiont-" + svc

	u.banner("Restarting " + svc)

	// The service's own teardown (idempotent across running/stopped/absent) —
	// except ollama, whose start path owns this (host reuse may skip it).
	if svc != "ollama" {
		stopped := runSilent(rt, "stop", cname) == nil
		rmed := runSilent(rt, "rm", cname) == nil
		if stopped || rmed {
			u.log("Removed prior %s container", svc)
			time.Sleep(time.Second)
		}
		for _, pc := range startableServices[svc] {
			if !requirePortFree(u, pc.port, pc.label, opts.forceKillPorts) {
				return 1
			}
		}
	}

	addr := ""
	if serviceNeedsAddr(svc) {
		addr = resolveHostAddr(rt)
		if addr == "" {
			u.fail("Could not determine host address for container networking.")
			return 1
		}
		u.log("Host address: %s", u.dim(addr))
	}

	// Pull the image for Semiont services (infra images are pinned tags, same
	// as full start: their run pulls on first use and the cache stays valid).
	if isConfigConsumer(svc) || svc == "frontend" {
		if version != "local" {
			args := pullArgs(rt, image(svc, version))
			u.echoCmd(rt, args...)
			if err := runVisible(rt, args...); err != nil {
				u.fail("Pull failed: %s", image(svc, version))
				return 1
			}
		}
	}

	// Observability is auto-detected, not flagged: if Jaeger is up, the
	// restarted service points at it like the rest of the stack does.
	var otel []string
	if isConfigConsumer(svc) && httpOK("http://localhost:16686") {
		otel = otelArgs(addr)
		u.log("Jaeger detected — OTel export enabled")
	}

	secret := ""
	stage := ""
	if isConfigConsumer(svc) {
		var ok bool
		if secret, ok = serviceSecret(u, rt); !ok {
			return 1
		}
		// A FRESH private staging dir for this service only: the running
		// containers keep mounting their existing copies, and a new file is by
		// definition not mounted anywhere else (the Apple-container same-file
		// double-mount race cannot trigger). Swept by the next full
		// start/stop.
		var err error
		stage, err = os.MkdirTemp("/tmp", "semiont-config.")
		if err != nil {
			u.fail("Cannot create config staging dir: %v", err)
			return 1
		}
		cfg, err := os.ReadFile(configFile)
		if err != nil {
			u.fail("Reading %s: %v", configFile, err)
			return 1
		}
		if err := os.WriteFile(filepath.Join(stage, svc+".toml"), cfg, 0o644); err != nil {
			u.fail("Staging config for %s: %v", svc, err)
			return 1
		}
	}

	var d time.Duration
	ok := false
	switch svc {
	case "jaeger":
		d, ok = runGated(u, rt, jaegerArgs(), "Jaeger", "Jaeger UI", "http://localhost:16686", 30)
	case "neo4j":
		d, ok = runGated(u, rt, neo4jArgs(), "Neo4j", "Neo4j", "http://localhost:7474", 30)
	case "qdrant":
		d, ok = runGated(u, rt, qdrantArgs(), "Qdrant", "Qdrant", "http://localhost:6333/readyz", 15)
	case "ollama":
		if code := startOllama(u, rt, addr, opts); code != 0 {
			return code
		}
		ok = true
	case "postgres":
		u.echoCmd(rt, postgresArgs()...)
		if err := runDetached(rt, postgresArgs()...); err != nil {
			u.fail("PostgreSQL failed to start.")
			return 1
		}
		d, ok = waitForPG(u, rt, addr, 5432, 20)
	case "backend":
		var admin []string
		if opts.adminEmail != "" && opts.adminPassword != "" {
			admin = []string{"--env", "ADMIN_EMAIL=" + opts.adminEmail, "--env", "ADMIN_PASSWORD=" + opts.adminPassword}
		}
		if code := runBackend(u, rt, root, stage, addr, secret, version, userEnv, otel, admin); code != 0 {
			return code
		}
		ok = true
	case "worker", "smelter", "weaver":
		for _, sc := range sidecarSpecs {
			if sc.svc == svc {
				if code := runSidecar(u, rt, sc, stage, addr, secret, version, userEnv, otel); code != 0 {
					return code
				}
			}
		}
		ok = true
	case "frontend":
		d, ok = runGated(u, rt, frontendArgs(version), "Frontend", "Frontend", "http://localhost:3000", 30)
	}
	if !ok {
		return 1
	}
	if d > 0 {
		u.ok("%s healthy %s", svc, u.dim("("+took(d)+")"))
	}

	fmt.Println()
	fmt.Printf("%s  %s\n", u.wrap(ansiBold+ansiGreen, "🚀 "+svc+" is up"), u.dim("("+took(time.Since(t0))+")"))
	fmt.Printf("  Check health:  %s\n", u.bold("semiont status"))
	return 0
}

// renderServicePlan is --dry-run for --service: the one service's slice of
// the plan, conditionals as comments (matching renderStartPlan's style).
func renderServicePlan(rt, version string, opts startOptions, userEnv []string) {
	const addr = "<host-addr>"
	const stage = "<config-stage>"
	svc := opts.service
	p := func(args ...string) { fmt.Println(renderCmd(rt, args...)) }
	c := func(format string, a ...any) { fmt.Printf("# "+format+"\n", a...) }

	c("semiont start --service %s --dry-run — the exact runtime commands a real", svc)
	c("run would execute, in order. Values known only at runtime appear as <placeholders>.")
	if svc != "ollama" {
		p("stop", "semiont-"+svc)
		p("rm", "semiont-"+svc)
		ports := make([]string, 0, 2)
		for _, pc := range startableServices[svc] {
			ports = append(ports, fmt.Sprintf("%d", pc.port))
		}
		if len(ports) > 0 {
			c("require free ports: %s", strings.Join(ports, " "))
		}
	}
	if isConfigConsumer(svc) || svc == "frontend" {
		if version == "local" {
			c("SEMIONT_VERSION=local — using locally-built :local images (no pull)")
		} else {
			p(pullArgs(rt, image(svc, version))...)
		}
	}
	var otel []string
	if isConfigConsumer(svc) {
		c("probe: Jaeger at http://localhost:16686 — if running, add --env OTEL_EXPORTER_OTLP_ENDPOINT=http://<host-addr>:4318")
		c("worker secret: recovered from a running Semiont container's env (inspect), else $SEMIONT_WORKER_SECRET, else generated")
		c("stage a fresh private config copy under <config-stage>: %s.toml", svc)
	}
	switch svc {
	case "jaeger":
		p(jaegerArgs()...)
		c("wait: http://localhost:16686 (30s)")
	case "neo4j":
		p(neo4jArgs()...)
		c("wait: http://localhost:7474 (30s)")
	case "qdrant":
		p(qdrantArgs()...)
		c("wait: http://localhost:6333/readyz (15s)")
	case "ollama":
		c("probe: host Ollama at http://localhost:11434/api/version")
		c(`if present — probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://<host-addr>:11434/api/version" — and use it`, rt)
		c("else:")
		p("stop", "semiont-ollama")
		c("require free port: 11434")
		p(ollamaArgs("<ollama-volume>")...)
		c("wait: http://localhost:11434/api/version (30s)")
	case "postgres":
		p(postgresArgs()...)
		c("wait: tcp localhost:5432 (20s)")
		c("probe: %s run --rm busybox:1.38.0 nc -z -w 2 <host-addr> 5432", rt)
	case "backend":
		var admin []string
		if opts.adminEmail != "" {
			admin = []string{"--env", "ADMIN_EMAIL=" + opts.adminEmail, "--env", "ADMIN_PASSWORD=<admin-password>"}
		}
		p(backendArgs("<kb-root>", stage, addr, "<worker-secret>", version, userEnv, otel, admin)...)
		c("wait: http://localhost:4000/api/health (120s)")
		c(`probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://<host-addr>:4000/api/health" (up to 20 tries)`, rt)
	case "worker", "smelter", "weaver":
		for _, sc := range sidecarSpecs {
			if sc.svc == svc {
				p(sidecarArgs(sc.svc, sc.mem, sc.port, stage, addr, "<worker-secret>", version, userEnv, otel)...)
				c("wait: http://localhost:%d/health (30s)", sc.port)
			}
		}
	case "frontend":
		p(frontendArgs(version)...)
		c("wait: http://localhost:3000 (30s)")
	}
}
