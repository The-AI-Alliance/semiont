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
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// memCeilingGB parses a roles-table ceiling ("8G", "512M") into GB. Unknown
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
// the Semiont services and the Browser always run; provided infra roles come
// from the plan; traces rides --observe; one Ollama runs when either the
// inference or the embedding role provides it as a container.
func startCeilingsGB(plan *launchPlan, opts startOptions) float64 {
	sum := 0.0
	for _, svc := range []string{"gateway", "worker", "smelter", "weaver", "archivist", "librarian", "browser", "collector"} {
		sum += memCeilingGB(roles[svc].mem)
	}
	if opts.observe {
		sum += memCeilingGB(roles["traces"].mem)
		sum += memCeilingGB(roles["metrics"].mem)
	}
	if plan == nil {
		return sum
	}
	for _, role := range []string{"graph", "vectors", "database"} {
		if plan.Roles[role].Obligation == obligationProvided {
			sum += memCeilingGB(roles[role].mem)
		}
	}
	inf, emb := plan.Roles["inference"], plan.Roles["embedding"]
	if (inf.Driver == "ollama" && inf.Obligation == obligationProvided) ||
		(emb.Driver == "ollama" && emb.Obligation == obligationProvided) {
		sum += memCeilingGB(roles["inference"].mem)
	}
	return sum
}

// memoryBudgetWarning renders the preflight verdict, or "" when the sum fits.
// Split from the sysctl read so the threshold and wording are testable with
// an injected host size.
func memoryBudgetWarning(sumGB, hostGB float64) string {
	if hostGB <= 0 || sumGB <= hostGB*0.75 {
		return ""
	}
	return fmt.Sprintf(
		"Memory ceilings total %.1fG of this machine's %.0fG. On Apple container each ceiling sizes a per-container VM, so the stack can grow toward that total — expect pressure (compression, swap). Each container's ceiling is on its --dry-run line; the gateway's %s is the largest fixed one.",
		sumGB, hostGB, roles["gateway"].mem)
}

// hostMemGB reads the machine's physical memory: sysctl on darwin,
// /proc/meminfo elsewhere. 0 = unknown, which silences the preflight rather
// than warning on garbage.
func hostMemGB() float64 {
	if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
		if b, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64); err == nil && b > 0 {
			return b / (1 << 30)
		}
	}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if kb, ok := strings.CutPrefix(line, "MemTotal:"); ok {
				f := strings.Fields(kb)
				if len(f) > 0 {
					if n, err := strconv.ParseFloat(f[0], 64); err == nil {
						return n / (1 << 20)
					}
				}
			}
		}
	}
	return 0
}
