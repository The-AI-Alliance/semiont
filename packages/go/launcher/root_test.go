package launcher

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// A moved KB re-registers its did at the new path; the old path's row is
// then a corpse nothing else removes — it clutters the listing and makes
// the basename ambiguous for --root. Re-registration drops rows claiming
// the SAME did at OTHER paths that are gone from disk; a same-did row
// whose path still exists stays (two live clones are real, not a corpse).
func TestReRegistrationDropsMovedKBCorpse(t *testing.T) {
	harness.Home(t)

	kb := filepath.Join(t.TempDir(), "family")
	if err := os.MkdirAll(filepath.Join(kb, ".semiont"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := "project:\n  name: family\ngit:\n  sync: false\nsite:\n  domain: pingel.org\n  siteName: Family\n"
	if err := os.WriteFile(filepath.Join(kb, ".semiont", projectFileYAML), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}

	liveTwin := t.TempDir() // same did, path EXISTS — must survive
	reg := rootsRegistry{Schema: 1, Roots: []rootEntry{
		{Path: "/gone/old/family", Did: "did:web:pingel.org"},
		{Path: liveTwin, Did: "did:web:pingel.org"},
		{Path: "/gone/unrelated", Did: "did:web:other.example"},
	}}
	if err := writeRoots(reg); err != nil {
		t.Fatal(err)
	}

	ident, err := readKBIdentity(kb)
	if err != nil {
		t.Fatal(err)
	}
	registerRootUse(kbRoot{dir: kb, ident: ident}, false, "")

	got := loadRoots()
	paths := map[string]bool{}
	for _, e := range got.Roots {
		paths[e.Path] = true
	}
	if paths["/gone/old/family"] {
		t.Error("the moved KB's corpse row (same did, path gone) survived re-registration")
	}
	if !paths[liveTwin] {
		t.Error("a same-did row whose path still exists was dropped — two live clones are not a corpse")
	}
	if !paths["/gone/unrelated"] {
		t.Error("a missing row with a DIFFERENT did was dropped — only the re-registered identity's corpses may go")
	}
	if !paths[kb] {
		t.Error("the re-registered root is absent")
	}
}

// fixtureKnowledgeBase: the text of the fixture's KnowledgeBase document,
// which runs the launcher's broker.
func fixtureKnowledgeBase(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureRoot, stack.Dir, stack.KnowledgeBaseFile))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// brokerDocument: the fixture's KnowledgeBase document with the broker
// somebody else's, at servers, in place of the launcher's. alsoLaunchers keeps
// the launcher's beside it, which no document may say.
func brokerDocument(t *testing.T, servers string, alsoLaunchers bool) string {
	t.Helper()
	b := []byte(fixtureKnowledgeBase(t))
	launchers := regexp.MustCompile(`(?m)^    image: nats:.*\n    resources: \{ limits: \{ memory: 512M \} \}\n`)
	if n := len(launchers.FindAll(b, -1)); n != 1 {
		t.Fatalf("the fixture's knowledge-base.yaml names the launcher's broker %d times: this test would prove nothing", n)
	}
	external := "    external: { servers: \"" + servers + "\", user: { fromEnv: EXT_NATS_USER }, password: { fromEnv: EXT_NATS_PASSWORD } }\n"
	return launchers.ReplaceAllStringFunc(string(b), func(own string) string {
		if alsoLaunchers {
			return own + external
		}
		return external
	})
}

// kbWithDocument: a knowledge base root declaring domain, whose KnowledgeBase
// document is document.
func kbWithDocument(t *testing.T, domain, document string) string {
	t.Helper()
	root := kbNamed(t, domain)
	dir := filepath.Join(root, stack.Dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, stack.KnowledgeBaseFile), []byte(document), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// A broker somebody else runs serves one knowledge base. Of the roots this
// machine knows, the one whose KnowledgeBase document names the broker
// another's names is found: the same host, whatever its case, and the same
// port, the driver's where servers states none, with or without nats://. A
// broker on another host or port is another broker, and a clone of the same
// knowledge base is that knowledge base. A root that runs the launcher's
// broker, one whose document does not hold, one that is gone, and the root
// asked of name none.
func TestTheKnowledgeBaseHereThatNamesTheSameBrokerIsFound(t *testing.T) {
	for _, c := range []struct {
		name, ours, theirs string
		twin, found        bool
	}{
		{"the same host and port", "nats.example.com:4223", "nats.example.com:4223", false, true},
		{"the same, spelled otherwise", "nats.example.com:4223", "nats://NATS.Example.com:4223", false, true},
		{"the same, at the driver's port unstated", "nats.example.com:4222", "nats.example.com", false, true},
		{"another port", "nats.example.com:4223", "nats.example.com:4224", false, false},
		{"another host", "nats.example.com:4223", "nats2.example.com:4223", false, false},
		{"a clone of this knowledge base", "nats.example.com:4223", "nats.example.com:4223", true, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			harness.Home(t)
			self := kbWithDocument(t, "example.org:self", brokerDocument(t, c.ours, false))
			domain := "example.org:other"
			if c.twin {
				domain = "example.org:self"
			}
			other := kbWithDocument(t, domain, brokerDocument(t, c.theirs, false))
			launchers := kbWithDocument(t, "example.org:launchers", fixtureKnowledgeBase(t))
			broken := kbWithDocument(t, "example.org:broken", brokerDocument(t, c.ours, true))
			if _, err := stack.Read[stack.KnowledgeBase](filepath.Join(broken, stack.Dir, stack.KnowledgeBaseFile), "KnowledgeBase"); err == nil {
				t.Fatal("a document naming both brokers holds: the broken root would prove nothing")
			}
			var reg rootsRegistry
			for _, root := range []string{self, launchers, broken, other} {
				ident, err := readKBIdentity(root)
				if err != nil {
					t.Fatal(err)
				}
				reg.Roots = append(reg.Roots, rootEntry{Path: root, Did: ident.didWeb()})
			}
			reg.Roots = append(reg.Roots, rootEntry{Path: "/kb/gone", Did: "did:web:example.org:gone"})
			if err := writeRoots(reg); err != nil {
				t.Fatal(err)
			}
			ident, err := readKBIdentity(self)
			if err != nil {
				t.Fatal(err)
			}
			got, found := anotherOnBroker(kbRoot{dir: self, ident: ident}, c.ours)
			switch {
			case found != c.found:
				t.Errorf("another knowledge base on %s found: %v (%s), want %v", c.ours, found, got.Path, c.found)
			case found && got.Path != other:
				t.Errorf("the knowledge base found on %s is %s, want %s", c.ours, got.Path, other)
			}
		})
	}
}
