package launcher

import (
	"strings"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// renderCmd prints one runtime invocation the way a shell would take it,
// quoting args that contain whitespace (the sh -c scripts).
func renderCmd(rt string, args ...string) string {
	parts := []string{rt}
	for _, a := range args {
		if strings.ContainsAny(a, " \t") {
			a = `"` + a + `"`
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

// renderStartPlan is the --dry-run output: the same full-start flow walked
// in plan mode. This is the legible account of what a start runs — and the
// extraction seam for the stack-parity gate. It takes the REAL kb
// root: paths derivable at plan time (the per-root state dir) print as
// truth; the kb mount still renders "<kb-root>" via val(), the seam for
// values the flow treats as runtime-scoped.
func renderStartPlan(rt, lan string, kb kbRoot, opts startOptions, userEnv []string, st *stack.Stack, plan *launchPlan) {
	x := &planExec{rt: rt, lan: lan}
	x.c("semiont start --dry-run — the exact runtime commands a real run would")
	x.c("execute, in order. Values known only at runtime appear as <placeholders>.")
	flowFullStart(x, flowCtx{plan: plan, stack: st, opts: opts, kb: kb, userEnv: userEnv})
	if lan != "" {
		x.c("network lan: the gateway answers the network at %s:%d, over plain HTTP", lan, plan.GatewayPort)
		if rp := plan.Roles["identity"]; rp.Presence == presenceLauncher {
			x.c("network lan: the issuer answers it at %s, through the issuer proxy", identityEndpoint(rp, x.exposure("<host-addr>")))
		}
	}
}
