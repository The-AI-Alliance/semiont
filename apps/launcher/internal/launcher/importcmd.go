package launcher

// importcmd.go — `semiont import`: the other half of export.
//
// It untars. That is the entire mechanism, and it is why the design question
// that once made this the hard phase evaporated.
//
// The 2026-07-09 ruling — "events are facts, commands are requests" — exists so
// a restore never re-issues `mark:update-entity-types` and never re-subjects
// restored history to the vocabulary gate. An earlier draft of this plan
// carried a three-way fork over how Go could honour that: write the event log
// directly (a large mirror of the event model), dial a local fact-append seam
// (an API surface by another name), or keep import on the API.
//
// Untarring replays nothing. It puts bytes back. The constraint is satisfied by
// construction, so the cheap design and the correct design turned out to be the
// same one — no event-model mirror, no vocabulary gate, no cross-language
// contract.
//
// Projections rebuild on first start, which is what they are for.

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const importUsage = `Usage: semiont import <archive.tar.gz> [options]

Restore a KB exported by 'semiont export' into a new root: the content files
and the event log. Nothing needs to be running.

Projections (graph, vectors, views) are NOT in the archive and are not restored
— they rebuild from the event log the first time you start the KB.

Options:
  --root <path>   Where to restore (default: ./<archive-name>)
  --force         Restore into a non-empty directory (see below)
  --help          Show this help

Refuses a non-empty root by default. Untarring one KB over another interleaves
two event logs into one directory, and nothing downstream can tell them apart
afterwards — it is the one irreversible mistake available here.
`

func Import(args []string) int {
	u := newUI(false)
	var archive, root string
	force := false

	for i := 0; i < len(args); i++ {
		a := args[i]
		val := func() (string, bool) {
			if i+1 >= len(args) {
				u.fail("Missing value for %s", a)
				return "", false
			}
			i++
			return args[i], true
		}
		var ok bool
		switch a {
		case "--root":
			if root, ok = val(); !ok {
				return 1
			}
		case "--force":
			force = true
		case "--help", "-h":
			fmt.Print(importUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				u.fail("Unknown argument: %s", a)
				return 1
			}
			if archive != "" {
				u.fail("Only one archive may be given (got %q and %q).", archive, a)
				return 1
			}
			archive = a
		}
	}
	if archive == "" {
		u.fail("import needs an archive: semiont import <archive.tar.gz>")
		return 1
	}
	if _, err := os.Stat(archive); err != nil {
		u.fail("no such archive: %s", archive)
		return 1
	}
	if root == "" {
		root = defaultImportRoot(archive)
	}

	// The one irreversible mistake: two event logs interleaved in a directory
	// nothing can separate afterwards. Empty-or-absent is the safe shape, and
	// --force is the operator saying they meant it.
	if !force {
		if entries, err := os.ReadDir(root); err == nil && len(entries) > 0 {
			u.fail("%s is not empty — restoring into it would merge two KBs.", root)
			fmt.Fprintln(os.Stderr, "  Pick an empty directory, or pass --force if you mean to overlay.")
			return 1
		}
	}

	n, err := extractArchive(archive, root)
	if err != nil {
		u.fail("import failed: %v", err)
		return 1
	}
	// A directory with no .semiont/ is not a KB. Say so rather than leaving
	// the operator to discover it at the next start.
	if fi, statErr := os.Stat(filepath.Join(root, ".semiont")); statErr != nil || !fi.IsDir() {
		u.fail("%s has no .semiont/ — that archive is not a Semiont KB.", root)
		return 1
	}

	abs := root
	if a, err := filepath.Abs(root); err == nil {
		abs = a
	}
	registerRootUse(abs, false, "")

	id := readKBIdentity(abs)
	label := filepath.Base(abs)
	if id != nil && id.Name != "" {
		label = id.Name
	}
	u.ok("Imported %s into %s %s", label, abs, u.dim(fmt.Sprintf("(%d entries)", n)))
	fmt.Printf("  %s\n", u.dim("Start it:  semiont start --root "+abs))
	fmt.Printf("  %s\n", u.dim("Projections rebuild from the event log on that first start."))
	return 0
}

// defaultImportRoot: "kb.tar.gz" → "./kb". Both suffixes, because .tgz is the
// same artifact under a shorter name.
func defaultImportRoot(archive string) string {
	base := filepath.Base(archive)
	for _, ext := range []string{".tar.gz", ".tgz"} {
		if strings.HasSuffix(base, ext) {
			return strings.TrimSuffix(base, ext)
		}
	}
	return base + ".kb"
}

// extractArchive untars into root. Returns the entry count.
func extractArchive(archive, root string) (int, error) {
	f, err := os.Open(archive)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return 0, fmt.Errorf("not a gzip archive: %w", err)
	}
	defer gz.Close()

	if err := os.MkdirAll(root, 0o755); err != nil {
		return 0, err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return 0, err
	}

	count := 0
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, err
		}
		// Path traversal, checked on the RAW name. An archive is untrusted —
		// it came from wherever the operator got it — and `semiont export`
		// can never produce a `..` or an absolute entry, so one means the
		// archive is corrupt or crafted. REFUSE rather than sanitize: quietly
		// rewriting the path would put the file somewhere the archive did not
		// say, and nobody would know.
		//
		// The check must precede Clean(). `filepath.Clean("/"+name)` turns
		// "../escaped.md" into "/escaped.md", which lands inside the root and
		// passes any containment test — so a check written after it can never
		// fire. (It was written that way first; the test caught it.)
		name := filepath.ToSlash(h.Name)
		clean := path.Clean(name)
		if path.IsAbs(name) || clean == ".." || strings.HasPrefix(clean, "../") {
			return 0, fmt.Errorf("archive entry escapes the root: %q", h.Name)
		}
		target := filepath.Join(rootAbs, filepath.FromSlash(clean))
		// Belt to the braces: containment still holds after joining.
		if target != rootAbs && !strings.HasPrefix(target, rootAbs+string(os.PathSeparator)) {
			return 0, fmt.Errorf("archive entry escapes the root: %q", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, os.FileMode(h.Mode)&os.ModePerm); err != nil {
				return 0, err
			}
		case tar.TypeSymlink:
			// A symlink can point anywhere at follow time, so it gets the same
			// containment check as a written path.
			dest := h.Linkname
			if !filepath.IsAbs(dest) {
				dest = filepath.Join(filepath.Dir(target), dest)
			}
			if !strings.HasPrefix(filepath.Clean(dest), rootAbs+string(os.PathSeparator)) {
				return 0, fmt.Errorf("archive symlink %q points outside the root", h.Name)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return 0, err
			}
			os.Remove(target)
			if err := os.Symlink(h.Linkname, target); err != nil {
				return 0, err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return 0, err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(h.Mode)&os.ModePerm)
			if err != nil {
				return 0, err
			}
			if _, cerr := io.Copy(out, tr); cerr != nil {
				_ = out.Close() // already failing; the copy error is the useful one
				return 0, cerr
			}
			// Checked, not dropped: Close FLUSHES, so a failure here means the
			// restored file is TRUNCATED. Reporting success would hand back a
			// KB with a short event log and no indication — the exact failure
			// a restore exists to prevent. (Copilot.)
			if cerr := out.Close(); cerr != nil {
				return 0, fmt.Errorf("writing %s: %w", h.Name, cerr)
			}
		default:
			continue // devices, fifos and sockets are not KB content
		}
		count++
	}
	return count, nil
}
