package launcher

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
	"go.yaml.in/yaml/v3"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// Every case of specs/src/kb-identity/cases.json whose project file, written
// as config.yaml, holds to ProjectConfig's schema reads to the identity the
// table states, as the TOML does; one that does not hold is refused, not read
// as a knowledge base with less identity.
func TestTheYAMLProjectFileReadsAsTheTOMLDoes(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "specs", "src", "kb-identity", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why    string  `json:"why"`
			Dir    string  `json:"dir"`
			Config *string `json:"config"`
			Name   string  `json:"name"`
			Domain *string `json:"domain"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	held := 0
	parent := t.TempDir()
	for _, c := range table.Cases {
		if c.Config == nil {
			continue
		}
		t.Run(c.Why, func(t *testing.T) {
			var sections map[string]any
			if err := toml.Unmarshal([]byte(*c.Config), &sections); err != nil {
				t.Fatal(err)
			}
			text, err := yaml.Marshal(sections)
			if err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(parent, c.Dir)
			if err := os.MkdirAll(filepath.Join(root, ".semiont"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, ".semiont", projectFileYAML), text, 0o644); err != nil {
				t.Fatal(err)
			}
			refusals, err := stack.Check("ProjectConfig", text)
			if err != nil {
				t.Fatal(err)
			}
			if len(refusals) > 0 {
				if loadKBIdentity(root) != nil {
					t.Errorf("a config.yaml that does not hold to its schema read as an identity:\n%s", text)
				}
				if checkProjectFile(root) == nil {
					t.Errorf("a config.yaml that does not hold to its schema was not refused:\n%s", text)
				}
				return
			}
			held++
			want := ""
			if c.Domain != nil {
				want = *c.Domain
			}
			if got := committedDomain(root); got != want {
				t.Errorf("domain: got %q, want %q", got, want)
			}
			if got := effectiveKBName(root); got != c.Name {
				t.Errorf("name: got %q, want %q", got, c.Name)
			}
			if err := checkProjectFile(root); err != nil {
				t.Errorf("refused a config.yaml that holds: %v", err)
			}
		})
	}
	if held == 0 {
		t.Fatal("no case's project file holds to ProjectConfig's schema: this test compares nothing")
	}
}

// config.yaml is read when it is there, whatever the TOML beside it says.
func TestTheYAMLProjectFileIsReadBeforeTheTOML(t *testing.T) {
	root := t.TempDir()
	semiont := filepath.Join(root, ".semiont")
	if err := os.MkdirAll(semiont, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(semiont, projectFileTOML), []byte("[project]\nname = \"toml\"\n\n[site]\ndomain = \"example.org:toml\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := committedDomain(root); got != "example.org:toml" {
		t.Fatalf("with only the TOML, the domain is %q", got)
	}
	yamlFile := "project:\n  name: yaml\ngit:\n  sync: false\nsite:\n  domain: example.org:yaml\n  siteName: YAML\n"
	if err := os.WriteFile(filepath.Join(semiont, projectFileYAML), []byte(yamlFile), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := committedDomain(root); got != "example.org:yaml" {
		t.Errorf("with config.yaml beside the TOML, the domain is %q, and config.yaml's is example.org:yaml", got)
	}
	if got := effectiveKBName(root); got != "yaml" {
		t.Errorf("with config.yaml beside the TOML, the name is %q", got)
	}
}

// A config.yaml that does not hold is refused by the start check, naming the
// line of each place, and is no identity for display.
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
	if loadKBIdentity(root) != nil {
		t.Error("a broken config.yaml read as an identity")
	}
	var refused *stack.Refused
	if err := checkProjectFile(root); !errors.As(err, &refused) {
		t.Fatalf("a broken config.yaml must be refused, and the check said %v", err)
	}
	lines := map[string]int{}
	for _, refusal := range refused.Refusals {
		lines[refusal.Reason+" "+refusal.At] = refusal.Line
	}
	if lines["unknown-field /site/domian"] != 6 || lines["missing-required /site/domain"] != 5 {
		t.Errorf("the misspelled domain is on line 6, in the site on line 5: %+v", refused.Refusals)
	}
}
