package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// servingAssessing: the anthropic fixture with the `mark` jobs of assessing
// served by provider's model, reached as entry states.
func servingAssessing(t *testing.T, provider semiont.ArchivistRosterRoleProvider, model string, entry stack.Provider) *stack.Stack {
	t.Helper()
	st := fixtureStack(t, "anthropic")
	st.Inference.Spec.Providers[provider] = entry
	st.Inference.Spec.Roster.Workers.Mark.Assessing = &semiont.ArchivistRosterRole{Provider: provider, Model: model}
	return st
}

// A server a deployment runs or reaches is an agent at the address its entry
// in the Inference document states, with a key only where the entry names
// one.
func TestWorkerDocumentServesAProviderAtTheAddressItsEntryStates(t *testing.T) {
	baseURL := "http://vllm.internal:8000/v1"
	b, err := workerDocument(placed(t, servingAssessing(t, semiont.ArchivistRosterRoleProviderVllm, "served-model", stack.Provider{BaseURL: &baseURL})))
	if err != nil {
		t.Fatal(err)
	}
	doc := workerDocumentFrom(t, b)
	var served *semiont.WorkerAgentConfig
	for i := range doc.Agents {
		if doc.Agents[i].Agent.Provider == semiont.ArchivistRosterRoleProviderVllm {
			served = &doc.Agents[i]
		}
	}
	if served == nil {
		t.Fatalf("no agent of the document is vllm's:\n%s", b)
	}
	if served.Agent.Model != "served-model" || served.BaseUrl != baseURL || served.ApiKeyEnv != nil {
		t.Errorf("the vllm agent is %+v, want served-model at the entry's address with no key", *served)
	}
}

// A provider the launcher does not run has its key named as its entry names
// it. A worker's document says where the image carries the model catalogue,
// whatever its providers, and so does the Librarian's.
func TestWorkerDocumentNamesAProvidersKeyAndTheModelCatalogue(t *testing.T) {
	baseURL := "https://api.openai.com/v1"
	p := placed(t, servingAssessing(t, semiont.ArchivistRosterRoleProviderOpenai, "gpt-listed",
		stack.Provider{BaseURL: &baseURL, ApiKey: &stack.SecretRef{FromEnv: "OPENAI_API_KEY"}}))
	b, err := workerDocument(p)
	if err != nil {
		t.Fatal(err)
	}
	doc := workerDocumentFrom(t, b)
	if doc.ModelCatalogue != modelCatalogueTarget {
		t.Errorf("the document's model catalogue is %q, want %s", doc.ModelCatalogue, modelCatalogueTarget)
	}
	plain, err := workerDocument(placed(t, fixtureStack(t, "ollama-gemma")))
	if err != nil {
		t.Fatal(err)
	}
	if got := workerDocumentFrom(t, plain).ModelCatalogue; got != modelCatalogueTarget {
		t.Errorf("a worker of Ollama is told its model catalogue is %q, want %s", got, modelCatalogueTarget)
	}
	lb, err := librarianDocument(placed(t, fixtureStack(t, "anthropic")))
	if err != nil {
		t.Fatal(err)
	}
	if got := librarianDocumentFrom(t, lb).ModelCatalogue; got != modelCatalogueTarget {
		t.Errorf("the Librarian is told its model catalogue is %q, want %s", got, modelCatalogueTarget)
	}
	var keyed bool
	for _, agent := range doc.Agents {
		if agent.Agent.Provider == semiont.ArchivistRosterRoleProviderOpenai {
			keyed = agent.ApiKeyEnv != nil && *agent.ApiKeyEnv == "OPENAI_API_KEY" && agent.BaseUrl == baseURL
		}
	}
	if !keyed {
		t.Errorf("no agent is OpenAI's at its entry's address under OPENAI_API_KEY:\n%s", b)
	}
	if handed := serviceSecrets(p)["worker"]; !contains(handed, "OPENAI_API_KEY") {
		t.Errorf("the worker is not handed OPENAI_API_KEY, which its document names: %v", handed)
	}
}

// A provider a role names is one the Inference document says how to reach:
// one with no entry is refused by the plan, naming the role; one whose entry
// states no address, and that the launcher keeps none for, is refused where
// the worker's document is written, naming the entry.
func TestAProviderWithNoAddressIsRefused(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	st.Inference.Spec.Roster.Workers.Mark.Assessing = &semiont.ArchivistRosterRole{Provider: semiont.ArchivistRosterRoleProviderTogether, Model: "m"}
	mustRefuse(t, st, st.Files.Inference+": spec.roster.workers.mark.assessing.provider", `"together"`, "spec.providers.together")

	st = servingAssessing(t, semiont.ArchivistRosterRoleProviderTogether, "m", stack.Provider{})
	_, err := workerDocument(placed(t, st))
	if want := st.Files.Inference + ": spec.providers.together.baseURL"; err == nil || !strings.Contains(err.Error(), want) {
		t.Errorf("want a refusal naming %s, got %v", want, err)
	}
}

// The path a document names is where each image has the file.
func TestModelCatalogueIsWhereTheImagesCarryIt(t *testing.T) {
	for _, service := range []string{"worker", "librarian"} {
		df, err := os.ReadFile(filepath.Join("..", "..", "..", service, "Dockerfile"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(df), " "+modelCatalogueTarget+"\n") {
			t.Errorf("the %s image does not carry the model catalogue at %s", service, modelCatalogueTarget)
		}
	}
}
