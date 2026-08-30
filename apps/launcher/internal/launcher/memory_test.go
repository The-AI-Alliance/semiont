package launcher

import (
	"strings"
	"testing"
)

// Every containered role carries an explicit ceiling — the silent default is
// the worst value on both runtimes (1G-quietly on Apple container, unlimited
// on docker). embedding is the one legitimate blank: it has no container.
func TestEveryContaineredRoleHasAMemoryCeiling(t *testing.T) {
	for role, spec := range roles {
		if spec.container == "" {
			continue
		}
		if spec.mem == "" {
			t.Errorf("role %q (%s) has no memory ceiling — it would get the runtime's silent default", role, spec.container)
		}
		if memCeilingGB(spec.mem) <= 0 {
			t.Errorf("role %q ceiling %q does not parse — the preflight would undercount", role, spec.mem)
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

// The sum mirrors what a start actually runs: base services always; infra by
// obligation; ollama once whichever role provides it; traces with --observe.
func TestStartCeilingsGB(t *testing.T) {
	base := startCeilingsGB(nil, startOptions{})
	// gateway 8 + worker 2 + smelter 2 + weaver 3 + archivist 2 + librarian 2 + browser 1
	if base != 20 {
		t.Fatalf("base ceilings = %vG, want 20G (did a service's ceiling change without this test?)", base)
	}
	plan := &launchPlan{Roles: map[string]rolePlan{
		"graph":     {Obligation: obligationProvided},
		"vectors":   {Obligation: obligationProvided},
		"database":  {Obligation: obligationProvided},
		"inference": {Driver: "ollama", Obligation: obligationProvided},
	}}
	full := startCeilingsGB(plan, startOptions{observe: true})
	// + graph 2 + vectors 2 + database 1 + ollama 8 + traces 1
	if full != 34 {
		t.Fatalf("full ceilings = %vG, want 34G", full)
	}
	// An external inference (anthropic) runs no Ollama container.
	plan.Roles["inference"] = rolePlan{Driver: "anthropic", Obligation: obligationExternal}
	if got := startCeilingsGB(plan, startOptions{}); got != 25 {
		t.Fatalf("external-inference ceilings = %vG, want 25G", got)
	}
	// THE DEFAULT: host-process Ollama (models get Metal on the host; the
	// container is the fallback). Its host RAM is outside this sum — the
	// launcher neither sets nor sees it — so the default stack is 23G too.
	plan.Roles["inference"] = rolePlan{Driver: "ollama", Obligation: obligationHostProcess}
	if got := startCeilingsGB(plan, startOptions{}); got != 25 {
		t.Fatalf("host-ollama (default) ceilings = %vG, want 25G — the host process must not be counted", got)
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
