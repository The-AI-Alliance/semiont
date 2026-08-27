package launcher

// EXPORT-VIA-LAUNCHER P5, in process.
//
// A3 is the round trip: an archive export writes restores through import, on a
// KB that did not create it. Everything else here guards the two ways this verb
// can do damage — merging two KBs into one directory, and trusting a hostile
// archive.

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// stateHome isolates roots.json so an import in a test cannot touch the real
// registry.
func stateHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, "state"))
}

// ── A3: the round trip ──────────────────────────────────────────────────

func TestExportImportRoundTrips(t *testing.T) {
	stateHome(t)
	src := fakeKB(t)
	dir := t.TempDir()
	archive := filepath.Join(dir, "kb.tar.gz")
	dest := filepath.Join(dir, "restored")

	if code := Export([]string{"--root", src, "-o", archive}); code != 0 {
		t.Fatalf("export: exit %d", code)
	}
	if code := Import([]string{archive, "--root", dest}); code != 0 {
		t.Fatalf("import: exit %d", code)
	}

	// The KB came back: identity, the event log, and content — byte-identical.
	for rel, want := range map[string]string{
		".semiont/config": "testkb",
		".semiont/events/res-1/events-000001.jsonl":      `{"type":"yield:created"}`,
		".semiont/events/__system__/events-000001.jsonl": `{"type":"frame:entity-type-added"}`,
		"docs/overview.md": "# Overview",
		"notes/thesis.md":  "# Thesis",
	} {
		b, err := os.ReadFile(filepath.Join(dest, rel))
		if err != nil {
			t.Errorf("%s did not survive the round trip: %v", rel, err)
			continue
		}
		if !strings.Contains(string(b), want) {
			t.Errorf("%s restored with wrong content: %q", rel, string(b))
		}
	}
	// Nothing derived rode along, and .git stayed out (D6's default).
	if _, err := os.Stat(filepath.Join(dest, ".git")); err == nil {
		t.Error(".git was restored from a default export")
	}
}

// The restored KB is registered, so `semiont start --root` and `status` can
// see it without the operator re-registering by hand.
func TestImportRegistersTheRestoredRoot(t *testing.T) {
	stateHome(t)
	src := fakeKB(t)
	dir := t.TempDir()
	archive := filepath.Join(dir, "kb.tar.gz")
	dest := filepath.Join(dir, "restored")

	Export([]string{"--root", src, "-o", archive})
	if code := Import([]string{archive, "--root", dest}); code != 0 {
		t.Fatalf("import: exit %d", code)
	}
	found := false
	for _, e := range loadRoots().Roots {
		if strings.HasSuffix(e.Path, "restored") {
			found = true
		}
	}
	if !found {
		t.Error("the restored root was not registered in roots.json")
	}
}

// ── the irreversible mistake ────────────────────────────────────────────

func TestImportRefusesANonEmptyRoot(t *testing.T) {
	stateHome(t)
	src := fakeKB(t)
	dir := t.TempDir()
	archive := filepath.Join(dir, "kb.tar.gz")
	Export([]string{"--root", src, "-o", archive})

	dest := filepath.Join(dir, "occupied")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dest, "someone-elses.md"), []byte("MINE"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, errOut := captureOutput(t, func() {
		if code := Import([]string{archive, "--root", dest}); code == 0 {
			t.Error("must refuse a non-empty root")
		}
	})
	mustContainAll(t, "refusal", errOut, "not empty", "merge two KBs")
	// The refusal must not have written anything first.
	if _, err := os.Stat(filepath.Join(dest, ".semiont")); err == nil {
		t.Error("a refused import still unpacked into the directory")
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "someone-elses.md")); string(b) != "MINE" {
		t.Error("a refused import touched the existing file")
	}
	// --force is the operator saying they meant it.
	if code := Import([]string{archive, "--root", dest, "--force"}); code != 0 {
		t.Errorf("--force should overlay, exit %d", code)
	}
}

// ── a hostile archive ───────────────────────────────────────────────────

// An archive comes from wherever the operator got it. A crafted entry name
// must not write outside the root.
func TestImportRefusesPathTraversal(t *testing.T) {
	stateHome(t)
	dir := t.TempDir()
	archive := filepath.Join(dir, "evil.tar.gz")
	writeTarGzFixture(t, archive, map[string]string{
		"../escaped.md":   "should never be written",
		".semiont/config": "[project]\nname = \"x\"\n",
	})
	dest := filepath.Join(dir, "root")

	_, errOut := captureOutput(t, func() {
		if code := Import([]string{archive, "--root", dest}); code == 0 {
			t.Error("must refuse an archive that escapes the root")
		}
	})
	mustContainAll(t, "refusal", errOut, "escapes the root")
	if _, err := os.Stat(filepath.Join(dir, "escaped.md")); err == nil {
		t.Fatal("the traversal entry was written OUTSIDE the root")
	}
}

// A tarball that is not a KB should say so, rather than registering a
// directory that will fail confusingly at the next start.
func TestImportRefusesANonKBArchive(t *testing.T) {
	stateHome(t)
	dir := t.TempDir()
	archive := filepath.Join(dir, "notakb.tar.gz")
	writeTarGzFixture(t, archive, map[string]string{"README.md": "just a tarball"})

	_, errOut := captureOutput(t, func() {
		if code := Import([]string{archive, "--root", filepath.Join(dir, "root")}); code == 0 {
			t.Error("must refuse an archive with no .semiont/")
		}
	})
	mustContainAll(t, "refusal", errOut, "not a Semiont KB")
}

func TestImportRefusals(t *testing.T) {
	stateHome(t)
	for _, c := range []struct {
		name, want string
		args       []string
	}{
		{"no archive", "needs an archive", []string{}},
		{"missing file", "no such archive", []string{"/nope/absent.tar.gz"}},
		{"unknown flag", "Unknown argument", []string{"--nope"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, errOut := captureOutput(t, func() {
				if code := Import(c.args); code == 0 {
					t.Error("must refuse")
				}
			})
			mustContainAll(t, "refusal", errOut, c.want)
		})
	}
}

// writeTarGzFixture builds an archive by hand, so a test can express one no
// exporter would ever produce — a traversal entry, or a tarball that is not a
// KB at all.
func writeTarGzFixture(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		body := files[n]
		if err := tw.WriteHeader(&tar.Header{
			Name: n, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
}
