package launcher

import "testing"

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
