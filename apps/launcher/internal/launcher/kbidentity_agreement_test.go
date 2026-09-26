package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestKBIdentityAgreesWithTheSharedTable runs every case in
// specs/src/kb-identity/cases.json through the launcher's readers. The
// TypeScript readers run the same table (packages/core
// kb-identity-agreement.test.ts); together they gate a mirror that spans
// languages and cannot be generated. Absent is "" here and null in the table.
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
			Name     string  `json:"name"`
			Domain   *string `json:"domain"`
			Did      *string `json:"did"`
			Resource *string `json:"resource"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the shared table has no cases: a gate that runs nothing passes on silence")
	}

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
				if err := os.WriteFile(filepath.Join(root, ".semiont", "config"), []byte(*c.Config), 0o644); err != nil {
					t.Fatal(err)
				}
			}

			domain := committedDomain(root)
			got := identity{
				Name:     effectiveKBName(root),
				Domain:   domain,
				Did:      (&kbIdentity{Domain: domain}).didWeb(),
				Resource: kbResource(domain),
			}
			want := identity{Name: c.Name, Domain: orAbsent(c.Domain), Did: orAbsent(c.Did), Resource: orAbsent(c.Resource)}
			if got != want {
				t.Errorf("got %+v, want %+v", got, want)
			}
		})
	}
}
