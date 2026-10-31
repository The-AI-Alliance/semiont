package launcher

// Deployment topology is the launcher's to know, never a document's to
// declare. A knowledge base's documents say WHAT it needs; WHERE each daemon
// listens on this machine is a fact of the start that placed it.

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// externalIssuer: st trusting a Keycloak somebody else runs at
// login.example.com, with no Issuer document.
func externalIssuer(st *stack.Stack) {
	st.KnowledgeBase.Spec.Issuer.Ref = nil
	st.KnowledgeBase.Spec.Issuer.External = &stack.KnowledgeBaseIssuerExternal{Type: "keycloak", Url: "https://login.example.com/realms/kb"}
	st.Issuer = nil
}

// A daemon whose document states no `external` is the launcher's to run and
// to place: every one at this start's address, on its driver's port (the
// containers' side of one a person dials too), and the machine's Ollama beside
// them.
func TestTheLauncherPlacesEveryDaemonItRuns(t *testing.T) {
	placedByLauncher := []string{
		"graph: bolt://192.168.64.1:17687",
		"vectors: 192.168.64.1:6333",
		"database: 192.168.64.1:5432",
		"messaging: 192.168.64.1:4222",
		"identity: http://192.168.64.1:8080/realms/semiont",
		"embedding: http://192.168.64.1:11434",
	}
	for inference, want := range map[string][]string{
		"ollama-gemma": append(placedByLauncher[:len(placedByLauncher):len(placedByLauncher)], "inference: http://192.168.64.1:11434"),
		"anthropic":    placedByLauncher,
	} {
		p := placed(t, fixtureStack(t, inference))
		for _, role := range []string{"graph", "vectors", "database", "messaging", "identity"} {
			if p.plan.Roles[role].Presence != presenceLauncher {
				t.Errorf("%s: the launcher does not run the %s its documents leave to it", inference, role)
			}
		}
		if got := p.placedLines(); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: the start places\n  %s\nwant\n  %s", inference, strings.Join(got, "\n  "), strings.Join(want, "\n  "))
		}
	}
}

// A document's `external` is how it says somebody else runs a daemon. The
// launcher then plans it as somebody else's, at the address the document
// states, launches nothing for it, and a container reaches it there.
func TestADocumentsExternalIsSomebodyElsesDaemon(t *testing.T) {
	for _, c := range []struct {
		role, address string
		external      func(st *stack.Stack)
		// reached: where a container reaches the daemon, and want that address.
		reached func(p placement) string
		want    string
	}{
		{"graph", "graph.internal", externalGraph,
			func(p placement) string { return p.graphURI() }, "bolt://graph.internal:7687"},
		{"vectors", "qdrant.internal", func(st *stack.Stack) {
			v := &st.KnowledgeIndex.Spec.Vectors
			v.Image, v.Resources = nil, nil
			v.External = &stack.HostPort{Host: "qdrant.internal", Port: 7000}
		}, func(p placement) string { host, port := p.vectors(); return fmt.Sprintf("%s:%d", host, port) }, "qdrant.internal:7000"},
		{"database", "pg.internal", func(st *stack.Stack) {
			d := &st.Issuer.Spec.Database
			d.Image, d.Resources = nil, nil
			d.External = &stack.IssuerDatabaseExternal{Host: "pg.internal", Port: 5432, Password: stack.SecretRef{FromEnv: "PG_PASSWORD"}}
		}, nil, ""},
		{"messaging", "nats.internal", externalBroker,
			func(p placement) string { return p.brokerServers() }, "nats.internal:4222"},
		{"identity", "login.example.com", externalIssuer,
			func(p placement) string { return p.issuer() }, "https://login.example.com/realms/kb"},
		{"embedding", "gpu.internal", func(st *stack.Stack) {
			endpoint := "http://gpu.internal:11434"
			st.KnowledgeIndex.Spec.Embedding.Endpoint = &endpoint
		}, nil, ""},
	} {
		st := fixtureStack(t, "ollama-gemma")
		c.external(st)
		p := placed(t, st)
		if rp := p.plan.Roles[c.role]; rp.Presence != presenceExternal || rp.Address != c.address {
			t.Errorf("%s: planned as (%v, %q), want somebody else's at %s", c.role, rp.Presence, rp.Address, c.address)
		}
		for _, line := range p.placedLines() {
			if strings.HasPrefix(line, c.role+":") {
				t.Errorf("%s: the start places %q, and the document says somebody else runs it", c.role, line)
			}
		}
		if c.reached != nil {
			if got := c.reached(p); got != c.want {
				t.Errorf("%s: a container reaches it at %q, want %q, as its document states", c.role, got, c.want)
			}
		}
	}
}

// No container is told where anything is through its environment: no
// service's command names the start's address or hands a *_HOST variable. A
// variable the launcher says it injects is one a service is in fact handed.
func TestNoAddressTravelsInAnEnvironment(t *testing.T) {
	const addr = "192.168.64.1"
	builders := map[string][]string{
		"gateway":    gatewayArgs("kb", "/stage", exposure{rt: "docker", addr: addr}, "secret", "jwt", "latest", semiontDescriptor("gateway").mem, 4000, nil, nil),
		"worker":     workerArgs("/state/machine/worker.json", exposure{rt: "docker", addr: addr}, "key", "latest", semiontDescriptor("worker").mem, nil, nil),
		"smelter":    smelterArgs("kb", "/stage", exposure{rt: "docker", addr: addr}, semiontDescriptor("smelter").ports[0].port, "secret", "latest", semiontDescriptor("smelter").mem, nil, nil),
		"weaver":     weaverArgs("kb", "/stage", exposure{rt: "docker", addr: addr}, semiontDescriptor("weaver").ports[0].port, "secret", "latest", semiontDescriptor("weaver").mem, nil, nil),
		"archivist":  archivistArgs("kb", "/kb", "/stage", exposure{rt: "docker", addr: addr}, semiontDescriptor("archivist").ports[0].port, "secret", "latest", semiontDescriptor("archivist").mem, nil, nil),
		"librarian":  librarianArgs("kb", "/stage", exposure{rt: "docker", addr: addr}, semiontDescriptor("librarian").ports[0].port, "secret", "latest", semiontDescriptor("librarian").mem, nil, nil),
		"dispatcher": dispatcherArgs("kb", "/stage", exposure{rt: "docker", addr: addr}, semiontDescriptor("dispatcher").ports[0].port, "secret", "latest", semiontDescriptor("dispatcher").mem, nil, nil),
	}
	handed := map[string]bool{}
	for svc, args := range builders {
		if strings.Contains(strings.Join(args, " "), addr) {
			t.Errorf("%s's command names the start's address:\n%s", svc, strings.Join(args, " "))
		}
		for i, a := range args {
			if a != "--env" || i+1 >= len(args) {
				continue
			}
			name, _, _ := strings.Cut(args[i+1], "=")
			handed[name] = true
			if strings.HasSuffix(name, "_HOST") {
				t.Errorf("%s is handed %s in its environment", svc, name)
			}
		}
	}
	for name := range injectedVars {
		if !handed[name] {
			t.Errorf("injectedVars names %s, and no service is handed it", name)
		}
	}
}

// The documents `semiont init` writes state no address: a new knowledge base's
// documents are the same on every machine, and the launcher places every daemon
// they name.
func TestAGeneratedStackLeavesEveryAddressToTheLauncher(t *testing.T) {
	for _, c := range []struct {
		params genParams
		places []string
	}{
		{genParams{Inference: "ollama", Model: "gemma4:26b", EmbeddingModel: "nomic-embed-text", GatewayPort: 4000},
			[]string{"graph", "vectors", "database", "messaging", "identity", "embedding", "inference"}},
		{genParams{Inference: "anthropic", Model: "claude-sonnet-4-5-20250929", EmbeddingModel: "nomic-embed-text", AnthropicEndpoint: "https://api.anthropic.com", GatewayPort: 4000},
			[]string{"graph", "vectors", "database", "messaging", "identity", "embedding"}},
	} {
		inference := c.params.Inference
		files, err := generateStack(c.params, inference)
		if err != nil {
			t.Fatal(err)
		}
		root := t.TempDir()
		if err := writeStackFiles(root, files); err != nil {
			t.Fatal(err)
		}
		st, err := stack.Load(root, inference)
		if err != nil {
			t.Fatalf("%s: the generated documents do not load: %v", inference, err)
		}
		var roles []string
		for _, line := range placed(t, st).placedLines() {
			role, _, _ := strings.Cut(line, ":")
			roles = append(roles, role)
		}
		if !reflect.DeepEqual(roles, c.places) {
			t.Errorf("%s: the launcher places %v of the generated documents' daemons, want %v", inference, roles, c.places)
		}
	}
}
