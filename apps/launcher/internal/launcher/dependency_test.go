package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// LAUNCHER-SERVICE-MODEL P2. The start order used to be three lists that
// disagreed: a call sequence in flowFullStart, a preflight sweep, a teardown
// sweep, and a prose comment describing a fourth. There is now ONE order and
// a set of edges it must respect.

// The edges are the contract; the order is one legal reading of it. This is
// the test that says so, and the one that fails if somebody moves a role
// above something it needs.
func TestStartOrderRespectsEveryDependency(t *testing.T) {
	for _, role := range startOrder {
		at := startRank(role)
		for _, dep := range dependenciesOf(role) {
			need := startRank(dep.role)
			if need < 0 {
				t.Errorf("%q needs %q, which is not a role", role, dep.role)
				continue
			}
			if need >= at {
				t.Errorf("%q starts at %d but needs %q, which starts at %d — the walk would bring it up against a dependency that is not there yet",
					role, at, dep.role, need)
			}
		}
	}
}

// One order, one role set. The descriptor table and the start walk must name
// the same roles or one of them is a list somebody forgot to update.
func TestStartOrderIsExactlyTheDescriptorRoles(t *testing.T) {
	inTable := map[string]bool{}
	for _, d := range serviceDescriptors {
		inTable[d.role] = true
	}
	seen := map[string]bool{}
	for _, r := range startOrder {
		if !inTable[r] {
			t.Errorf("the start walk brings up %q, which no descriptor describes", r)
		}
		if seen[r] {
			t.Errorf("%q appears twice in the start walk", r)
		}
		seen[r] = true
	}
	for r := range inTable {
		if !seen[r] {
			t.Errorf("%q is described but never started — it would be swept at preflight and never come back", r)
		}
	}
}

// D4: the teardown order is never written down. It is this, and only this.
func TestTeardownIsTheStartWalkReversed(t *testing.T) {
	if len(teardownOrder) != len(startOrder) {
		t.Fatalf("teardown covers %d roles, the start walk %d", len(teardownOrder), len(startOrder))
	}
	for i, r := range teardownOrder {
		if want := startOrder[len(startOrder)-1-i]; r != want {
			t.Fatalf("teardownOrder[%d] = %q, want %q — teardown is the start walk reversed, not a list of its own", i, r, want)
		}
	}
}

// The teardown order, spelled out. It is not what shipped before P2: the old
// hand-written list tore the Archivist down FIRST, ahead of the weaver,
// smelter and worker that dial it at every request — a list calling itself
// "reverse start order" while putting a dependency ahead of its dependents.
// Reversing the start walk cannot make that mistake.
func TestStopSweepDerivesTheTeardownOrder(t *testing.T) {
	assertNames(t, "stopNames", stopNames, []string{
		"semiont-weaver", "semiont-smelter", "semiont-worker",
		"semiont-dispatcher", "semiont-librarian", "semiont-archivist",
		"semiont-ollama", "semiont-qdrant", "semiont-neo4j",
		"semiont-gateway", "semiont-keycloak", "semiont-nats", "semiont-postgres",
		"semiont-otel-collector", "semiont-prometheus", "semiont-jaeger",
	})
}

func TestPreflightSweepDerivesTheTeardownOrder(t *testing.T) {
	assertNames(t, "preflightNames", preflightNames, []string{
		"semiont-weaver", "semiont-smelter", "semiont-worker",
		"semiont-dispatcher", "semiont-librarian", "semiont-archivist",
		"semiont-qdrant", "semiont-neo4j",
		"semiont-gateway", "semiont-keycloak", "semiont-nats", "semiont-postgres",
		"semiont-otel-collector", "semiont-prometheus", "semiont-jaeger",
	})
}

// A requirement is the subset of edges a config cannot leave unanswered
// (O1). Today exactly one driver has one, and the refusal derivePlan raises
// is rendered FROM it — so this is the only home for the sentence.
func TestOnlyKeycloakRequiresARoleItCannotRunWithout(t *testing.T) {
	var got []string
	for _, d := range serviceDescriptors {
		for _, dep := range d.needs {
			if dep.because == "" {
				continue
			}
			got = append(got, d.role+"/"+d.driver+" → "+dep.role)
			if startRank(dep.role) < 0 {
				t.Errorf("%s/%s requires %q, which is not a role", d.role, d.driver, dep.role)
			}
		}
	}
	assertNames(t, "requirements", got, []string{"identity/keycloak → database"})
}

// declaresRole must be able to answer for every role a requirement names —
// its default is "not declared", so a role it does not know would refuse
// every config that has one.
func TestEveryRequiredRoleIsDeclarable(t *testing.T) {
	full := &envConfig{
		Graph: &graphCfg{}, Vectors: &vectorsCfg{}, Embedding: &embeddingCfg{},
		Database: &databaseCfg{}, Jobs: &jobsCfg{}, Identity: &identityCfg{},
		Inference: map[string]providerCfg{"x": {}}, Gateway: &gatewayCfg{},
	}
	for _, d := range serviceDescriptors {
		for _, dep := range d.needs {
			if dep.because == "" {
				continue
			}
			if !full.declaresRole(dep.role) {
				t.Errorf("%s/%s requires %q, but declaresRole cannot see it even in a config that declares everything — every config would be refused",
					d.role, d.driver, dep.role)
			}
		}
	}
}

// An ordering-only edge must stay ordering-only: declaring a `because` on
// one turns a role the config may legitimately omit into a refusal.
func TestOrderingEdgesDoNotRefuse(t *testing.T) {
	declaresNothing := func(string) bool { return false }
	for _, d := range serviceDescriptors {
		dep, unmet := unmetRequirement(declaresNothing, d.role, d.driver)
		if unmet && dep.role != "database" {
			t.Errorf("%s/%s refuses a config that omits %q; only a driver that truly cannot run without a role may",
				d.role, d.driver, dep.role)
		}
	}
}

// The declared start order is only worth anything if the start flow actually
// walks it. flowFullStart is hand-written calls, so the proof is the
// transcript it produces: the dry-run goldens record every `run -d --name`
// in the exact order a real run would issue it. Each container maps back to
// its role, and those roles must appear in startOrder's relative order.
//
// This is what keeps startOrder from becoming a fourth statement of the
// order nobody checks — the failure mode P2 exists to end. It reaches into
// the root package's testdata deliberately: the goldens are the only place
// the flow's real sequence is written down. P4 makes the flow walk the list
// directly and this test becomes a tautology worth deleting.
func TestDryRunLaunchOrderFollowsTheDeclaredStartOrder(t *testing.T) {
	for _, golden := range []string{
		"start-dryrun-default.txt",
		"start-dryrun-local.txt",
		"start-dryrun-keycloak-identity.txt",
	} {
		body, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", golden))
		if err != nil {
			t.Fatalf("%s: %v", golden, err)
		}
		launched := []string{}
		for _, line := range strings.Split(string(body), "\n") {
			_, rest, ok := strings.Cut(line, " run -d --name ")
			if !ok {
				continue
			}
			name, _, _ := strings.Cut(rest, " ")
			role, known := roleByContainer[name]
			if !known {
				t.Errorf("%s launches %s, which belongs to no role", golden, name)
				continue
			}
			launched = append(launched, role)
		}
		if len(launched) < 2 {
			t.Fatalf("%s: found %d launches — the golden's shape changed and this test stopped reading it", golden, len(launched))
		}
		for i := 1; i < len(launched); i++ {
			if startRank(launched[i-1]) >= startRank(launched[i]) {
				t.Errorf("%s brings up %q before %q; the declared start order has them the other way round — the flow and the list disagree, which is the drift P2 removed",
					golden, launched[i-1], launched[i])
			}
		}
	}
}

// mayConfigure looks the role up by rp.Role, so every plan row must name the
// role it is filed under. A row that does not would be read as a role with
// no descriptor — authority zero, permission refused — and the refusal would
// look like policy rather than a missing field.
func TestEveryPlanRowNamesItsRole(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, nil))
	if len(plan.Roles) == 0 {
		t.Fatal("no roles in the derived plan")
	}
	for key, rp := range plan.Roles {
		if rp.Role != key {
			t.Errorf("plan.Roles[%q].Role = %q — mayConfigure would look up the wrong descriptor, and its refusal would read as policy rather than a missing field", key, rp.Role)
		}
	}
}

// The authority the code already draws, asserted rather than described: a
// service we run is ours; a host Ollama may be configured within; an
// external PostgreSQL and an issuer somebody else runs may only be watched.
func TestAuthorityMatchesTheLinesTheCodeDraws(t *testing.T) {
	for _, c := range []struct {
		label string
		rp    rolePlan
		want  bool
	}{
		{"a PostgreSQL we run", rolePlan{Role: "database", Driver: "postgres", Presence: presenceLauncher}, true},
		{"somebody else's PostgreSQL", rolePlan{Role: "database", Driver: "postgres", Presence: presenceExternal}, false},
		{"a Keycloak we run", rolePlan{Role: "identity", Driver: "keycloak", Presence: presenceLauncher}, true},
		{"somebody else's Keycloak", rolePlan{Role: "identity", Driver: "keycloak", Presence: presenceExternal}, false},
		{"an issuer that is not ours", rolePlan{Role: "identity", Driver: "oidc", Presence: presenceExternal}, false},
		{"a host Ollama", rolePlan{Role: "inference", Driver: "ollama", Presence: presenceHostPreferred}, true},
		{"a remote Anthropic", rolePlan{Role: "inference", Driver: "anthropic", Presence: presenceExternal}, false},
	} {
		if got := mayConfigure(c.rp); got != c.want {
			t.Errorf("mayConfigure(%s) = %v, want %v", c.label, got, c.want)
		}
	}
}
