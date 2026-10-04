package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
	toml "github.com/pelletier/go-toml/v2"
)

// A KB born from `semiont init` must be one `semiont start` can bring up, and
// the dispatcher's queue is JetStream: a generated config without
// [jobs] type = "jetstream" is one the launcher refuses.
func TestGeneratedConfigSelectsAJobsDriverTheDispatcherCanRun(t *testing.T) {
	for _, inference := range []string{"anthropic", "ollama"} {
		cfg := generateSemiontconfig(genParams{
			Inference: inference, Model: "a-model", EmbeddingModel: "an-embedding",
		})
		// Parsed, not grepped: a section that exists with the wrong type is the
		// failure worth catching, and a substring search cannot tell which
		// section a `type` line belongs to.
		var parsed struct {
			Environments map[string]struct {
				Jobs struct {
					Type string `toml:"type"`
				} `toml:"jobs"`
				Signal struct {
					Type string `toml:"type"`
				} `toml:"signal"`
			} `toml:"environments"`
		}
		if err := toml.Unmarshal([]byte(cfg), &parsed); err != nil {
			t.Fatalf("--inference %s: the generated config does not parse: %v", inference, err)
		}
		local := parsed.Environments["local"]
		if local.Jobs.Type != "jetstream" {
			t.Errorf("--inference %s: jobs driver is %q, want \"jetstream\" — the dispatcher's queue is JetStream", inference, local.Jobs.Type)
		}
		// The ledger's durability rides on this one: `nats` is what puts the
		// gateway's claims and retained replies in JetStream KV on the
		// daemon's /data store. In-process, they would live in one gateway's
		// memory — lost on restart, shared with no replica.
		if local.Signal.Type != "nats" {
			t.Errorf("--inference %s: signal driver is %q, want \"nats\" — the durable, shared ledger a forked KB gets", inference, local.Signal.Type)
		}
	}
}

// A born KB must be startable by the command `init` itself prints next.
//
// `init` writes <provider>.toml — anthropic.toml, ollama.toml — and `start`
// defaults to `ollama-gemma`, which no born KB has. So the first thing a new
// user is told to run refused with "Config not found" whichever provider they
// chose. `start` already consults the root's sticky config preference; init
// registered the root with an empty one.
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
		t.Fatal("init recorded no config preference, so `semiont start` falls through to its hardcoded default — which no born KB has a file for")
	}
	if _, err := os.Stat(filepath.Join(root, configDir, pref+".toml")); err != nil {
		t.Errorf("init recorded %q as this root's config, but wrote no such file: %v", pref, err)
	}
}

// `semiont init --yes` must produce a KB that starts. It did not: with no
// --inference it wrote no config at all and told the user to "add a config",
// and with --inference ollama it refused without --model. Both leave the very
// next command it prints — `semiont start` — unable to run.
//
// Defaults now: ollama inference on a small model, which is the provider that
// needs no credential and the size that a first KB can actually pull.
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
	cfg, err := os.ReadFile(filepath.Join(root, configDir, pref+".toml"))
	if err != nil {
		t.Fatalf("init wrote no config: %v", err)
	}
	for _, want := range []string{
		"[environments.local.inference.ollama]", // no credential needed
		"[environments.local.jobs]",             // or the dispatcher refuses
		"[environments.local.embedding]",
	} {
		if !strings.Contains(string(cfg), want) {
			t.Errorf("the bare config declares no %s", want)
		}
	}
	// It must also survive the launcher's own deriver, which is what
	// writeVettedConfig already demands — proven by init having exited 0.
}

// `init --inference anthropic` must write a config without a key in the
// environment. The key is needed to START, not to be born — and refusing at
// birth left the user with no config at all rather than one they could fill
// in. Ollama's path already warned and proceeded when it could not verify a
// model; anthropic refused. Same situation, opposite answer.
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
	pref := recordedConfig(root)
	cfg, err := os.ReadFile(filepath.Join(root, configDir, pref+".toml"))
	if err != nil {
		t.Fatalf("no config written: %v", err)
	}
	for _, want := range []string{
		"[environments.local.inference.anthropic]",
		`apiKey = "${ANTHROPIC_API_KEY}"`, // needed at start, not at birth
		"[environments.local.jobs]",
	} {
		if !strings.Contains(string(cfg), want) {
			t.Errorf("the config declares no %s", want)
		}
	}
	if strings.Contains(string(cfg), `model = ""`) {
		t.Error("a binding was written with an empty model")
	}
}

// A born KB names no password for a daemon the launcher runs — the launcher
// generates and keeps those, and refuses a config that names one.
func TestInitWritesNoDaemonPassword(t *testing.T) {
	for _, inference := range []string{"anthropic", "ollama"} {
		cfg := generateSemiontconfig(genParams{Inference: inference})
		for _, line := range strings.Split(cfg, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "password") {
				t.Errorf("--inference %s: the born config names a daemon password: %s", inference, line)
			}
		}
	}
}
