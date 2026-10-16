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
	"sort"
	"strconv"
	"strings"
)

// parseCeilingGB reads a ceiling as the table and an environment's [memory]
// write it, and as every runtime's --memory takes it: a whole number of
// gigabytes ("8G") or of megabytes ("512M"). ok is false for any other shape,
// and for a ceiling that is not above zero.
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
// a bug the completeness test catches, and loadConfig has refused an
// environment's value that does not parse.
func memCeilingGB(m string) float64 {
	gb, _ := parseCeilingGB(m)
	return gb
}

// memoryFor: the --memory ceiling one of the stack's services runs with —
// what the environment's [memory] states for it, or the table's. ONE decider,
// read by each service's run arguments, the memory preflight, the gateway's
// capacity and the Smelter's PDFs at once. stated is the environment's
// [memory] as loadConfig let it through: every key a stack service, every
// value a ceiling.
func memoryFor(stated map[string]string, svc string) string {
	if ceiling, ok := stated[svc]; ok {
		return ceiling
	}
	return semiontDescriptor(svc).mem
}

// refuseMemory refuses an environment's [memory] that names anything but a
// stack service, or states a ceiling that does not parse. Left alone, a
// misspelt service would size nothing and a shape --memory does not take
// would fail the start at the runtime, without saying which line was wrong.
func refuseMemory(env *envConfig, path, envName string) error {
	names := make([]string, 0, len(env.Memory))
	for name := range env.Memory {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !contains(stackServices, name) {
			return fmt.Errorf("%s: [environments.%s.memory] names %s, which is none of the stack's services: it sizes %s",
				path, envName, name, strings.Join(stackServices, ", "))
		}
		if _, ok := parseCeilingGB(env.Memory[name]); !ok {
			return fmt.Errorf("%s: [environments.%s.memory] %s = %q: write a ceiling as \"8G\" or \"512M\"",
				path, envName, name, env.Memory[name])
		}
	}
	return nil
}

// startCeilingsGB sums the --memory ceilings THIS start will actually
// request. The list mirrors the flow: the stack's services the plan runs, at
// the ceilings its environment gives them (memoryFor), and the Browser;
// provided infra roles come from the plan, at the table's; traces rides
// --observe; one Ollama runs when either the inference or the embedding role
// provides it as a container.
func startCeilingsGB(plan *launchPlan, opts startOptions) float64 {
	sum := 0.0
	var stated map[string]string
	if plan != nil {
		stated = plan.Memory
	}
	for _, svc := range stackServices {
		if plan != nil && !plan.runs(svc) {
			continue
		}
		sum += memCeilingGB(memoryFor(stated, svc))
	}
	sum += memCeilingGB(semiontDescriptor("browser").mem)
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
		"Memory ceilings total %.1fG of this machine's %.0fG. On Apple container each ceiling sizes a per-container VM, so the stack can grow toward that total — expect pressure (compression, swap). Each container's ceiling is on its --dry-run line, and an environment's [memory] sets those of the stack's own services.",
		sumGB, hostGB)
}
