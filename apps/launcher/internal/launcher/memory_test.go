package launcher

import (
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// Every container-bearing driver carries an explicit ceiling — the silent
// default is the worst value on both runtimes (1G-quietly on Apple
// container, unlimited on docker). The drivers that launch nothing (oidc,
// anthropic, voyage, a shared Ollama) are the legitimate blanks.
func TestEveryContaineredDriverHasAMemoryCeiling(t *testing.T) {
	for _, d := range serviceDescriptors {
		if d.container == "" {
			continue
		}
		if d.mem == "" {
			t.Errorf("%s/%s (%s) has no memory ceiling — it would get the runtime's silent default", d.role, d.driver, d.container)
		}
		if memCeilingGB(d.mem) <= 0 {
			t.Errorf("%s/%s ceiling %q does not parse — the preflight would undercount", d.role, d.driver, d.mem)
		}
	}
}

func TestMemCeilingGB(t *testing.T) {
	for _, c := range []struct {
		in   string
		want float64
	}{{"8G", 8}, {"1G", 1}, {"512M", 0.5}, {"", 0}, {"weird", 0}} {
		if got := memCeilingGB(c.in); got != c.want {
			t.Errorf("memCeilingGB(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// The sum mirrors what a start actually runs: each service and daemon at the
// ceiling its document states, the Browser and the collector at the
// launcher's own, traces and metrics with --observe, and never the machine's
// Ollama.
func TestStartCeilingsGB(t *testing.T) {
	// A start with no stack (`--service browser`): the Browser's 1G and the
	// collector's 1G.
	if got := startCeilingsGB(nil, startOptions{}); got != 2 {
		t.Fatalf("a start with no stack asks %vG, want 2G", got)
	}
	// The fixture's documents: seven services at 2G; the graph and the vector
	// store at 2G, the Keycloak and its PostgreSQL at 1G, the broker at 512M;
	// and the Browser and the collector. Inference and embedding are the
	// machine's Ollama, which runs on the host.
	for _, inference := range []string{"ollama-gemma", "anthropic"} {
		plan := mustPlan(t, fixtureStack(t, inference))
		if got := startCeilingsGB(plan, startOptions{}); got != 22.5 {
			t.Errorf("%s: the fixture's stack asks %vG, want 22.5G", inference, got)
		}
		if got := startCeilingsGB(plan, startOptions{observe: true}); got != 24.5 {
			t.Errorf("%s: with --observe it asks %vG, want 24.5G: Jaeger's 1G and Prometheus's 1G more", inference, got)
		}
	}
}

// The ceiling a document states for a service is the one the sum counts.
func TestStartCeilingsCountTheCeilingsTheDocumentsState(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.KnowledgeIndex.Spec.Smelter.Resources.Limits.Memory = "8G"
	if got := startCeilingsGB(mustPlan(t, st), startOptions{}); got != 28.5 {
		t.Fatalf("ceilings with an 8G smelter = %vG, want 28.5G: the fixture's 22.5G with the smelter's 2G made 8G", got)
	}
}

// A stack without a worker requests no memory for one.
func TestStartCeilingsLeaveOutAnAbsentWorker(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	with := startCeilingsGB(mustPlan(t, st), startOptions{})
	st.Inference.Spec.Roster.Workers = semiont.ArchivistRoster{}.Workers
	without := startCeilingsGB(mustPlan(t, st), startOptions{})
	if with-without != 2 {
		t.Fatalf("ceilings with a worker %vG, without %vG: want them the WorkerPool's 2G apart", with, without)
	}
}

// The warning fires only past 75% of the host, and carries the arithmetic —
// numbers the operator can act on, not a vibe.
func TestMemoryBudgetWarning(t *testing.T) {
	if w := memoryBudgetWarning(18, 64); w != "" {
		t.Errorf("18G of 64G should be quiet, got %q", w)
	}
	if w := memoryBudgetWarning(0, 0); w != "" {
		t.Errorf("unknown host RAM must stay quiet (never warn on garbage), got %q", w)
	}
	w := memoryBudgetWarning(30, 16)
	if w == "" {
		t.Fatal("30G of 16G must warn")
	}
	for _, want := range []string{"30.0G", "16G", "per-container VM", "--dry-run"} {
		if !strings.Contains(w, want) {
			t.Errorf("warning missing %q:\n%s", want, w)
		}
	}
}
