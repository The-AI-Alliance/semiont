package launcher

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// service.go — the `--service` half of the lifecycle verbs.
//
// The launcher's primary vocabulary is the ROLE a container plays in the
// stack: identity-store, graph, vectors, inference, traces — plus Semiont's own
// services by name. The concrete product behind an infra role (PostgreSQL,
// Neo4j, …) belongs to its DRIVER, and both live in descriptors.go;
// container names and config env vars stay at the wire level
// (semiont-<kb>-postgres, NEO4J_HOST) — they're shared contracts with every
// running stack, local or inside a codespace.

// isConfigConsumer: is this role staged a resolved document for its start?
// Exactly Semiont's own stack services — the same list that is pulled and
// that holds realm accounts.
func isConfigConsumer(svc string) bool { return contains(stackServices, svc) }

// serviceNeedsAddr: does this role's start use the host address? Every stack
// service's does (the addresses its document states), and so do the roles the
// launcher reaches or configures through it: the worker, whose document
// states where it reaches each knowledge base, the identity store and the broker
// it waits on from a container's side, the Ollama it probes from one (owned
// by inference or embedding), the identity provider whose KC_DB_URL names the
// PostgreSQL, the collector whose document names Jaeger, and Prometheus, whose
// document names the collector. Where publishes are confined, every role
// publishes a port on it.
func serviceNeedsAddr(svc string, e exposure) bool {
	return e.confined() || isConfigConsumer(svc) ||
		contains([]string{"worker", "identity-store", "messaging", "inference", "embedding", "identity", "collector", "metrics"}, svc)
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

// runStartService: the live `start --service` and `start --group` —
// flowServices with liveExec, plus the live-only rocket summary (skipped when
// every service is an external/absent no-op, which launches nothing).
func runStartService(u *UI, rt, lan string, kb kbRoot, opts startOptions, userEnv []string, st *stack.Stack, plan *launchPlan, browser browserDocument) int {
	t0 := time.Now()
	x := &liveExec{u: u, rt: rt, kb: kb, plan: plan, lan: lan}
	if code := flowServices(x, flowCtx{plan: plan, stack: st, opts: opts, kb: kb, userEnv: userEnv, restart: true, browser: browser}); code != 0 {
		return code
	}
	if !slices.ContainsFunc(opts.starts, func(m groupMember) bool {
		_, nothing := nothingToLaunch(plan, m.role)
		return !nothing
	}) {
		return 0
	}
	_, name, _ := strings.Cut(opts.asked(), " ")
	detail := took(time.Since(t0))
	if opts.group.shared() {
		detail = "it serves every KB here; " + detail
	}
	fmt.Println()
	fmt.Printf("%s  %s\n", u.Wrap(AnsiBold+AnsiGreen, "🚀 "+name+" is up"), u.Dim("("+detail+")"))
	fmt.Printf("  Check health:  %s\n", u.Bold("semiont status"))
	return 0
}

// renderServicePlan is --dry-run for --service and --group: the same flow,
// plan mode.
// Real root for the same reason as renderStartPlan: the state path is
// plan-time truth; the kb mount keeps its placeholder via val().
func renderServicePlan(rt, lan string, kb kbRoot, opts startOptions, userEnv []string, st *stack.Stack, plan *launchPlan, browser browserDocument) {
	x := &planExec{rt: rt, lan: lan, kb: kb}
	x.c("semiont start %s --dry-run — the exact runtime commands a real", opts.asked())
	x.c("run would execute, in order. Values known only at runtime appear as <placeholders>.")
	x.stateHomeDocumentWrites(browser, plan)
	flowServices(x, flowCtx{plan: plan, stack: st, opts: opts, kb: kb, userEnv: userEnv, restart: true, browser: browser})
}
