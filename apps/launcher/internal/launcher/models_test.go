package launcher

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
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

// The ollama-gemma roster binds two models across eight roles, most of them
// more than once.
func TestBindingModelsAreSortedAndDeduped(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	// A mixed roster lists remote models too — these ARE the models this stack
	// performs inference with, whoever serves them — each under the provider
	// its role names.
	st.Inference.Spec.Roster.Workers.Yield = &semiont.ArchivistRosterRole{Provider: semiont.ArchivistRosterRoleProviderAnthropic, Model: "claude-sonnet-4-5"}
	got := bindingModels(st)
	want := []servedModel{
		{Model: "claude-sonnet-4-5", Provider: "anthropic"},
		{Model: "gemma4:26b", Provider: "ollama"},
		{Model: "gemma4:e2b", Provider: "ollama"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v want %v", got, want)
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

// The vet gate is the whole safety story of document generation and template
// copying alike: NOTHING may write documents this launcher's own reading
// rejects. A refusal must also leave no file behind.
func TestWriteVettedStackRefusesUnstartable(t *testing.T) {
	root := t.TempDir()
	u := NewUI(true)
	generated := func() map[string][]byte {
		files, err := generateStack(genParams{Inference: "anthropic", Model: "m", EmbeddingModel: "nomic-embed-text", AnthropicEndpoint: "https://api.anthropic.com"}, "anthropic")
		if err != nil {
			t.Fatal(err)
		}
		return files
	}
	// A roster that binds every job, and no WorkerPool to run a worker from.
	bad := generated()
	delete(bad, stack.WorkerPoolFile)
	if writeVettedStack(u, root, bad) {
		t.Fatal("a roster binding jobs with no workers.yaml passed the vet")
	}
	if _, err := os.Stat(filepath.Join(root, stack.Dir)); !os.IsNotExist(err) {
		t.Errorf("the refusal left %s behind: %v", stack.Dir, err)
	}

	// And the generator's real output passes — the same gate, both verdicts.
	good := generated()
	if !writeVettedStack(u, root, good) {
		t.Fatal("the generator's own output failed the vet")
	}
	for path := range good {
		if _, err := os.Stat(filepath.Join(root, stack.Dir, path)); err != nil {
			t.Errorf("vetted document not placed: %v", err)
		}
	}
}

// `semiont listen` warns and delivers nothing for a channel the transport does
// not bridge, so the tour's "wait until someone is watching" step depends on
// presence being in the generated bridged set. Pinned here rather than trusted:
// the set is generated from registry.json, and a channel silently dropping out
// of it would leave the tour blocking forever on a stream that can never
// produce an event.
func TestPresenceChannelsAreSubscribable(t *testing.T) {
	for _, ch := range []bus.Channel{bus.SessionJoined, bus.SessionLeft} {
		if !bus.Bridged(ch) {
			t.Errorf("%s is not bridged — `semiont listen --channel %s` would warn and hang", ch, ch)
		}
	}
}
