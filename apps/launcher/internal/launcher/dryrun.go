package launcher

import "strings"

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
// in plan mode. This is the legibility replacement for reading the old bash —
// and the extraction seam for the stack-parity gate. It takes the REAL kb
// root: paths derivable at plan time (the per-root state dir) print as
// truth; the kb mount still renders "<kb-root>" via val(), the seam for
// values the flow treats as runtime-scoped.
func renderStartPlan(rt, version, root string, opts startOptions, userEnv []string, plan *launchPlan) {
	x := &planExec{rt: rt}
	x.c("semiont start --dry-run — the exact runtime commands a real run would")
	x.c("execute, in order. Values known only at runtime appear as <placeholders>.")
	flowFullStart(x, flowCtx{plan: plan, opts: opts, version: version, root: root, configFile: opts.configName, userEnv: userEnv})
}
