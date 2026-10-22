package launcher

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// A root whose config.yaml does not hold is refused however a command finds
// it — by --root, by SEMIONT_ROOT, from the working directory — naming the
// line of each place, and the working directory's refusal is no "not inside
// a knowledge base".
func TestABrokenProjectFileIsRefusedAtItsLine(t *testing.T) {
	root := t.TempDir()
	semiont := filepath.Join(root, ".semiont")
	if err := os.MkdirAll(semiont, 0o755); err != nil {
		t.Fatal(err)
	}
	yamlFile := "project:\n  name: kb\ngit:\n  sync: true\nsite:\n  domian: example.org:kb\n  siteName: KB\n"
	if err := os.WriteFile(filepath.Join(semiont, projectFileYAML), []byte(yamlFile), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := resolveRootArg(root)
	var refused *stack.Refused
	if !errors.As(err, &refused) {
		t.Fatalf("--root of a broken config.yaml must be refused by its schema, and resolving it said %v", err)
	}
	lines := map[string]int{}
	for _, refusal := range refused.Refusals {
		lines[refusal.Reason+" "+refusal.At] = refusal.Line
	}
	if lines["unknown-field /site/domian"] != 6 || lines["missing-required /site/domain"] != 5 {
		t.Errorf("the misspelled domain is on line 6, in the site on line 5: %+v", refused.Refusals)
	}

	t.Setenv("SEMIONT_ROOT", root)
	if _, _, err := resolveKBRoot(); !errors.As(err, &refused) {
		t.Errorf("SEMIONT_ROOT naming a broken config.yaml must be refused, and resolving it said %v", err)
	}
	if found, err := CwdKBRoot(); !projectFileRefused(err) {
		t.Errorf("the working directory's broken config.yaml read as %q, %v: a refusal, not \"not inside a clone\"", found, err)
	}

	t.Setenv("SEMIONT_ROOT", "")
	t.Chdir(semiont)
	if _, _, err := resolveKBRoot(); !errors.As(err, &refused) {
		t.Errorf("a broken config.yaml found from the working directory must be refused, and resolving it said %v", err)
	}
}

// A config.yaml that is not YAML at all is refused as a root, as one that
// does not hold to its schema is.
func TestAProjectFileThatIsNotYAMLIsRefused(t *testing.T) {
	root := t.TempDir()
	semiont := filepath.Join(root, ".semiont")
	if err := os.MkdirAll(semiont, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(semiont, projectFileYAML), []byte("project: [\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveRootArg(root); !projectFileRefused(err) || !strings.Contains(err.Error(), projectFileYAML) {
		t.Errorf("a config.yaml that is not YAML must be refused as a root, naming it, and resolving it said %v", err)
	}
}
