package launcher

import "testing"

// The documented first run is `semiont start` then `semiont useradd`. It
// refused on a healthy stack — "No config recorded for this root, so there is
// no realm to administer. Start the stack first" — because it asked roots.json
// for the sticky PREFERENCE, which a bare start deliberately never writes (an
// unlaunchable --config must not become the default). The running stack knew
// its config the whole time: `start` records the resolved name in stack.json
// every time. useradd has no --config flag, so there was no way forward.
func TestRealmConfigComesFromTheRunningStack(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("XDG_DATA_HOME", "")
	root := t.TempDir()

	if got := configForRealm(root); got != "" {
		t.Errorf("with nothing running and nothing recorded, got %q, want empty", got)
	}

	// A bare start: stack.json carries the resolved config, roots.json carries
	// no preference. This is the case that refused.
	saveStack(&stackState{Runtime: "container", KBRoot: root, Config: "ollama-gemma", Services: map[string]serviceState{}})
	if got := configForRealm(root); got != "ollama-gemma" {
		t.Errorf("running stack's config = %q, want %q", got, "ollama-gemma")
	}

	// A stack running against a DIFFERENT root says nothing about this one.
	saveStack(&stackState{Runtime: "container", KBRoot: t.TempDir(), Config: "anthropic", Services: map[string]serviceState{}})
	if got := configForRealm(root); got != "" {
		t.Errorf("another root's stack leaked its config: %q", got)
	}

	// With no stack for this root, the sticky preference still answers.
	registerRootUse(root, false, "anthropic")
	if got := configForRealm(root); got != "anthropic" {
		t.Errorf("sticky preference = %q, want %q", got, "anthropic")
	}
}
