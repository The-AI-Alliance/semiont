package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Ollama reports an untagged model as ":latest". A config naming it without
// a tag must still read as installed — getting this wrong turns every
// untagged model into a false MISSING, which is the one alarm this feature
// must never raise wrongly.
func TestNormalizeModelTag(t *testing.T) {
	for in, want := range map[string]string{
		"nomic-embed-text":        "nomic-embed-text:latest",
		"gemma4:26b":              "gemma4:26b",
		"nomic-embed-text:latest": "nomic-embed-text:latest",
		"registry.io/org/m":       "registry.io/org/m:latest",
	} {
		if got := normalizeModel(in); got != want {
			t.Errorf("normalizeModel(%q) = %q, want %q", in, got, want)
		}
	}
}

// Unreachable Ollama must read "unknown", never "missing": ignorance and a
// finding are different answers, and only one tells a user to pull something
// they may already have.
func TestUnreachableOllamaIsUnknownNotMissing(t *testing.T) {
	f := fetchModelFacts("http://127.0.0.1:1") // nothing listens here
	if f.found {
		t.Fatal("fetchModelFacts claimed success against a dead port")
	}
	if len(f.installed) != 0 || len(f.loaded) != 0 {
		t.Errorf("dead Ollama yielded facts: %+v", f)
	}
}

// Which provider serves a model is a PER-MODEL fact, and a ceiling keyed off
// the wrong one is worse than no ceiling: it would print Claude's window on a
// Gemma row. The row's driver is NOT that fact — a config can point workers at
// Anthropic while embedding runs on Ollama, and the inference row then lists
// Claude models under a driver of "ollama" (the same confusion that shipped
// "ollama pull claude-…", observed 2026-07-20). So the derivation refuses
// wherever the record cannot settle the question.
func TestCeilingProviderDerivation(t *testing.T) {
	for _, c := range []struct {
		name         string
		model        string
		driver       string
		ollamaServed []string
		want         string
		wantOK       bool
	}{
		{"ollama-served model", "gemma4:26b", "ollama", []string{"gemma4:26b"}, "ollama", true},
		{"remote model on a remote row", "claude-sonnet-4-5", "anthropic", []string{}, "anthropic", true},
		{"ollama-served model on a remote row", "nomic-embed-text", "anthropic", []string{"nomic-embed-text"}, "ollama", true},
		// The bug shape: Ollama does not serve it, yet the row claims Ollama.
		// Nothing in the record names who does — so nothing is claimed.
		{"remote model on an ollama row", "claude-sonnet-4-5", "ollama", []string{"gemma4:26b"}, "", false},
		// A record written before ollamaServed existed: the driver is the only
		// signal, and trusting it alone is precisely what shipped the bug.
		{"record predating ollamaServed", "gemma4:26b", "ollama", nil, "", false},
		{"no driver recorded", "gemma4:26b", "", []string{}, "", false},
	} {
		got, ok := ceilingProvider(c.model, c.driver, c.ollamaServed)
		if got != c.want || ok != c.wantOK {
			t.Errorf("%s: ceilingProvider(%q, %q, %v) = (%q, %v), want (%q, %v)",
				c.name, c.model, c.driver, c.ollamaServed, got, ok, c.want, c.wantOK)
		}
	}
}

// The ceiling cell reads as a ceiling, does not round one away, and words
// itself exactly as the CollaborationPanel does — the same model must read the
// same in the terminal and in the browser.
func TestCeilingCell(t *testing.T) {
	for _, c := range []struct {
		ctx, out float32
		want     string
	}{
		{200000, 64000, "200K in / 64K out"},
		{128000, 128000, "128K window"}, // shared window: one figure, per the schema's sentinel
		{8192, 8192, "8.2K window"},
		{1000000, 128000, "1M in / 128K out"},
		{512, 512, "512 window"},
	} {
		got := ceilingCell(semiont.InferenceLimits{ContextTokens: c.ctx, MaxOutputTokens: c.out})
		if got != c.want {
			t.Errorf("ceilingCell(%v, %v) = %q, want %q", c.ctx, c.out, got, c.want)
		}
	}
}

func TestBindingModelsAreSortedAndDeduped(t *testing.T) {
	env := &envConfig{
		Actors:  map[string]bindingCfg{},
		Workers: map[string]bindingCfg{},
	}
	mk := func(typ, model string) bindingCfg {
		var b bindingCfg
		b.Inference.Type, b.Inference.Model = typ, model
		return b
	}
	env.Actors["gatherer"] = mk("ollama", "gemma4:26b")
	env.Actors["matcher"] = mk("ollama", "gemma4:26b") // dupe
	env.Workers["tag"] = mk("ollama", "gemma4:e2b")
	// A mixed config lists remote models too — these ARE the models this
	// stack performs inference with, whoever serves them.
	env.Workers["gen"] = mk("anthropic", "claude-sonnet-4-5")
	got := bindingModels(env)
	want := []string{"claude-sonnet-4-5", "gemma4:26b", "gemma4:e2b"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

// The iCloud zones: ~/Library/Mobile Documents is always iCloud-managed;
// Desktop/Documents only when the Finder sync setting says so (checked by
// the darwin-only caller, not here). The separator guard matters: a sibling
// named "Desktopia" must not match.
func TestICloudZone(t *testing.T) {
	home := "/Users/x"
	for root, want := range map[string]string{
		"/Users/x/Desktop/kb":                      "desktop",
		"/Users/x/Documents/deep/nested/kb":        "desktop",
		"/Users/x/Library/Mobile Documents/foo/kb": "mobile",
		"/Users/x/Developer/kb":                    "",
		"/Users/x/Desktopia/kb":                    "",
		"/Users/x/Desktop":                         "desktop",
		"/elsewhere/Desktop/kb":                    "",
	} {
		if got := icloudZone(root, home); got != want {
			t.Errorf("icloudZone(%q) = %q, want %q", root, got, want)
		}
	}
	if got := icloudZone("/Users/x/Desktop/kb", ""); got != "" {
		t.Errorf("empty home must classify nothing, got %q", got)
	}
}

// The vet gate is the whole safety story of config generation and template
// copying alike: NOTHING may write a semiontconfig this launcher's own
// deriver rejects. A refusal must also leave no file behind.
func TestWriteVettedConfigRefusesUnstartable(t *testing.T) {
	root := t.TempDir()
	u := newUI(true)
	bad := "[environments.local.graph]\ntype = \"janusgraph\"\nuri = \"bolt://${NEO4J_HOST}:7687\"\n"
	if writeVettedConfig(u, root, "bad", bad) {
		t.Fatal("an unknown driver type passed the vet")
	}
	dir := filepath.Join(root, ".semiont", "semiontconfig")
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		t.Errorf("refusal left a file behind: %s", e.Name())
	}

	// And the generator's real output passes — the same gate, both verdicts.
	good := generateSemiontconfig(genParams{Inference: "anthropic", Model: "m", EmbeddingModel: "nomic-embed-text"})
	if !writeVettedConfig(u, root, "good", good) {
		t.Fatal("the generator's own output failed the vet")
	}
	if _, err := os.Stat(filepath.Join(dir, "good.toml")); err != nil {
		t.Fatalf("vetted config not placed: %v", err)
	}
}

// The subscriber count is the only thing standing between "sent" and "seen",
// so what each value licenses the CLI to SAY is the deliverable — not the
// number. Three genuinely different answers; conflating any two of them is
// how a tour script ends up trusting a ✓ that meant nothing.
func TestAudienceNote(t *testing.T) {
	u := newUI(true) // no ANSI, so the assertions are about words
	for _, c := range []struct {
		name        string
		subscribers int
		want        string
		absent      string
	}{
		{"nobody listening is said plainly", 0, "nothing is subscribed to beckon:focus", "no delivery confirmation"},
		{"an unreadable count claims nothing", -1, "no delivery confirmation", "nothing is subscribed"},
		{"one subscriber, still not delivery", 1, "1 subscriber", "1 subscribers"},
		{"several subscribers", 4, "4 subscribers", "nothing is subscribed"},
	} {
		got := audienceNote(u, c.subscribers, "beckon:focus")
		if !strings.Contains(got, c.want) {
			t.Errorf("%s: audienceNote(%d) = %q, want it to contain %q", c.name, c.subscribers, got, c.want)
		}
		if c.absent != "" && strings.Contains(got, c.absent) {
			t.Errorf("%s: audienceNote(%d) = %q, must not contain %q", c.name, c.subscribers, got, c.absent)
		}
	}
	// A positive count must never be read as delivery.
	if got := audienceNote(u, 3, "beckon:focus"); !strings.Contains(got, "no confirmation anyone looked") {
		t.Errorf("a subscriber count must not be dressed up as delivery: %q", got)
	}
}

// `semiont listen` warns and delivers nothing for a channel the transport does
// not bridge, so the tour's "wait until someone is watching" step depends on
// presence being in the generated bridged set. Pinned here rather than trusted:
// the set is generated from registry.json, and a channel silently dropping out
// of it would leave the tour blocking forever on a stream that can never
// produce an event (GUIDED-TOUR P7).
func TestPresenceChannelsAreSubscribable(t *testing.T) {
	for _, ch := range []bus.Channel{bus.SessionJoined, bus.SessionLeft} {
		if !bus.Bridged(ch) {
			t.Errorf("%s is not bridged — `semiont listen --channel %s` would warn and hang", ch, ch)
		}
	}
}
