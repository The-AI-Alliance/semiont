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
// Known boundary: a HOST-run Ollama (the default — host-process is preferred
// so models get Metal) uses host RAM this sum cannot see. The ollama ceiling
// enters the sum only in the container-fallback case, which is also the only
// case the launcher controls.

import (
	"fmt"
	"strconv"
	"strings"
)

// memCeilingGB parses a descriptor ceiling ("8G", "512M") into GB. Unknown
// shapes count as zero — the table is ours, so a new suffix is a bug the
// completeness test catches, not a runtime concern.
func memCeilingGB(m string) float64 {
	if v, ok := strings.CutSuffix(m, "G"); ok {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n
		}
	}
	if v, ok := strings.CutSuffix(m, "M"); ok {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n / 1024
		}
	}
	return 0
}

// startCeilingsGB sums the --memory ceilings THIS start will actually
// request, from the one table that defines them. The list mirrors the flow:
// the Semiont services the plan runs, and the Browser; provided infra roles
// come from the plan; traces rides --observe; one Ollama runs when either the
// inference or the embedding role provides it as a container.
func startCeilingsGB(plan *launchPlan, opts startOptions) float64 {
	sum := 0.0
	for _, svc := range []string{"gateway", "worker", "smelter", "weaver", "archivist", "librarian", "dispatcher", "browser"} {
		if plan != nil && !plan.runs(svc) {
			continue
		}
		sum += memCeilingGB(semiontDescriptor(svc).mem)
	}
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
		if plan.Roles[role].Presence == presenceLauncher {
			sum += memCeilingGB(descriptorFor(role, plan.Roles[role].Driver).mem)
		}
	}
	inf, emb := plan.Roles["inference"], plan.Roles["embedding"]
	if (inf.Driver == "ollama" && inf.Presence == presenceLauncher) ||
		(emb.Driver == "ollama" && emb.Presence == presenceLauncher) {
		sum += memCeilingGB(descriptorFor("inference", "ollama").mem)
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
		"Memory ceilings total %.1fG of this machine's %.0fG. On Apple container each ceiling sizes a per-container VM, so the stack can grow toward that total — expect pressure (compression, swap). Each container's ceiling is on its --dry-run line; the gateway's %s is the largest fixed one.",
		sumGB, hostGB, semiontDescriptor("gateway").mem)
}
