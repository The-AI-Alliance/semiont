package launcher

import (
	"sort"
	"strings"
	"testing"
)

// LAUNCHER-SERVICE-MODEL P1. Six enumerations used to restate the same facts
// in a mixed vocabulary — `roles` keyed by role and valued by technology,
// two sweep lists spelling container names out by hand, a status roster, a
// usage string, and the realm's client list. They are now predicates over
// ONE descriptor set, keyed by (role, driver).
//
// The literals below are the pre-P1 lists, frozen. They are not a second
// home for the facts: they are the evidence that the derivation reproduces
// what shipped, name for name and position for position. Delete a literal
// only together with the behaviour it pins.

func TestPreflightSweepDerivesTodaysNames(t *testing.T) {
	want := []string{
		"semiont-otel-collector", "semiont-prometheus", "semiont-jaeger", "semiont-neo4j", "semiont-qdrant", "semiont-nats", "semiont-postgres",
		"semiont-keycloak", "semiont-gateway", "semiont-worker", "semiont-smelter", "semiont-weaver",
		"semiont-archivist", "semiont-librarian", "semiont-dispatcher",
	}
	assertNames(t, "preflightNames", preflightNames, want)
}

func TestStopSweepDerivesTodaysNames(t *testing.T) {
	want := []string{
		"semiont-archivist", "semiont-weaver", "semiont-smelter", "semiont-worker",
		"semiont-librarian", "semiont-dispatcher",
		"semiont-gateway", "semiont-keycloak", "semiont-nats", "semiont-postgres", "semiont-ollama", "semiont-qdrant",
		"semiont-neo4j", "semiont-otel-collector", "semiont-prometheus", "semiont-jaeger",
	}
	assertNames(t, "stopNames", stopNames, want)
}

// The deliberate difference between the two sweeps, asserted as a PREDICATE
// rather than left to a reader diffing two lists: the stop sweep is the
// preflight sweep plus semiont-ollama. Start handles Ollama in its own
// section (a host instance may make the container unnecessary); stop has no
// such section and must still tear a container-fallback Ollama down.
func TestStopSweepIsPreflightPlusOllama(t *testing.T) {
	extra := map[string]bool{}
	for _, n := range stopNames {
		extra[n] = true
	}
	for _, n := range preflightNames {
		if !extra[n] {
			t.Errorf("%s is swept at start but never at stop — it survives the teardown", n)
		}
		delete(extra, n)
	}
	got := make([]string, 0, len(extra))
	for n := range extra {
		got = append(got, n)
	}
	sort.Strings(got)
	if len(got) != 1 || got[0] != "semiont-ollama" {
		t.Errorf("stop sweeps %v beyond the preflight; only semiont-ollama is a documented difference", got)
	}
}

// Every container the descriptor set can produce is swept by both lists,
// except the documented absences. This is the gate that failed to exist when
// semiont-keycloak reached the preflight and never reached stop.
func TestBothSweepsCoverEveryContainerDescriptor(t *testing.T) {
	noPreflight := map[string]string{
		"browser":   "not a stack member — the preflight must not sweep a viewer kept open across stacks (BROWSER-LIFECYCLE)",
		"inference": "handled in the Ollama section, where a host instance may make the container unnecessary",
	}
	noStop := map[string]string{
		"browser": "not a stack member — a bare stop leaves the viewer running; `stop --service browser` is its off-switch",
	}
	for _, d := range serviceDescriptors {
		if d.container == "" {
			continue // this driver launches nothing (oidc, anthropic, voyage, shared Ollama)
		}
		if _, exempt := noPreflight[d.role]; !exempt && !contains(preflightNames, d.container) {
			t.Errorf("%s/%s runs %s, which start's preflight never sweeps — a survivor of the last run holds its port and the start fails on it",
				d.role, d.driver, d.container)
		}
		if reason, exempt := noStop[d.role]; exempt {
			if contains(stopNames, d.container) {
				t.Errorf("%s/%s is exempt from the stop sweep (%s), but it is listed", d.role, d.driver, reason)
			}
			continue
		}
		if !contains(stopNames, d.container) {
			t.Errorf("%s/%s runs %s, which `semiont stop` never stops — it survives the teardown, and the port check then reports it as somebody else's process",
				d.role, d.driver, d.container)
		}
	}
}

func TestRoleListDerivesTodaysUsageString(t *testing.T) {
	want := "gateway, worker, smelter, weaver, archivist, librarian, dispatcher, browser, database, graph, vectors, messaging, identity, inference, embedding, traces, metrics, or collector"
	if roleList != want {
		t.Errorf("roleList =\n  %s\nwant\n  %s", roleList, want)
	}
}

// statusServices names roles; the descriptor set says which roles exist. The
// Browser is the one role status reports elsewhere (printBrowser opens the
// report, above every stack it views).
func TestStatusReportCoversEveryRole(t *testing.T) {
	reported := map[string]bool{}
	for _, s := range statusServices {
		if !knownRole(s.name) {
			t.Errorf("statusServices names %q, which is not a role", s.name)
		}
		reported[s.name] = true
	}
	for _, r := range roleOrder {
		if r == "browser" {
			if reported[r] {
				t.Errorf("browser is reported by printBrowser, above the stack table; it must not also be a row")
			}
			continue
		}
		if !reported[r] {
			t.Errorf("role %q exists but `semiont status` never reports it", r)
		}
	}
}

// serviceClients is the realm's account list: every Semiont service that
// presents a token to another. The Browser presents none — it is a viewer,
// and the only Semiont role without an account. Now derived; the literal is
// what shipped.
func TestServiceClientsDeriveTodaysAccountList(t *testing.T) {
	assertNames(t, "serviceClients", serviceClients,
		[]string{"archivist", "dispatcher", "gateway", "librarian", "smelter", "weaver", "worker"})
}

// The cut P1 is FOR: a row asserting a container for a role is now a row
// about a (role, driver) pair, so the identity role cannot claim Keycloak's
// container while the config selects an external issuer.
func TestExternalDriversCarryNoContainer(t *testing.T) {
	for _, pair := range [][2]string{{"identity", "oidc"}, {"inference", "anthropic"}, {"embedding", "voyage"}, {"embedding", "ollama"}} {
		d, ok := lookupDescriptor(pair[0], pair[1])
		if !ok {
			t.Fatalf("no descriptor for %s/%s", pair[0], pair[1])
		}
		if d.container != "" || d.image != "" || d.mem != "" {
			t.Errorf("%s/%s launches nothing, yet its descriptor claims container=%q image=%q mem=%q",
				pair[0], pair[1], d.container, d.image, d.mem)
		}
	}
}

// roleContainer answers with ONE name, which is only honest while no role
// has drivers running different containers. The day one does (a JanusGraph
// beside Neo4j), every roleContainer site must take a driver instead — this
// is the test that says so rather than letting the first row win silently.
func TestNoRoleHasTwoContainerNames(t *testing.T) {
	for _, role := range roleOrder {
		if names := containersForRole(role); len(names) > 1 {
			t.Errorf("role %q runs %v — roleContainer() would answer with %q alone; the single-handle sites (status, logs, stop --service) must take a driver",
				role, names, names[0])
		}
	}
}

func assertNames(t *testing.T, what string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s has %d entries, want %d:\n  got  %s\n  want %s", what, len(got), len(want), strings.Join(got, " "), strings.Join(want, " "))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s[%d] = %q, want %q:\n  got  %s\n  want %s", what, i, got[i], want[i], strings.Join(got, " "), strings.Join(want, " "))
		}
	}
}
