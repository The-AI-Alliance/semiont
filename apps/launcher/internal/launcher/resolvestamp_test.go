package launcher

import (
	"os"
	"path/filepath"
	"testing"
)

// SHARED-STORE-CLEAR-PREFLIGHT: resolution must RESTAMP the moment it
// resolves. The P5 live gate caught the alternative (2026-09-08): preflight
// cleared but left the old stamp, so the stamp owner's own prep saw
// mismatch + non-empty again — non-empty because the gateway had already
// written its jobs tree into the shared store — and cleared a second time,
// mid-boot, deleting what a sharer had just written.
func TestResolveStoreStampRestampsOnResolution(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_DATA_HOME", "")
	root := t.TempDir()
	x := &liveExec{u: newUI(true)}

	dir := stateRootDir(root)
	sd := stateStores["state"].storeDir(root)
	if err := os.MkdirAll(sd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sd, "stale"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := loadRootMeta(dir)
	meta.Stores["state"] = storeMeta{Image: "img:old"}
	saveRootMeta(dir, meta)

	if !x.resolveStoreStamp("state", "img:new", root) {
		t.Fatal("a projection mismatch must resolve, not refuse")
	}
	if _, err := os.Stat(filepath.Join(sd, "stale")); err == nil {
		t.Error("stale contents survived the clear")
	}
	if got := loadRootMeta(dir).Stores["state"].Image; got != "img:new" {
		t.Errorf("stamp after resolution = %q, want %q — an unstamped resolution re-fires at the owner's prep and clears what sharers wrote in between", got, "img:new")
	}

	// The refusal path must NOT restamp: the data on disk is still the old
	// image's, and the stamp is the record of that fact.
	pgsd := stateStores["database"].storeDir(root)
	if err := os.MkdirAll(pgsd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pgsd, "PG_VERSION"), []byte("15\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta = loadRootMeta(dir)
	meta.Stores["database"] = storeMeta{Image: "pg:old"}
	saveRootMeta(dir, meta)

	if x.resolveStoreStamp("database", "pg:new", root) {
		t.Fatal("a database mismatch must refuse")
	}
	if got := loadRootMeta(dir).Stores["database"].Image; got != "pg:old" {
		t.Errorf("stamp after a refusal = %q, want %q untouched", got, "pg:old")
	}
}
