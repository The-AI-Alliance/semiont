package launcher

import (
	"fmt"
	"time"
)

// service.go — the `--service` half of the lifecycle verbs.
//
// The launcher's primary vocabulary is the ROLE a container plays in the
// stack: database, graph, vectors, inference, traces — plus Semiont's own
// services by name. The concrete product behind an infra role (PostgreSQL,
// Neo4j, …) belongs to its DRIVER, and both live in descriptors.go;
// container names and config env vars stay at the wire level
// (semiont-postgres, NEO4J_HOST) — they're shared contracts with compose and
// the running fleet.

// isConfigConsumer: does this role mount a staged copy of the KB config?
// Exactly Semiont's own stack services — the same list that is pulled and
// that holds realm accounts.
func isConfigConsumer(svc string) bool { return contains(stackServices, svc) }

// serviceNeedsAddr: does this role's launch interpolate the host address?
// Every stack service does (the *_HOST environment they read), and so do the
// three third-party roles the launcher must reach or configure: the database
// it waits on, the Ollama it probes, and the identity provider whose
// KC_DB_URL names the PostgreSQL by address. identity was missing, so
// `start --service identity` built `jdbc:postgresql://:5432/keycloak`.
func serviceNeedsAddr(svc string) bool {
	return isConfigConsumer(svc) || svc == "database" || svc == "inference" || svc == "identity"
}

// digString walks a nested inspect entry for a string leaf.
func digString(m map[string]any, path ...string) (string, bool) {
	var cur any = m
	for _, k := range path {
		mm, ok := cur.(map[string]any)
		if !ok {
			return "", false
		}
		cur = mm[k]
	}
	s, ok := cur.(string)
	return s, ok
}

// runStartService: the live `start --service` — flowOneService with
// liveExec, plus the live-only rocket summary (skipped for the external/
// absent no-ops, which launch nothing).
func runStartService(u *UI, rt, version, root, configFile string, opts startOptions, userEnv []string, plan *launchPlan) int {
	t0 := time.Now()
	x := &liveExec{u: u, rt: rt, version: version, root: root, plan: plan}
	if code := flowOneService(x, flowCtx{plan: plan, opts: opts, version: version, root: root, configFile: configFile, userEnv: userEnv, restart: true}); code != 0 {
		return code
	}
	if plan != nil {
		if rp, ok := plan.Roles[opts.service]; ok && (rp.Presence == presenceExternal || rp.Presence == presenceAbsent) {
			return 0
		}
	}
	fmt.Println()
	fmt.Printf("%s  %s\n", u.Wrap(AnsiBold+AnsiGreen, "🚀 "+opts.service+" is up"), u.Dim("("+took(time.Since(t0))+")"))
	fmt.Printf("  Check health:  %s\n", u.Bold("semiont status"))
	return 0
}

// renderServicePlan is --dry-run for --service: the same flow, plan mode.
// Real root for the same reason as renderStartPlan: the state path is
// plan-time truth; the kb mount keeps its placeholder via val().
func renderServicePlan(rt, version, root string, opts startOptions, userEnv []string, plan *launchPlan) {
	x := &planExec{rt: rt}
	x.c("semiont start --service %s --dry-run — the exact runtime commands a real", opts.service)
	x.c("run would execute, in order. Values known only at runtime appear as <placeholders>.")
	flowOneService(x, flowCtx{plan: plan, opts: opts, version: version, root: root, configFile: opts.configName, userEnv: userEnv, restart: true})
}
