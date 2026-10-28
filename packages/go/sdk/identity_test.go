package semiont_test

// How a knowledge base and its principals are named, held to the tables every
// implementation runs: specs/src/principals/cases.json for a person and a
// software agent, and specs/src/kb-identity/cases.json for the knowledge base
// itself, of which the SDK runs every case that states a domain: reading a
// knowledge base's own configuration is the launcher's and the gateway's.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

func readTable(t *testing.T, into any, path ...string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(append([]string{"..", "..", "specs", "src"}, path...)...))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, into); err != nil {
		t.Fatal(err)
	}
}

type principals struct {
	People []struct {
		Why, Domain, Subject, Did string
	} `json:"people"`
	Agents []struct {
		Why, Domain, Provider, Model, Did, Email, Name string
	} `json:"agents"`
}

func TestAPersonIsNamedAsTheTableNamesOne(t *testing.T) {
	var table principals
	readTable(t, &table, "principals", "cases.json")
	if len(table.People) < 8 {
		t.Fatalf("the table names %d people: a runner that reads too few passes on silence", len(table.People))
	}
	for _, row := range table.People {
		did, err := semiont.PersonDid(row.Domain, row.Subject)
		if err != nil || did.String() != row.Did {
			t.Errorf("%s: PersonDid(%q, %q) = %q, %v; want %q", row.Why, row.Domain, row.Subject, did, err, row.Did)
		}
	}
}

func TestASoftwareAgentIsNamedAsTheTableNamesOne(t *testing.T) {
	var table principals
	readTable(t, &table, "principals", "cases.json")
	if len(table.Agents) < 5 {
		t.Fatalf("the table names %d agents: a runner that reads too few passes on silence", len(table.Agents))
	}
	for _, row := range table.Agents {
		did, err := semiont.AgentDid(row.Domain, row.Provider, row.Model)
		if err != nil || did.String() != row.Did {
			t.Errorf("%s: AgentDid = %q, %v; want %q", row.Why, did, err, row.Did)
		}
		if address := semiont.AgentAddress(row.Domain, row.Provider, row.Model); address != row.Email {
			t.Errorf("%s: AgentAddress = %q, want %q", row.Why, address, row.Email)
		}
		if name := semiont.AgentName(row.Provider, row.Model); name != row.Name {
			t.Errorf("%s: AgentName = %q, want %q", row.Why, name, row.Name)
		}
	}
}

func TestAKnowledgeBaseIsNamedByItsDomain(t *testing.T) {
	var table struct {
		Cases []struct {
			Why      string  `json:"why"`
			Domain   *string `json:"domain"`
			Did      *string `json:"did"`
			Resource *string `json:"resource"`
		} `json:"cases"`
	}
	readTable(t, &table, "kb-identity", "cases.json")
	ran := 0
	for _, row := range table.Cases {
		if row.Domain == nil {
			continue
		}
		ran++
		if row.Did == nil || row.Resource == nil {
			t.Fatalf("%s: states a domain and no did or resource", row.Why)
		}
		did, err := semiont.KbDid(*row.Domain)
		if err != nil || did.String() != *row.Did {
			t.Errorf("%s: KbDid(%q) = %q, %v; want %q", row.Why, *row.Domain, did, err, *row.Did)
		}
		if resource := semiont.KbResource(*row.Domain); resource != *row.Resource {
			t.Errorf("%s: KbResource(%q) = %q, want %q", row.Why, *row.Domain, resource, *row.Resource)
		}
	}
	if ran < 5 {
		t.Fatalf("the table states %d knowledge bases with a domain: a runner that reads too few passes on silence", ran)
	}
}
