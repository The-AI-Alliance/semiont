//go:build windows

package launcher

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// inheritsFromItsParent: whether a path's access list still takes entries
// from the directory above it.
func inheritsFromItsParent(t *testing.T, path string) bool {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	return control&windows.SE_DACL_PROTECTED == 0
}

// openToEveryone gives a path an access list that lets every user in, which is what a
// directory outside a user's profile can hand down.
func openToEveryone(t *testing.T, path string) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString("D:PAI(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	if harness.OpenToOthers(t, path) == "" {
		t.Fatalf("%s was opened to everyone and reads as closed: the check sees nothing", path)
	}
}

// A directory kept to its owner grants nothing to anyone else, inherits
// nothing, and hands the same list to what is created beneath it — though the
// directory above it lets every user in.
func TestOwnerOnlyDirGrantsNobodyElse(t *testing.T) {
	parent := t.TempDir()
	openToEveryone(t, parent)
	dir := filepath.Join(parent, "state")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if harness.OpenToOthers(t, dir) == "" {
		t.Fatal("a directory made under an open one reads as closed before anything closed it")
	}
	if err := ownerOnlyDir(dir); err != nil {
		t.Fatalf("ownerOnlyDir: %v", err)
	}
	if open := harness.OpenToOthers(t, dir); open != "" {
		t.Errorf("%s %s", dir, open)
	}
	if inheritsFromItsParent(t, dir) {
		t.Errorf("%s still inherits its parent's access list", dir)
	}
	// Something made beneath it afterwards is as closed, and still usable.
	beneath := filepath.Join(dir, "kept-secret")
	if err := os.WriteFile(beneath, []byte("value\n"), 0o600); err != nil {
		t.Fatalf("writing beneath an owner-only directory: %v", err)
	}
	if open := harness.OpenToOthers(t, beneath); open != "" {
		t.Errorf("%s %s", beneath, open)
	}
	if b, err := os.ReadFile(beneath); err != nil || string(b) != "value\n" {
		t.Errorf("the owner cannot read back what it wrote: %q, %v", b, err)
	}
}

// A file kept to its owner grants nothing to anyone else, though the
// directory it is in lets every user in, and its owner still reads and
// replaces it.
func TestOwnerOnlyFileGrantsNobodyElse(t *testing.T) {
	parent := t.TempDir()
	openToEveryone(t, parent)
	path := filepath.Join(parent, "tokens.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if harness.OpenToOthers(t, path) == "" {
		t.Fatal("a file made in an open directory reads as closed before anything closed it")
	}
	if err := ownerOnlyFile(path); err != nil {
		t.Fatalf("ownerOnlyFile: %v", err)
	}
	if open := harness.OpenToOthers(t, path); open != "" {
		t.Errorf("%s %s", path, open)
	}
	if inheritsFromItsParent(t, path) {
		t.Errorf("%s still inherits its parent's access list", path)
	}
	if err := os.WriteFile(path, []byte("{\"a\":1}\n"), 0o600); err != nil {
		t.Errorf("the owner cannot write the file it owns: %v", err)
	}
}

// What the launcher keeps to its owner, it keeps so where the directory above
// lets every user in — a home outside a user's profile can. Under a home that
// is already private, every one of these would read as closed whether or not
// the launcher closed it.
func TestWhatTheLauncherKeepsIsClosedUnderAnOpenHome(t *testing.T) {
	home := harness.Home(t)
	openToEveryone(t, home)
	temp := filepath.Join(home, "Temp")
	if err := os.MkdirAll(temp, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TEMP", temp)
	t.Setenv("TMP", temp)
	t.Setenv("JWT_SECRET", "")
	closed := func(what, path string) {
		t.Helper()
		if open := harness.OpenToOthers(t, path); open != "" {
			t.Errorf("%s: %s %s", what, path, open)
		}
	}

	if err := SaveToken("local", signInFor(1)); err != nil {
		t.Fatal(err)
	}
	closed("the sign-in store", tokensPath())

	root := filepath.Join(home, "kb")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	u := NewUI(true)
	loadOrCreateJWTSecret(u, root)
	store, ok := custodyFor(u, root)
	if !ok {
		t.Fatal("no custody store for this root")
	}
	closed("a kept secret", store.where(custodyJWTSecret))

	x := &liveExec{u: u}
	staged, ok := x.stageRealm("probe", []byte(`{"clients":[{"secret":"probe"}]}`))
	if !ok {
		t.Fatal("stageRealm failed")
	}
	closed("the staging dir", filepath.Dir(staged))

	if _, ok := x.stateMountsShared("state", root); !ok {
		t.Fatal("mount prep refused")
	}
	closed("a root's state dir", stateRootDir(root))
}
