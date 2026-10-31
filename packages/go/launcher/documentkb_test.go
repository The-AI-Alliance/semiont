package launcher

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// namesItsKB: whether a service's document names the knowledge base it serves —
// whether its schema, specs/src/components/schemas/<Service>Config.json, has a
// `kb`.
func namesItsKB(t *testing.T, svc string) bool {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "specs", "src", "components", "schemas", strings.ToUpper(svc[:1])+svc[1:]+"Config.json"))
	if err != nil {
		t.Fatalf("the %s's document has no schema: %v", svc, err)
	}
	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(b, &schema); err != nil {
		t.Fatal(err)
	}
	_, named := schema.Properties["kb"]
	return named
}

// Every service whose document names the knowledge base it serves is written
// the gateway's `kb`, which is the identity the knowledge base commits,
// verbatim; a document whose schema has no `kb` is written none. Whether a
// document names it is its schema's to say, so a schema that gains a `kb` is
// held here without this test naming it.
func TestEveryDocumentThatNamesItsKBNamesTheGatewaysKB(t *testing.T) {
	naming := map[string]bool{}
	for svc := range serviceDocuments {
		naming[svc] = namesItsKB(t, svc)
	}
	if !naming["gateway"] {
		t.Fatal("the gateway's schema has no kb: this census compares every document with the gateway's")
	}
	committed, err := os.ReadFile(filepath.Join(fixtureRoot, ".semiont", projectFileYAML))
	if err != nil {
		t.Fatal(err)
	}
	const fixtureDomain = "example.github.io:test-kb"
	if !strings.Contains(string(committed), fixtureDomain) {
		t.Fatalf("the fixture's project file no longer commits %s:\n%s", fixtureDomain, committed)
	}
	for _, domain := range []string{
		fixtureDomain,
		// A domain may hold punctuation, which every document carries as it is.
		"example.github.io%3A8443:a,b=c",
	} {
		ident, err := yamlKBIdentity(projectFileYAML, []byte(strings.Replace(string(committed), fixtureDomain, domain, 1)))
		if err != nil {
			t.Fatal(err)
		}
		served, err := kbRoot{dir: fixtureRoot, ident: ident}.served()
		if err != nil {
			t.Fatal(err)
		}
		p := placed(t, fixtureStack(t, "ollama-gemma"))
		kbOf := func(svc string) *api.KbIdentity {
			b, err := serviceDocuments[svc].write(p, served)
			if err != nil {
				t.Fatalf("%s: %v", svc, err)
			}
			var doc struct {
				Kb *api.KbIdentity `json:"kb"`
			}
			if err := json.Unmarshal(b, &doc); err != nil {
				t.Fatal(err)
			}
			return doc.Kb
		}
		gateway := kbOf("gateway")
		if want := (api.KbIdentity{Name: "Test Knowledge Base", Domain: domain}); gateway == nil || *gateway != want {
			t.Fatalf("the gateway's kb is %+v, want the committed %+v", gateway, want)
		}
		for _, svc := range slices.Sorted(maps.Keys(serviceDocuments)) {
			kb := kbOf(svc)
			switch {
			case naming[svc]:
				if kb == nil || *kb != *gateway {
					t.Errorf("%s: the %s's kb is %+v, and the gateway's %+v", domain, svc, kb, *gateway)
				}
			case kb != nil:
				t.Errorf("%s: the %s's schema has no kb, and its document names %+v", domain, svc, *kb)
			}
		}
	}
}

// A knowledge base that declares no domain is given no fabricated one: no
// service's document is written for it.
func TestAKnowledgeBaseWithNoDomainServesNoDocument(t *testing.T) {
	if _, err := (kbRoot{dir: fixtureRoot}).served(); err == nil || !strings.Contains(err.Error(), "site.domain") {
		t.Fatalf("want a refusal naming the domain, got %v", err)
	}
}
