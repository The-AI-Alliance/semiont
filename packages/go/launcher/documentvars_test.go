package launcher

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// documentWriters: each stack service's document writer, by the service's name
// in serviceSecrets.
var documentWriters = map[string]func(placement) ([]byte, error){
	"gateway": func(p placement) ([]byte, error) {
		return gatewayDocument(p, "Example KB", exampleKBDomain)
	},
	"dispatcher": dispatcherDocument,
	"archivist":  archivistDocument,
	"worker": func(p placement) ([]byte, error) {
		return workerDocument(p, exampleKBDomain, nil)
	},
	"smelter":   smelterDocument,
	"weaver":    weaverDocument,
	"librarian": librarianDocument,
}

// namedVariables: every variable a document names — the string under each key
// ending in `Env`, at any depth, so a member a schema gains is counted without
// this test naming it.
func namedVariables(t *testing.T, document []byte) []string {
	t.Helper()
	var decoded any
	if err := json.Unmarshal(document, &decoded); err != nil {
		t.Fatal(err)
	}
	var names []string
	var walk func(value any)
	walk = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			for key, member := range value {
				if !strings.HasSuffix(key, "Env") {
					walk(member)
					continue
				}
				name, isName := member.(string)
				if !isName {
					t.Errorf("%s is %v, not the name of a variable", key, member)
					continue
				}
				names = append(names, name)
			}
		case []any:
			for _, member := range value {
				walk(member)
			}
		}
	}
	walk(decoded)
	return names
}

// Every variable a service's document names is one a start hands that service,
// and every one it is handed its document names: a variable named and not
// handed is a service that cannot start, and one handed and not named is a
// secret where nothing reads it. Run for stacks that name a secret in every
// place a document can: once with somebody else running every daemon, once
// with the launcher running them.
func TestEveryVariableADocumentNamesIsHanded(t *testing.T) {
	secrets := func(st *stack.Stack) {
		voyageEmbedding(st)
		st.KnowledgeBase.Spec.Messaging.Signal.Type = "nats"
	}
	for _, c := range []struct {
		why     string
		daemons func(st *stack.Stack)
		planted []string
	}{
		{"somebody else runs every daemon", func(st *stack.Stack) { externalGraph(st); externalBroker(st) },
			[]string{"ANTHROPIC_API_KEY", "BROKER_PASSWORD", "BROKER_USER", "GRAPH_PASSWORD", "VOYAGE_API_KEY"}},
		{"the launcher runs every daemon", func(*stack.Stack) {},
			[]string{"ANTHROPIC_API_KEY", daemonPasswords["graph"].env, daemonPasswords["messaging"].env, "NATS_USER", "VOYAGE_API_KEY"}},
	} {
		st := fixtureStack(t, "anthropic")
		secrets(st)
		c.daemons(st)
		p := placed(t, st)
		byService := serviceSecrets(p)

		var services []string
		for svc := range byService {
			services = append(services, svc)
		}
		sort.Strings(services)
		var written []string
		for svc := range documentWriters {
			written = append(written, svc)
		}
		sort.Strings(written)
		if !reflect.DeepEqual(services, written) {
			t.Fatalf("serviceSecrets names %v, and this census writes the documents of %v", services, written)
		}

		handed := withDaemonCredentialVars(byService, p.plan, st.KnowledgeBase.Spec.Messaging.Signal.Type == "nats")
		found := map[string]bool{}
		for _, svc := range services {
			document, err := documentWriters[svc](p)
			if err != nil {
				t.Fatalf("%s: %s: %v", c.why, svc, err)
			}
			named := namedVariables(t, document)
			for _, name := range named {
				found[name] = true
				if !contains(handed[svc], name) {
					t.Errorf("%s: the %s's document names %s, and the %s is not handed it (handed %v)", c.why, svc, name, svc, handed[svc])
				}
			}
			for _, name := range handed[svc] {
				if !contains(named, name) {
					t.Errorf("%s: the %s is handed %s, which its document does not name", c.why, svc, name)
				}
			}
		}
		// Every secret the stack names was found in some document: a census
		// that finds nothing passes on silence.
		for _, name := range c.planted {
			if !found[name] {
				t.Errorf("%s: no document names %s, which the stack names", c.why, name)
			}
		}
	}
}
