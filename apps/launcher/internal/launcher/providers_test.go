package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// The providers a refusal lists are the ones the spec names: each is one the
// generated vocabulary accepts, and a name it does not have is none of them.
func TestProviderNamesAreTheSpecs(t *testing.T) {
	names := strings.Split(strings.ReplaceAll(providerNames, " or ", ", "), ", ")
	if len(names) != 7 {
		t.Fatalf("a refusal lists %d providers, want the spec's seven: %q", len(names), providerNames)
	}
	for _, name := range names {
		if !semiont.ArchivistRosterRoleProvider(name).Valid() {
			t.Errorf("a refusal lists %q, which the spec does not name", name)
		}
	}
	if semiont.ArchivistRosterRoleProvider("mistral").Valid() {
		t.Error("the spec names mistral: the tests of a provider Semiont has no client for use it as one")
	}
}

// A server a deployment runs or reaches is an agent at the address its section
// states, with a key only where the section names one.
func TestWorkerDocumentServesAProviderAtTheAddressItsSectionStates(t *testing.T) {
	text := workerDocFixture +
		"\n[environments.local.inference.vllm]\nplatform = \"external\"\nbaseURL = \"http://vllm.internal:8000/v1\"\n" +
		"\n[environments.local.workers.mark.assessing.inference]\ntype = \"vllm\"\nmodel = \"served-model\"\n"
	b, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, nil)
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
	if served.Agent.Model != "served-model" || served.BaseUrl != "http://vllm.internal:8000/v1" || served.ApiKeyEnv != nil {
		t.Errorf("the vllm agent is %+v, want served-model at the section's address with no key", *served)
	}
}

// A provider the launcher does not run has its key named as its section
// names it. A worker's document says where the image carries the model
// catalogue, whatever its providers, and so does the Librarian's.
func TestWorkerDocumentNamesAProvidersKeyAndTheModelCatalogue(t *testing.T) {
	text := workerDocFixture +
		"\n[environments.local.inference.openai]\nplatform = \"external\"\nbaseURL = \"https://api.openai.com/v1\"\napiKey = \"${OPENAI_API_KEY}\"\n" +
		"\n[environments.local.workers.mark.assessing.inference]\ntype = \"openai\"\nmodel = \"gpt-listed\"\n"
	env := envFrom(t, text)
	b, err := workerDocument(env, "local", "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	doc := workerDocumentFrom(t, b)
	if doc.ModelCatalogue != modelCatalogueTarget {
		t.Errorf("the document's model catalogue is %q, want %s", doc.ModelCatalogue, modelCatalogueTarget)
	}
	plain, err := workerDocument(envFrom(t, workerDocFixture), "local", "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := workerDocumentFrom(t, plain).ModelCatalogue; got != modelCatalogueTarget {
		t.Errorf("a worker of Anthropic and Ollama is told its model catalogue is %q, want %s", got, modelCatalogueTarget)
	}
	lb, err := librarianDocument(envFrom(t, librarianDocFixture), "local", "test-kb", "container", "192.168.64.1", 8080, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := librarianDocumentFrom(t, lb).ModelCatalogue; got != modelCatalogueTarget {
		t.Errorf("the Librarian is told its model catalogue is %q, want %s", got, modelCatalogueTarget)
	}
	var keyed bool
	for _, agent := range doc.Agents {
		if agent.Agent.Provider == semiont.ArchivistRosterRoleProviderOpenai {
			keyed = agent.ApiKeyEnv != nil && *agent.ApiKeyEnv == "OPENAI_API_KEY" && agent.BaseUrl == "https://api.openai.com/v1"
		}
	}
	if !keyed {
		t.Errorf("no agent is OpenAI's at its section's address under OPENAI_API_KEY:\n%s", b)
	}
	if !contains(workerNamedVars(env), "OPENAI_API_KEY") {
		t.Errorf("the worker is not handed OPENAI_API_KEY, which its document names: %v", workerNamedVars(env))
	}
}

// A provider the launcher keeps no address for is refused, by its section,
// where the section states none or is not there.
func TestWorkerDocumentRefusesAProviderWithNoAddress(t *testing.T) {
	binding := "\n[environments.local.workers.mark.assessing.inference]\ntype = \"together\"\nmodel = \"m\"\n"
	for why, text := range map[string]string{
		"no section":            workerDocFixture + binding,
		"a section, no baseURL": workerDocFixture + "\n[environments.local.inference.together]\nplatform = \"external\"\n" + binding,
	} {
		_, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, nil)
		if err == nil || !strings.Contains(err.Error(), "[environments.local.inference.together]") {
			t.Errorf("%s: want a refusal naming the section, got %v", why, err)
		}
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
