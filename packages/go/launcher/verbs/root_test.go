package verbs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	launcher "github.com/The-AI-Alliance/semiont/packages/go/launcher"
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// Every verb takes --root, the knowledge base whose stack it acts on. With two
// knowledge bases' stacks recorded and the verb run from neither clone, --root
// alone says which: each verb reaches the stack it names (whose record names
// no gateway, so the verb stops there, dialling nothing), where without it
// the verb refuses to choose.
func TestEveryVerbActsOnTheStackItsRootNames(t *testing.T) {
	verbFixture(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".semiont"), 0o755); err != nil {
		t.Fatal(err)
	}
	project := "project:\n  name: kb\ngit:\n  sync: false\nsite:\n  domain: example.org:kb\n  siteName: KB\n"
	if err := os.WriteFile(filepath.Join(root, ".semiont", "config.yaml"), []byte(project), 0o644); err != nil {
		t.Fatal(err)
	}
	named := localStack(launcher.ServiceState{Container: "semiont-example.org-kb-gateway"})
	named.KBRoot = root
	other := &launcher.StackState{Runtime: "container", KBDid: "did:web:example.org:other", KBRoot: "/other",
		Services: map[string]launcher.ServiceState{"gateway": {Endpoint: "http://localhost:4010/api/health"}}}
	recordStacks(t, named, other)
	t.Chdir(t.TempDir())

	for verb, run := range map[string]func([]string) int{
		"beckon": Beckon, "bind": Bind, "browse": Browse, "frame": Frame, "gather": Gather,
		"listen": Listen, "mark": Mark, "match": Match, "yield": Yield,
	} {
		args := map[string][]string{
			"beckon": {"res-1"},
			"bind":   {"res-1", "ann-1", "res-2"},
			"browse": {"--json"},
			"frame":  {"--entity-type", "Person"},
			"gather": {"res-1", "ann-1"},
			"listen": {},
			"mark":   {"res-1", "--link", "res-2"},
			"match":  {"--search", "clause"},
			"yield":  {"--delegate", "res-1", "--storage-uri", "file://generated/out.md", "--title", "Derived"},
		}[verb]
		t.Run(verb, func(t *testing.T) {
			_, stderr := harness.CaptureOutput(t, func() {
				if code := run(args); code == 0 {
					t.Errorf("%s: exit 0 without --root, from neither clone", verb)
				}
			})
			if !strings.Contains(stderr, "--root "+root) {
				t.Errorf("%s without --root does not offer --root %s:\n%s", verb, root, stderr)
			}
			_, stderr = harness.CaptureOutput(t, func() {
				if code := run(append([]string{"--root", root}, args...)); code == 0 {
					t.Errorf("%s --root: exit 0 against a record that names no gateway", verb)
				}
			})
			if !strings.Contains(stderr, "names no gateway") {
				t.Errorf("%s --root %s did not reach its stack:\n%s", verb, root, stderr)
			}
		})
	}
}
