package launcher

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"unicode"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// genFor: what `init --inference <inference>` builds the documents from.
func genFor(inference string) genParams {
	return genParams{Inference: inference, Model: "a-model", EmbeddingModel: "an-embedding", AnthropicEndpoint: "https://api.anthropic.com", GatewayPort: 4000}
}

// bornStack: the documents generateStack writes for p, read as a start reads
// them.
func bornStack(t *testing.T, p genParams, name string) *stack.Stack {
	t.Helper()
	files, err := generateStack(p, name)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := writeStackFiles(root, files); err != nil {
		t.Fatal(err)
	}
	st, err := stack.Load(root, name)
	if err != nil {
		t.Fatalf("--inference %s: a start does not read the generated documents: %v", p.Inference, err)
	}
	return st
}

// A KB born from `semiont init` must be one `semiont start` can bring up, and
// the dispatcher's queue is JetStream: a generated KnowledgeBase whose jobs
// type is anything else is one the launcher refuses.
func TestGeneratedStackSelectsAJobsDriverTheDispatcherCanRun(t *testing.T) {
	for _, inference := range []string{"anthropic", "ollama"} {
		m := bornStack(t, genFor(inference), inference).KnowledgeBase.Spec.Messaging
		if m.Jobs.Type != "jetstream" {
			t.Errorf("--inference %s: jobs driver is %q, want \"jetstream\" — the dispatcher's queue is JetStream", inference, m.Jobs.Type)
		}
		// The ledger's durability rides on this one: `nats` is what puts the
		// gateway's claims and retained replies in JetStream KV on the
		// daemon's /data store. In-process, they would live in one gateway's
		// memory — lost on restart, shared with no replica.
		if m.Signal.Type != "nats" {
			t.Errorf("--inference %s: signal driver is %q, want \"nats\" — the durable, shared ledger a forked KB gets", inference, m.Signal.Type)
		}
	}
}

// `--model-light` is an example in a comment, never an engine: the document
// still reads, every job's and actor's engine is --model, and the jobs the
// example names are jobs the engines have — an example naming none would
// break the engines of whoever follows it.
func TestGeneratedRefinementExampleNamesAJob(t *testing.T) {
	p := genFor("anthropic")
	p.ModelLight = "a-light-model"
	files, err := generateStack(p, "anthropic")
	if err != nil {
		t.Fatal(err)
	}
	text := string(files[filepath.Join(stack.InferenceDir, "anthropic.yaml")])
	inference, err := stack.Parse[stack.Inference]("anthropic.yaml", "Inference", []byte(text))
	if err != nil {
		t.Fatalf("the example breaks the document: %v", err)
	}
	for _, b := range boundEngines(inference.Spec.Engines) {
		if b.engine.Model != p.Model {
			t.Errorf("%s's engine is %s: --model-light is an example, never an engine", b.at, b.engine.Model)
		}
	}
	jobs := map[string]bool{}
	for _, job := range engineJobs() {
		jobs[job.name] = true
	}
	var comment []string
	for _, line := range strings.Split(text, "\n") {
		if example, isComment := strings.CutPrefix(line, "#"); isComment {
			comment = append(comment, example)
		}
	}
	example := strings.Join(comment, "\n")
	if !strings.Contains(example, p.ModelLight) {
		t.Fatalf("the document holds no example of the lighter model:\n%s", text)
	}
	named := 0
	for _, word := range strings.FieldsFunc(example, func(r rune) bool { return !unicode.IsLetter(r) }) {
		if api.Motivation(word).Valid() {
			named++
			if !jobs["mark."+word] {
				t.Errorf("the example names %s, and the engines have no mark.%s job", word, word)
			}
		}
	}
	if named == 0 {
		t.Errorf("the example names no job:\n%s", example)
	}
}

// A born KB must be startable by the command `init` itself prints next.
//
// `init` writes inference/<provider>.yaml — anthropic.yaml, ollama.yaml — and
// `start` defaults to `ollama-gemma`, which no born KB has. `start` consults
// the root's sticky config preference first, so init records the Inference
// document it wrote there; with an empty preference the first command a new
// user is told to run refuses whichever provider they chose.
func TestInitRecordsTheConfigItWroteAsTheRootsPreference(t *testing.T) {
	home := harness.Home(t)
	root := filepath.Join(home, "born")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)

	if code := Init([]string{"--yes", "--name", "born", "--domain", "example.github.io:born",
		"--inference", "ollama", "--model", "gemma3:270m", "--embedding", "ollama:nomic-embed-text"}); code != 0 {
		t.Fatalf("init exited %d", code)
	}

	pref := recordedConfig(root)
	if pref == "" {
		t.Fatal("init recorded no config preference, so `semiont start` falls through to its hardcoded default — which no born KB has a document for")
	}
	if _, err := os.Stat(filepath.Join(root, stack.InferencePath(pref))); err != nil {
		t.Errorf("init recorded %q as this root's config, but wrote no such Inference document: %v", pref, err)
	}
}

// `semiont init --yes` must produce a KB that starts: with no --inference and
// no --model it writes the documents all the same, or the very next command
// it prints — `semiont start` — cannot run.
//
// The defaults are ollama inference on a small model: the provider that needs
// no credential and the size that a first KB can actually pull.
func TestBareInitProducesAStartableKB(t *testing.T) {
	home := harness.Home(t)
	root := filepath.Join(home, "bare")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)

	// Every flag a caller MUST give: the did:web domain has no safe default
	// and init refuses to guess one. Nothing else.
	if code := Init([]string{"--yes", "--domain", "example.github.io:bare"}); code != 0 {
		t.Fatalf("a bare `init --yes --domain` exited %d", code)
	}

	pref := recordedConfig(root)
	if pref == "" {
		t.Fatal("no config preference recorded — `semiont start` would fall through to its hardcoded default")
	}
	st, err := stack.Load(root, pref)
	if err != nil {
		t.Fatalf("a start does not read the documents init wrote: %v", err)
	}
	if _, err := derivePlan(st, 8080, 0); err != nil {
		t.Fatalf("a start cannot plan the documents init wrote: %v", err)
	}
	providers := st.Inference.Spec.Providers
	if _, ollama := providers[api.EngineProviderOllama]; !ollama || len(providers) != 1 {
		t.Errorf("the bare KB's providers are %v, want Ollama alone — no credential needed", providers)
	}
}

// `init --inference anthropic` must write the documents without a key in the
// environment. The key is needed to START, not to be born — refusing at birth
// would leave the user with no documents at all rather than ones they can
// start once the key is set. Ollama's path gives the same answer to the same
// situation: it warns and proceeds when it cannot verify a model.
func TestAnthropicInitNeedsNoKeyToWriteAConfig(t *testing.T) {
	home := harness.Home(t)
	t.Setenv("ANTHROPIC_API_KEY", "")
	root := filepath.Join(home, "kb")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)

	if code := Init([]string{"--yes", "--domain", "pingel.org:kb", "--inference", "anthropic"}); code != 0 {
		t.Fatalf("init --inference anthropic exited %d with no ANTHROPIC_API_KEY set", code)
	}
	st, err := stack.Load(root, recordedConfig(root))
	if err != nil {
		t.Fatalf("no documents a start reads were written: %v", err)
	}
	// Needed at start, not at birth.
	if key := st.Inference.Spec.Providers[api.EngineProviderAnthropic].ApiKey; key == nil || key.FromEnv != "ANTHROPIC_API_KEY" {
		t.Errorf("the Inference document names the key as %+v, want the variable ANTHROPIC_API_KEY", key)
	}
	for _, b := range boundEngines(st.Inference.Spec.Engines) {
		if b.engine.Model == "" {
			t.Errorf("%s was written with an empty model", b.at)
		}
	}
}

// A born KB runs every daemon itself, and the launcher generates and keeps
// those daemons' passwords: a start of it reads no variable but its
// provider's key.
func TestInitWritesNoDaemonPassword(t *testing.T) {
	for inference, want := range map[string][]string{"anthropic": {"ANTHROPIC_API_KEY"}, "ollama": nil} {
		p := placed(t, bornStack(t, genFor(inference), inference))
		for _, role := range []string{"graph", "vectors", "identity-store", "messaging", "identity"} {
			if !p.placed(role) {
				t.Errorf("--inference %s: the born KB has somebody else run its %s", inference, role)
			}
		}
		if got := secretsRead(p, startOptions{}.includes); !slices.Equal(got, want) {
			t.Errorf("--inference %s: a start of the born KB reads %v, want %v", inference, got, want)
		}
	}
}
