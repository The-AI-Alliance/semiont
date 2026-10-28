package launcher

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// A store's stamp mismatch is resolved in preflight, and resolution must
// RESTAMP the moment it resolves. A preflight that cleared and left the stamp
// would leave meta.json naming an image whose output is gone, and the stamp
// owner's own prep would resolve the same mismatch again, mid-boot.
func TestResolveStoreStampRestampsOnResolution(t *testing.T) {
	harness.Home(t)
	key := rootKey("", t.TempDir())
	// A runtime that accepts the store clear. What the clear removes is the
	// root package's to assert (TestStateProjectionAutoCleans, through
	// fakert); this test is about the stamp.
	shim := t.TempDir()
	harness.StandIn(t, shim, "container", harness.Says{})
	t.Setenv("PATH", shim)
	x := &liveExec{u: NewUI(true), rt: "container"}

	dir := stateRootDir(key)
	sd := stateStores["state"].storeDir(key)
	if err := os.MkdirAll(sd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sd, "stale"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := loadRootMeta(dir)
	meta.Stores["state"] = storeMeta{Image: "img:old"}
	saveRootMeta(dir, meta)

	if !x.resolveStoreStamp("state", "img:new", key) {
		t.Fatal("a projection mismatch must resolve, not refuse")
	}
	if got := loadRootMeta(dir).Stores["state"].Image; got != "img:new" {
		t.Errorf("stamp after resolution = %q, want %q — a resolution that leaves the stamp re-fires at the owner's prep, mid-boot", got, "img:new")
	}

	// The refusal path must NOT restamp: the data on disk is still the old
	// image's, and the stamp is the record of that fact.
	pgsd := stateStores["database"].storeDir(key)
	if err := os.MkdirAll(pgsd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pgsd, "PG_VERSION"), []byte("15\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta = loadRootMeta(dir)
	meta.Stores["database"] = storeMeta{Image: "pg:old"}
	saveRootMeta(dir, meta)

	if x.resolveStoreStamp("database", "pg:new", key) {
		t.Fatal("a database mismatch must refuse")
	}
	if got := loadRootMeta(dir).Stores["database"].Image; got != "pg:old" {
		t.Errorf("stamp after a refusal = %q, want %q untouched", got, "pg:old")
	}
}
