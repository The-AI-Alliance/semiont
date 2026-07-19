package launcher

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
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
	ports     []portNeed // must-be-free ports (inference: owned by flowInference)
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

// runStartService: the live `start --service` — flowOneService with
// liveExec, plus the live-only rocket summary (skipped for the external/
// absent no-ops, which launch nothing).
func runStartService(u *ui, rt, version, root, configFile string, opts startOptions, userEnv []string, plan *launchPlan) int {
	t0 := time.Now()
	x := &liveExec{u: u, rt: rt}
	if code := flowOneService(x, flowCtx{plan: plan, opts: opts, version: version, root: root, configFile: configFile, userEnv: userEnv}); code != 0 {
		return code
	}
	if plan != nil {
		if rp, ok := plan.Roles[opts.service]; ok && (rp.Obligation == obligationExternal || rp.Obligation == obligationAbsent) {
			return 0
		}
	}
	fmt.Println()
	fmt.Printf("%s  %s\n", u.wrap(ansiBold+ansiGreen, "🚀 "+opts.service+" is up"), u.dim("("+took(time.Since(t0))+")"))
	fmt.Printf("  Check health:  %s\n", u.bold("semiont status"))
	return 0
}

// renderServicePlan is --dry-run for --service: the same flow, plan mode.
func renderServicePlan(rt, version string, opts startOptions, userEnv []string, plan *launchPlan) {
	x := &planExec{rt: rt}
	x.c("semiont start --service %s --dry-run — the exact runtime commands a real", opts.service)
	x.c("run would execute, in order. Values known only at runtime appear as <placeholders>.")
	flowOneService(x, flowCtx{plan: plan, opts: opts, version: version, root: "<kb-root>", configFile: opts.configName, userEnv: userEnv})
}

// serviceEndpoint: the health endpoint status should probe for a service the
// launcher just (re)started. plan is nil only for frontend/traces (config-free).
func serviceEndpoint(svc string, plan *launchPlan) string {
	switch svc {
	case "traces":
		return "http://localhost:16686"
	case "frontend":
		return "http://localhost:3000"
	case "backend":
		return fmt.Sprintf("http://localhost:%d/api/health", plan.BackendPort)
	case "worker":
		return "http://localhost:9090/health"
	case "smelter":
		return "http://localhost:9091/health"
	case "weaver":
		return "http://localhost:9092/health"
	case "graph":
		return fmt.Sprintf("http://localhost:%d", plan.AuxPorts("graph")[0].port)
	case "vectors":
		return fmt.Sprintf("http://localhost:%d/readyz", plan.Roles[svc].Port)
	case "inference":
		return fmt.Sprintf("http://localhost:%d/api/version", plan.Roles[svc].Port)
	case "database":
		return fmt.Sprintf("tcp:localhost:%d", plan.Roles[svc].Port)
	}
	return ""
}
