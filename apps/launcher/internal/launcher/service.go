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

// The launcher's primary vocabulary is the ROLE a container plays in the
// stack: database, graph, vectors, inference, traces — plus Semiont's own services
// by name. The concrete product behind an infra role (PostgreSQL, Neo4j, …)
// and its image string are DETAIL, shown where there's room for it (banners,
// echoed argv, error messages); container names and config env vars stay at
// the wire level (semiont-postgres, NEO4J_HOST) — they're shared contracts
// with compose and the running fleet.
type portNeed struct {
	port  int
	label string
}

type roleSpec struct {
	product   string // concrete product behind an infra role; "" = a Semiont service
	container string
	ports     []portNeed // must-be-free ports (inference: owned by startInference)
}

var roles = map[string]roleSpec{
	"traces":    {"Jaeger", "semiont-jaeger", []portNeed{{16686, "Jaeger UI"}, {4318, "Jaeger OTLP"}}},
	"graph":     {"Neo4j", "semiont-neo4j", []portNeed{{7474, "Neo4j HTTP"}, {7687, "Neo4j Bolt"}}},
	"vectors":   {"Qdrant", "semiont-qdrant", []portNeed{{6333, "Qdrant"}}},
	"inference": {"Ollama", "semiont-ollama", nil},
	"database":  {"PostgreSQL", "semiont-postgres", []portNeed{{5432, "PostgreSQL"}}},
	"backend":   {"", "semiont-backend", []portNeed{{4000, "Backend"}}},
	"worker":    {"", "semiont-worker", []portNeed{{9090, "Worker"}}},
	"smelter":   {"", "semiont-smelter", []portNeed{{9091, "Smelter"}}},
	"weaver":    {"", "semiont-weaver", []portNeed{{9092, "Weaver"}}},
	"frontend":  {"", "semiont-frontend", []portNeed{{3000, "Frontend"}}},
}

const roleList = "backend, worker, smelter, weaver, frontend, database, graph, vectors, inference, or traces"

// roleByContainer inverts the roles table (container name → role).
var roleByContainer = func() map[string]string {
	m := make(map[string]string, len(roles))
	for r, s := range roles {
		m[s.container] = r
	}
	return m
}()

// roleTitle is the detail-bearing display form: the role, with the product
// in parens when there is one ("graph (Neo4j)").
func roleTitle(role string) string {
	if p := roles[role].product; p != "" {
		return role + " (" + p + ")"
	}
	return role
}

func isConfigConsumer(svc string) bool {
	return svc == "backend" || svc == "worker" || svc == "smelter" || svc == "weaver"
}

func serviceNeedsAddr(svc string) bool {
	return isConfigConsumer(svc) || svc == "database" || svc == "inference"
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
	cname := roles[svc].container

	u.banner("Restarting " + roleTitle(svc))

	// The service's own teardown (idempotent across running/stopped/absent) —
	// except inference, whose start path owns this (a host Ollama may make
	// the container unnecessary).
	if svc != "inference" {
		stopped := runSilent(rt, "stop", cname) == nil
		rmed := runSilent(rt, "rm", cname) == nil
		if stopped || rmed {
			u.log("Removed prior %s container", svc)
			time.Sleep(time.Second)
		}
		for _, pc := range roles[svc].ports {
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
	var id string
	var img string
	hostReuse := false
	ok := false
	switch svc {
	case "traces":
		args := tracesArgs()
		img = args[len(args)-1]
		id, d, ok = runGated(u, rt, args, "traces (Jaeger)", "traces (Jaeger UI)", "http://localhost:16686", 30)
	case "graph":
		args := graphArgs()
		img = args[len(args)-1]
		id, d, ok = runGated(u, rt, args, "graph (Neo4j)", "graph (Neo4j)", "http://localhost:7474", 30)
	case "vectors":
		args := vectorsArgs()
		img = args[len(args)-1]
		id, d, ok = runGated(u, rt, args, "vectors (Qdrant)", "vectors (Qdrant)", "http://localhost:6333/readyz", 15)
	case "inference":
		var code int
		id, hostReuse, code = startInference(u, rt, addr, opts)
		if code != 0 {
			return code
		}
		if !hostReuse {
			img = "ollama/ollama"
		}
		ok = true
	case "database":
		args := dbArgs()
		img = args[len(args)-1]
		u.echoCmd(rt, args...)
		var err error
		id, err = runDetached(rt, args...)
		if err != nil {
			u.fail("database (PostgreSQL) failed to start.")
			return 1
		}
		d, ok = waitForPG(u, rt, addr, 5432, 20)
	case "backend":
		var admin []string
		if opts.adminEmail != "" && opts.adminPassword != "" {
			admin = []string{"--env", "ADMIN_EMAIL=" + opts.adminEmail, "--env", "ADMIN_PASSWORD=" + opts.adminPassword}
		}
		var code int
		id, code = runBackend(u, rt, root, stage, addr, secret, version, userEnv, otel, admin)
		if code != 0 {
			return code
		}
		img = image("backend", version)
		ok = true
	case "worker", "smelter", "weaver":
		for _, sc := range sidecarSpecs {
			if sc.svc == svc {
				var code int
				id, code = runSidecar(u, rt, sc, stage, addr, secret, version, userEnv, otel)
				if code != 0 {
					return code
				}
				img = image(svc, version)
			}
		}
		ok = true
	case "frontend":
		img = image("frontend", version)
		id, d, ok = runGated(u, rt, frontendArgs(version), "Frontend", "Frontend", "http://localhost:3000", 30)
	}
	if !ok {
		return 1
	}
	if d > 0 {
		u.ok("%s healthy %s", svc, u.dim("("+took(d)+")"))
	}

	// Update the belief record: this service's entry replaces its predecessor;
	// the rest of the record (untouched services) stands.
	st := loadState()
	if st == nil {
		st = &stackState{Runtime: rt, Version: version, Services: map[string]serviceState{}}
	}
	st.recordService(svc, id, img, hostReuse)

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
	if svc != "inference" {
		p("stop", roles[svc].container)
		p("rm", roles[svc].container)
		ports := make([]string, 0, 2)
		for _, pc := range roles[svc].ports {
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
	case "traces":
		p(tracesArgs()...)
		c("wait: http://localhost:16686 (30s)")
	case "graph":
		p(graphArgs()...)
		c("wait: http://localhost:7474 (30s)")
	case "vectors":
		p(vectorsArgs()...)
		c("wait: http://localhost:6333/readyz (15s)")
	case "inference":
		c("probe: host Ollama at http://localhost:11434/api/version")
		c(`if present — probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://<host-addr>:11434/api/version" — and use it`, rt)
		c("else:")
		p("stop", "semiont-ollama")
		c("require free port: 11434")
		p(inferenceArgs("<ollama-volume>")...)
		c("wait: http://localhost:11434/api/version (30s)")
	case "database":
		p(dbArgs()...)
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
