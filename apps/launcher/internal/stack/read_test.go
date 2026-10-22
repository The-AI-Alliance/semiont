package stack

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"
)

// repository: the repository's root, which the cases' paths are under.
var repository = filepath.Join("..", "..", "..", "..")

// stackCase: one case of specs/src/stack/cases.json.
type stackCase struct {
	Why      string         `json:"why"`
	Schema   string         `json:"schema"`
	Document *string        `json:"document"`
	Base     string         `json:"base"`
	Patch    map[string]any `json:"patch"`
	Verdict  string         `json:"verdict"`
	At       string         `json:"at"`
	Reason   string         `json:"reason"`
}

func readCases(t *testing.T) []stackCase {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(repository, "specs", "src", "stack", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []stackCase `json:"cases"`
	}
	if err := json.Unmarshal(text, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("specs/src/stack/cases.json has no cases: this test would pass for the wrong reason")
	}
	return table.Cases
}

// mergePatch: a JSON merge patch (RFC 7396) applied to target.
func mergePatch(target, patch any) any {
	fields, isObject := patch.(map[string]any)
	if !isObject {
		return patch
	}
	out := map[string]any{}
	if base, ok := target.(map[string]any); ok {
		for key, value := range base {
			out[key] = value
		}
	}
	for key, value := range fields {
		if value == nil {
			delete(out, key)
		} else {
			out[key] = mergePatch(out[key], value)
		}
	}
	return out
}

// documentOf: a case's document as YAML text — its own, or its base with its
// patch applied.
func documentOf(t *testing.T, c stackCase) []byte {
	t.Helper()
	if c.Document != nil {
		return []byte(*c.Document)
	}
	text, err := os.ReadFile(filepath.Join(repository, filepath.FromSlash(c.Base)))
	if err != nil {
		t.Fatal(err)
	}
	var base any
	if err := yaml.Unmarshal(text, &base); err != nil {
		t.Fatal(err)
	}
	patched, err := yaml.Marshal(mergePatch(base, map[string]any(c.Patch)))
	if err != nil {
		t.Fatal(err)
	}
	return patched
}

// Every shared case is accepted, or refused where and for the reason it
// says, as lint:spec-stack holds it to the same schemas; and a refusal names
// the line it is on.
func TestEveryCaseIsReadAsItSays(t *testing.T) {
	for _, c := range readCases(t) {
		t.Run(c.Why, func(t *testing.T) {
			refusals, err := Check(c.Schema, documentOf(t, c))
			if err != nil {
				t.Fatal(err)
			}
			switch c.Verdict {
			case "accepted":
				if len(refusals) > 0 {
					t.Fatalf("refused, and the case says it is accepted: %+v", refusals)
				}
			case "refused":
				found := false
				for _, refusal := range refusals {
					if refusal.Line < 1 {
						t.Errorf("a refusal names no line: %+v", refusal)
					}
					found = found || (refusal.At == c.At && refusal.Reason == c.Reason)
				}
				if !found {
					t.Fatalf("not refused at %s for %s: %+v", c.At, c.Reason, refusals)
				}
			default:
				t.Fatalf("the case's verdict %q is neither accepted nor refused", c.Verdict)
			}
		})
	}
}

// A refusal names the line the refused value is on, and the line of the
// object a missing field belongs in.
func TestARefusalNamesItsLine(t *testing.T) {
	text := []byte(`apiVersion: semiont.the-ai-alliance.github.io/v1alpha1
kind: WorkerPool
metadata:
  name: workers
spec:
  knowledgeBase: knowledge-base
  logLevel: info
  worker:
    imgae: ghcr.io/the-ai-alliance/semiont-worker:latest
    resources: { limits: { memory: 2G } }
`)
	refusals, err := Check("WorkerPool", text)
	if err != nil {
		t.Fatal(err)
	}
	lines := map[string]int{}
	for _, refusal := range refusals {
		lines[refusal.Reason+" "+refusal.At] = refusal.Line
	}
	if got := lines["unknown-field /spec/worker/imgae"]; got != 9 {
		t.Errorf("the misspelled field is on line 9, and the refusal says %d: %+v", got, refusals)
	}
	if got := lines["missing-required /spec/worker/image"]; got != 8 {
		t.Errorf("the missing image belongs in the worker, on line 8, and the refusal says %d: %+v", got, refusals)
	}
}

// Each document of the fixture knowledge base reads into its type, and a
// refused one is refused with its file and kind.
func TestTheFixtureDocumentsReadIntoTheirTypes(t *testing.T) {
	semiont := filepath.Join(repository, "apps", "launcher", "testdata", "kb", ".semiont")
	stack := filepath.Join(semiont, "stack")

	kb, err := Read[KnowledgeBase](filepath.Join(stack, "knowledge-base.yaml"), "KnowledgeBase")
	if err != nil {
		t.Fatal(err)
	}
	if kb.Spec.Gateway.Port != 4000 || kb.Spec.Issuer.Ref == nil || *kb.Spec.Issuer.Ref != "issuer" || kb.Spec.Messaging.Image == nil {
		t.Errorf("the KnowledgeBase did not read into its type: %+v", kb.Spec)
	}
	index, err := Read[KnowledgeIndex](filepath.Join(stack, "index.yaml"), "KnowledgeIndex")
	if err != nil {
		t.Fatal(err)
	}
	if index.Spec.KnowledgeBase != kb.Metadata.Name || index.Spec.Embedding.Chunking.ChunkSize != 512 || index.Spec.Librarian.Search.SemanticFloor != 0.6 {
		t.Errorf("the KnowledgeIndex did not read into its type: %+v", index.Spec)
	}
	issuer, err := Read[Issuer](filepath.Join(stack, "issuer.yaml"), "Issuer")
	if err != nil {
		t.Fatal(err)
	}
	if issuer.Metadata.Name != *kb.Spec.Issuer.Ref || issuer.Spec.Database.Image == nil {
		t.Errorf("the Issuer did not read into its type: %+v", issuer.Spec)
	}
	if _, err := Read[WorkerPool](filepath.Join(stack, "workers.yaml"), "WorkerPool"); err != nil {
		t.Fatal(err)
	}
	inference, err := Read[Inference](filepath.Join(stack, "inference", "anthropic.yaml"), "Inference")
	if err != nil {
		t.Fatal(err)
	}
	anthropic, named := inference.Spec.Providers["anthropic"]
	if !named || anthropic.ApiKey == nil || anthropic.ApiKey.FromEnv != "ANTHROPIC_API_KEY" || inference.Spec.Roster.Workers.Yield == nil {
		t.Errorf("the Inference did not read into its type: %+v", inference.Spec)
	}
	project, err := Read[ProjectConfig](filepath.Join(semiont, "config.yaml"), "ProjectConfig")
	if err != nil {
		t.Fatal(err)
	}
	if project.Site.Domain != "example.github.io:test-kb" || !project.Git.Sync {
		t.Errorf("the project file did not read into its type: %+v", project)
	}

	_, err = Read[WorkerPool](filepath.Join(stack, "index.yaml"), "WorkerPool")
	var refused *Refused
	if !errors.As(err, &refused) || refused.Kind != "WorkerPool" || len(refused.Refusals) == 0 {
		t.Fatalf("a KnowledgeIndex read as a WorkerPool must be refused, and was: %v", err)
	}
}
