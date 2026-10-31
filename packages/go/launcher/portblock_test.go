package launcher

// Each knowledge base's port block: which one a root is given, and where a
// block places each port of its stack.

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// keepBlocks writes a registry of one row per path, each keeping the block
// blocks names for it; a path blocks has no entry for keeps none.
func keepBlocks(t *testing.T, paths []string, blocks map[string]int) {
	t.Helper()
	var reg rootsRegistry
	for _, p := range paths {
		e := rootEntry{Path: p}
		if b, ok := blocks[p]; ok {
			e.PortBlock = &b
		}
		reg.Roots = append(reg.Roots, e)
	}
	if err := writeRoots(reg); err != nil {
		t.Fatal(err)
	}
}

// A root keeps the block its first start took; one that keeps none is given
// the lowest no other root keeps, gaps first, and keeps it once a start
// records it.
func TestARootIsGivenTheLowestPortBlockNoOtherKeeps(t *testing.T) {
	harness.Home(t)
	// Absolute on this system, as portBlockOf makes the root it is asked of.
	base := t.TempDir()
	zero, two, fresh := filepath.Join(base, "zero"), filepath.Join(base, "two"), filepath.Join(base, "new")
	keepBlocks(t, []string{zero, two, fresh}, map[string]int{zero: 0, two: 2})
	if block, kept := portBlockOf(two); block != 2 || !kept {
		t.Errorf("a root keeping block 2 is given %d (kept %v)", block, kept)
	}
	if block, kept := portBlockOf(fresh); block != 1 || kept {
		t.Errorf("a root keeping no block is given %d (kept %v), want 1, the lowest no other keeps", block, kept)
	}
	recordPortBlock(fresh, 1)
	if block, kept := portBlockOf(fresh); block != 1 || !kept {
		t.Errorf("after its start recorded it, the root is given %d (kept %v)", block, kept)
	}
	if block, _ := portBlockOf(filepath.Join(base, "unregistered")); block != 3 {
		t.Errorf("a root no row names is given block %d, want 3", block)
	}
}

// Block 1 places every port the launcher chooses for the stack ten above
// block 0's — the daemons it runs, Neo4j's Browser, the services behind the
// gateway, and the containers' side of a port a person dials too — and
// leaves the gateway's, the Keycloak's and the machine's where they are.
func TestABlockPlacesEveryPortTheLauncherChooses(t *testing.T) {
	plan, err := derivePlan(fixtureStack(t, "ollama-gemma"), 8090, 1)
	if err != nil {
		t.Fatal(err)
	}
	for role, want := range map[string]int{"graph": 7697, "vectors": 6343, "database": 5442, "messaging": 4232, "identity": 8090, "inference": 11434} {
		if got := plan.Roles[role].Port; got != want {
			t.Errorf("%s is published at %d, want %d", role, got, want)
		}
	}
	if aux := plan.AuxPorts("graph"); len(aux) != 1 || aux[0].port != 7484 {
		t.Errorf("Neo4j's Browser is published at %v, want 7484", aux)
	}
	for role, want := range map[string]int{"smelter": 24111, "weaver": 24112, "archivist": 24113, "librarian": 24114, "dispatcher": 24115} {
		if got := plan.servicePort(role); got != want {
			t.Errorf("%s is published at %d, want %d", role, got, want)
		}
	}
	claimed := portNumbers(planPortChecks(plan, appleContainer))
	for _, want := range []int{7484, 7697, 17697, 6343, 5442, 4232, 8090, 4000, 14000, 24111, 24112, 24113, 24114, 24115} {
		if !slices.Contains(claimed, want) {
			t.Errorf("a start on block 1 does not claim %d; it claims %v", want, claimed)
		}
	}
	for _, block0 := range []int{7474, 7687, 17687, 6333, 5432, 4222, 8080, 24101, 24102, 24103, 24104, 24105} {
		if slices.Contains(claimed, block0) {
			t.Errorf("a start on block 1 claims %d, block 0's", block0)
		}
	}
	p := placement{st: fixtureStack(t, "ollama-gemma"), plan: plan, rt: "container", addr: bridge}
	if got := p.graphURI(); got != "bolt://"+bridge+":17697" {
		t.Errorf("a container dials the graph at %s", got)
	}
	if host, port := p.archivist(); host != bridge || port != 24113 {
		t.Errorf("a container dials the Archivist at %s:%d", host, port)
	}
	if got := p.brokerServers(); got != bridge+":4232" {
		t.Errorf("a container dials the broker at %s", got)
	}
	if got := healthEndpoint("graph", "neo4j", plan, appleContainer); got != "http://localhost:7484" {
		t.Errorf("the graph's health is asked at %s, want Neo4j's Browser on block 1, on loopback", got)
	}
	if got := healthEndpoint("collector", "otel", plan, appleContainer); got != "http://"+bridge+":24110/metrics" {
		t.Errorf("the machine's collector is asked at %s, which no block moves", got)
	}
}

// A daemon somebody else runs is where its document says, whatever the
// block.
func TestABlockLeavesAnExternalDaemonWhereItsDocumentSays(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.KnowledgeIndex.Spec.Graph.External = &stack.KnowledgeIndexGraphExternal{Uri: "bolt://graph.example.org:7687"}
	plan, err := derivePlan(st, 8090, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := plan.Roles["graph"].Port; got != 7687 {
		t.Errorf("an external graph is dialed at %d, want its document's 7687", got)
	}
	if got := plan.hostPort("graph", 7474); got != 7474 {
		t.Errorf("an external graph's Browser is asked at %d, which no block of this machine's moves", got)
	}
}

// Without KEYCLOAK_PORT or a port the root keeps, its Keycloak is Keycloak's
// default on the root's block.
func TestKeycloakIsOnItsKnowledgeBasesBlock(t *testing.T) {
	harness.Home(t)
	root := t.TempDir()
	keepBlocks(t, []string{root}, map[string]int{root: 2})
	t.Setenv("KEYCLOAK_PORT", "")
	port, source, fromEnv, ok := keycloakPort(&UI{}, root)
	if !ok || fromEnv || port != 8100 || source != "port block 2" {
		t.Errorf("keycloakPort = %d (%q, from the environment %v, ok %v), want 8100 on port block 2", port, source, fromEnv, ok)
	}
}

// `semiont init` writes the lowest gateway port a block would place the
// gateway at that no other known root commits; a root that is gone, or whose
// KnowledgeBase document does not hold, commits none, and the root being
// initialized is not another.
func TestInitWritesAGatewayPortNoKnownRootCommits(t *testing.T) {
	harness.Home(t)
	committing := func(port string) string {
		root := t.TempDir()
		dir := filepath.Join(root, ".semiont", "stack")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(fixtureRoot, ".semiont", "stack", "knowledge-base.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), "port: 4000\n") {
			t.Fatal("the fixture's knowledge-base.yaml no longer commits port 4000: this test would prove nothing")
		}
		b = []byte(strings.Replace(string(b), "port: 4000\n", "port: "+port+"\n", 1))
		if err := os.WriteFile(filepath.Join(dir, "knowledge-base.yaml"), b, 0o644); err != nil {
			t.Fatal(err)
		}
		return root
	}
	at4000, at4010, broken, self := committing("4000"), committing("4010"), committing("not-a-port"), committing("4020")
	keepBlocks(t, []string{at4000, at4010, broken, self, "/kb/gone"}, nil)
	if got := freeGatewayPort(self); got != 4020 {
		t.Errorf("init writes gateway port %d, want 4020: 4000 and 4010 are committed", got)
	}
}
