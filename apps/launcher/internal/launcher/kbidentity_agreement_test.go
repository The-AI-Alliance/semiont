package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestKBIdentityAgreesWithTheSharedTable runs every case in
// specs/src/kb-identity/cases.json through the launcher's readers: a project
// file the case refuses is refused, by the reader and as a root, and every
// other yields the identity the case states. The Archivist's reader runs the
// same cases (apps/archivist/record kb.rs), and TypeScript, Rust, Python and
// the Go SDK run its cases that declare a domain; together they gate a mirror
// that spans languages and cannot be generated. Absent is "" here and null in the table.
func TestKBIdentityAgreesWithTheSharedTable(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "specs", "src", "kb-identity", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why      string  `json:"why"`
			Dir      string  `json:"dir"`
			Config   *string `json:"config"`
			Refused  bool    `json:"refused"`
			Name     *string `json:"name"`
			Domain   *string `json:"domain"`
			Did      *string `json:"did"`
			Resource *string `json:"resource"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	refused, held := 0, 0
	orAbsent := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	type identity struct{ Name, Domain, Did, Resource string }

	parent := t.TempDir()
	for _, c := range table.Cases {
		t.Run(c.Why, func(t *testing.T) {
			root := filepath.Join(parent, c.Dir)
			if err := os.MkdirAll(filepath.Join(root, ".semiont"), 0o755); err != nil {
				t.Fatal(err)
			}
			if c.Config != nil {
				if err := os.WriteFile(filepath.Join(root, ".semiont", projectFileYAML), []byte(*c.Config), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if c.Refused {
				refused++
				if _, err := readKBIdentity(root); err == nil {
					t.Errorf("read a project file the case refuses:\n%s", orAbsent(c.Config))
				}
				if _, _, err := resolveRootArg(root); !projectFileRefused(err) {
					t.Errorf("a project file the case refuses was not refused as a root (%v)", err)
				}
				return
			}
			held++
			ident, err := readKBIdentity(root)
			if err != nil {
				t.Fatalf("refused a project file the case reads: %v", err)
			}
			got := identity{
				Name:     ident.name(root),
				Domain:   ident.domain(),
				Did:      ident.didWeb(),
				Resource: ident.resource(),
			}
			want := identity{Name: orAbsent(c.Name), Domain: orAbsent(c.Domain), Did: orAbsent(c.Did), Resource: orAbsent(c.Resource)}
			if got != want {
				t.Errorf("got %+v, want %+v", got, want)
			}
		})
	}
	if refused == 0 || held == 0 {
		t.Fatalf("the shared table has %d refused and %d read cases: a gate that runs nothing on one side passes on silence", refused, held)
	}
}
