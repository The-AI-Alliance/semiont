package launcher

import (
	"os"
	"path/filepath"
	"testing"
)

// A moved KB re-registers its did at the new path; the old path's row is
// then a corpse nothing else removes — it clutters the listing and makes
// the basename ambiguous for --root. Re-registration drops rows claiming
// the SAME did at OTHER paths that no longer exist on disk; a same-did row
// whose path still exists stays (two live clones are real, not a corpse).
func TestReRegistrationDropsMovedKBCorpse(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("XDG_DATA_HOME", "")

	kb := filepath.Join(t.TempDir(), "family")
	if err := os.MkdirAll(filepath.Join(kb, ".semiont"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := "[project]\nname = \"family\"\n[site]\ndomain = \"pingel.org\"\n"
	if err := os.WriteFile(filepath.Join(kb, ".semiont", "config"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}

	liveTwin := t.TempDir() // same did, path EXISTS — must survive
	reg := rootsRegistry{Schema: 1, Roots: []rootEntry{
		{Path: "/gone/old/family", Did: "did:web:pingel.org"},
		{Path: liveTwin, Did: "did:web:pingel.org"},
		{Path: "/gone/unrelated", Did: "did:web:other.example"},
	}}
	saveRoots(reg)

	registerRootUse(kb, false, "")

	got := loadRoots()
	paths := map[string]bool{}
	for _, e := range got.Roots {
		paths[e.Path] = true
	}
	if paths["/gone/old/family"] {
		t.Error("the moved KB's corpse row (same did, path gone) survived re-registration")
	}
	if !paths[liveTwin] {
		t.Error("a same-did row whose path still exists was dropped — two live clones are not a corpse")
	}
	if !paths["/gone/unrelated"] {
		t.Error("a missing row with a DIFFERENT did was dropped — only the re-registered identity's corpses may go")
	}
	if !paths[kb] {
		t.Error("the re-registered root is absent")
	}
}
