package launcher

// EXPORT-VIA-LAUNCHER P4, in process.
//
// The pins are on what the archive CONTAINS and — more importantly — what it
// does not. Inclusions are easy to get right and easy to notice; a silently
// shipped `.git`, or a silently DROPPED event log, is the failure that shows
// up years later when someone needs the backup.

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// fakeKB builds a KB root: content at natural paths, a committed-looking event
// log, a .semiont/config, and a .git that must NOT ride along.
func fakeKB(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("docs/overview.md", "# Overview\n")
	write("notes/thesis.md", "# Thesis\n")
	write(".semiont/config", "[project]\nname = \"testkb\"\n\n[site]\ndomain = \"example.org\"\n")
	write(".semiont/events/res-1/events-000001.jsonl", `{"type":"yield:created"}`+"\n")
	write(".semiont/events/__system__/events-000001.jsonl", `{"type":"frame:entity-type-added"}`+"\n")
	// The file-edit history. Excluded by D6 — the event log is the KB's history.
	write(".git/HEAD", "ref: refs/heads/main\n")
	write(".git/objects/ab/cdef", "binary-ish\n")
	return root
}

func archiveEntries(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	var names []string
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		names = append(names, h.Name)
	}
	sort.Strings(names)
	return names
}

// The whole KB, and only the KB.
func TestExportCarriesTheDurableKBAndExcludesGit(t *testing.T) {
	root := fakeKB(t)
	out := filepath.Join(t.TempDir(), "kb.tar.gz")

	if code := Export([]string{"--root", root, "-o", out}); code != 0 {
		t.Fatalf("export: exit %d", code)
	}
	got := strings.Join(archiveEntries(t, out), "\n")

	for _, want := range []string{
		"docs/overview.md",
		"notes/thesis.md",
		".semiont/config",
		".semiont/events/res-1/events-000001.jsonl",
		".semiont/events/__system__/events-000001.jsonl",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("archive is missing %q; it holds:\n%s", want, got)
		}
	}
	// D6's default. Not "fewer .git entries" — none, including the directory.
	if strings.Contains(got, ".git/") || strings.Contains(got, "\n.git\n") {
		t.Errorf("archive carries .git by default — D6 excludes it:\n%s", got)
	}
}

// --with-git is the difference between an archive you can restore and one you
// can also attest: for a git-synced KB the commits carry the event log's
// integrity. Both defaults are pinned, because a flag that silently does
// nothing is worse than no flag.
func TestExportWithGitIncludesTheRepo(t *testing.T) {
	root := fakeKB(t)
	dir := t.TempDir()
	plain, full := filepath.Join(dir, "plain.tar.gz"), filepath.Join(dir, "full.tar.gz")

	if code := Export([]string{"--root", root, "-o", plain}); code != 0 {
		t.Fatalf("export: exit %d", code)
	}
	if code := Export([]string{"--root", root, "-o", full, "--with-git"}); code != 0 {
		t.Fatalf("export --with-git: exit %d", code)
	}
	withGit := strings.Join(archiveEntries(t, full), "\n")
	without := strings.Join(archiveEntries(t, plain), "\n")

	for _, want := range []string{".git/HEAD", ".git/objects/ab/cdef"} {
		if !strings.Contains(withGit, want) {
			t.Errorf("--with-git dropped %q; archive holds:\n%s", want, withGit)
		}
		if strings.Contains(without, want) {
			t.Errorf("the default archive carries %q", want)
		}
	}
	// The durable KB is in BOTH — the flag adds, it never substitutes.
	for _, always := range []string{".semiont/config", ".semiont/events/res-1/events-000001.jsonl", "docs/overview.md"} {
		if !strings.Contains(withGit, always) || !strings.Contains(without, always) {
			t.Errorf("%q must be in both archives", always)
		}
	}
}

// The archive must restore with tar alone, so the paths in it are the KB's own
// paths — not nested under a directory, not absolute.
func TestExportPathsAreKBRelative(t *testing.T) {
	root := fakeKB(t)
	out := filepath.Join(t.TempDir(), "kb.tar.gz")
	if code := Export([]string{"--root", root, "-o", out}); code != 0 {
		t.Fatalf("export: exit %d", code)
	}
	for _, name := range archiveEntries(t, out) {
		if strings.HasPrefix(name, "/") || strings.HasPrefix(name, "../") {
			t.Errorf("archive entry escapes the KB: %q", name)
		}
		if strings.HasPrefix(name, filepath.Base(root)+"/") {
			t.Errorf("archive nests under a top directory (%q) — untarring would not yield a KB", name)
		}
	}
}

// Advisory, and provably so: it names the KB, and nothing reads it back.
func TestExportWritesAnAdvisoryMarker(t *testing.T) {
	root := fakeKB(t)
	out := filepath.Join(t.TempDir(), "kb.tar.gz")
	if code := Export([]string{"--root", root, "-o", out}); code != 0 {
		t.Fatalf("export: exit %d", code)
	}
	if !strings.Contains(strings.Join(archiveEntries(t, out), "\n"), ".semiont/export.json") {
		t.Error("no marker in the archive")
	}
	// It lives inside .semiont/ so it cannot collide with a KB's own content.
	for _, n := range archiveEntries(t, out) {
		if n == "export.json" {
			t.Error("marker sits at the archive root, where it could collide with content")
		}
	}
}

// The same tree twice produces the same bytes — worth having for something
// people checksum and store.
func TestExportIsDeterministic(t *testing.T) {
	root := fakeKB(t)
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.tar.gz"), filepath.Join(dir, "b.tar.gz")
	for _, out := range []string{a, b} {
		if code := Export([]string{"--root", root, "-o", out}); code != 0 {
			t.Fatalf("export: exit %d", code)
		}
	}
	ea, eb := strings.Join(archiveEntries(t, a), "\n"), strings.Join(archiveEntries(t, b), "\n")
	if ea != eb {
		t.Errorf("entry order differs between runs:\n%s\n---\n%s", ea, eb)
	}
}

// Overwriting someone's backup is the one irreversible thing this verb can do.
func TestExportRefusesToOverwriteWithoutForce(t *testing.T) {
	root := fakeKB(t)
	out := filepath.Join(t.TempDir(), "kb.tar.gz")
	if err := os.WriteFile(out, []byte("PRECIOUS"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, errOut := captureOutput(t, func() {
		if code := Export([]string{"--root", root, "-o", out}); code == 0 {
			t.Error("must refuse to overwrite")
		}
	})
	mustContainAll(t, "refusal", errOut, "already exists", "--force")
	if b, _ := os.ReadFile(out); string(b) != "PRECIOUS" {
		t.Error("the existing archive was clobbered by a refused export")
	}
	if code := Export([]string{"--root", root, "-o", out, "--force"}); code != 0 {
		t.Errorf("--force should overwrite, exit %d", code)
	}
}

func TestExportRefusals(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want string
	}{
		{"root and repo together", []string{"--root", ".", "--repo", "o/n"}, "--repo names a remote KB"},
		{"unknown flag", []string{"--nope"}, "Unknown argument"},
		{"root is not a KB", []string{"--root", os.TempDir()}, ".semiont"},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, errOut := captureOutput(t, func() {
				if code := Export(c.args); code == 0 {
					t.Error("must refuse")
				}
			})
			mustContainAll(t, "refusal", errOut, c.want)
		})
	}
}
