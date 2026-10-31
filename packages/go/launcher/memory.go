package launcher

// memory.go — the memory preflight: does the sum of the ceilings this start
// is about to request fit the machine?
//
// The question only has teeth on Apple container, where every container is
// its own VM and --memory sizes it — the guest kernel and page cache grow
// into the allocation, so the sum of ceilings approximates a commitment. On
// docker/podman the containers share ONE VM sized in the runtime's own
// settings; --memory is a cgroup cap inside it, caps are not reservations,
// and their sum exceeding the VM is normal. So: warn on `container`, stay
// quiet elsewhere.
//
// A WARNING, never a refusal: macOS degrades under pressure rather than
// breaking, and the launcher cannot know what else the host runs.
//
// Known boundary: the machine's Ollama is never in the sum. A host-run one
// (preferred, so models get Metal) uses host RAM this sum cannot see.

import (
	"fmt"
	"strconv"
	"strings"
)

// parseCeilingGB reads a ceiling as the table and a document's
// resources.limits.memory write it, and as every runtime's --memory takes it:
// a whole number of gigabytes ("8G") or of megabytes ("512M"). ok is false for
// any other shape, and for a ceiling that is not above zero.
func parseCeilingGB(m string) (gb float64, ok bool) {
	for _, unit := range []struct {
		suffix string
		per    float64
	}{{"G", 1}, {"M", 1024}} {
		if v, cut := strings.CutSuffix(m, unit.suffix); cut {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				return float64(n) / unit.per, true
			}
		}
	}
	return 0, false
}

// memCeilingGB parses a ceiling the launcher holds into GB. A shape
// parseCeilingGB refuses counts as zero: the table is ours, so a new suffix is
// a bug the completeness test catches, and Resources.json's pattern refuses a
// document's value that does not parse.
func memCeilingGB(m string) float64 {
	gb, _ := parseCeilingGB(m)
	return gb
}

// startCeilingsGB sums the --memory ceilings THIS start will actually
// request. The list mirrors the flow: the stack's services the plan runs, at
// the ceilings their documents state (launchPlan.Memory), the Browser at its
// document's, and the collector; the daemons the launcher runs at the ceilings theirs state;
// traces and metrics ride --observe. The machine's Ollama is not counted: it
// is the host's when the host has one, and only a fallback container when it
// does not.
func startCeilingsGB(plan *launchPlan, browser browserDocument, opts startOptions) float64 {
	sum := 0.0
	if plan != nil {
		for _, svc := range stackServices {
			if plan.runs(svc) {
				sum += memCeilingGB(plan.Memory[svc])
			}
		}
	}
	sum += memCeilingGB(browser.spec.Resources.Limits.Memory)
	// The collector runs on every start too, but it is not one of ours:
	// --no-observe declines the backends, never the collector.
	sum += memCeilingGB(descriptorFor("collector", "otel").mem)
	if opts.observe {
		sum += memCeilingGB(descriptorFor("traces", "jaeger").mem)
		sum += memCeilingGB(descriptorFor("metrics", "prometheus").mem)
	}
	if plan == nil {
		return sum
	}
	for _, role := range []string{"graph", "vectors", "database", "messaging", "identity"} {
		if rp := plan.Roles[role]; rp.Presence == presenceLauncher {
			sum += memCeilingGB(rp.Memory)
		}
	}
	return sum
}

// memoryBudgetWarning renders the preflight verdict, or "" when the sum fits.
// Split from the read of the machine's memory (hostMemGB, per OS) so the
// threshold and wording are testable with an injected host size.
func memoryBudgetWarning(sumGB, hostGB float64) string {
	if hostGB <= 0 || sumGB <= hostGB*0.75 {
		return ""
	}
	return fmt.Sprintf(
		"Memory ceilings total %.1fG of this machine's %.0fG. On Apple container each ceiling sizes a per-container VM, so the stack can grow toward that total — expect pressure (compression, swap). Each container's ceiling is on its --dry-run line, and its document's resources.limits.memory sets it.",
		sumGB, hostGB)
}
