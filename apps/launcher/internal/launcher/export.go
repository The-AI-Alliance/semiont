package launcher

// export.go — `semiont export`: the KB's durable half, as a plain tar.gz.
//
// This verb is unlike every other one here: it does NOT dial the SDK. It reads
// the working tree, because that is where a KB actually lives.
//
// THERE IS NO ARCHIVE FORMAT, and that is the design (EXPORT-VIA-LAUNCHER D4).
// The content is already files at their natural paths; the event log is already
// JSONL. So the archive is the KB directory, unmodified — `tar -xzf` yields a
// working KB and `cat` reads the history. No manifest, no format version, no
// schema, because nothing is transformed. The exchange format this replaces
// carried BACKUP_FORMAT, FORMAT_VERSION and validators: a representation
// invented for data that already had a perfectly good one on disk.
//
// tar.gz specifically, and NOT a git bundle, even though the event log is
// git-committed today. Git is how a KB happens to be stored; a format that
// required it would mean "your data is yours, if you have git" (D4). The
// payoff is not only principle: tar is on every machine, which is why the
// codespace path below is one streamed command rather than a remote toolchain.

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const exportUsage = `Usage: semiont export [options]

Write a KB's durable state to a .tar.gz — the content files and the event log.
Nothing derived: projections, jobs, anchored text and the databases all rebuild
from the log, and they live outside the KB root anyway.

The archive is the KB directory itself, so it needs no Semiont to read:

  tar -xzf kb.tar.gz          # a working KB directory
  cat .semiont/events/*.jsonl # the history, one JSON object per line

Options:
  --root <path|name>    KB to export (default: the root containing the cwd)
  --repo <owner/name>   Export a codespace-hosted KB over ssh instead
  -o, --output <file>   Archive path (default: <kb-name>.tar.gz)
  --with-git            Include .git — the commit history and, for a
                        git-synced KB, the event log's integrity chain
  --force               Overwrite an existing archive
  --help                Show this help

Needs no running stack: both directions are file operations.
`

// exportMarker is written to .semiont/export.json inside the archive so a file
// found on a drive years later can say what it is.
//
// ADVISORY ONLY. Nothing reads it back for correctness — the moment a restore
// depends on it, it is a format contract by the back door, which is what D4
// exists to avoid. It rides inside .semiont/ rather than at the archive root so
// it cannot collide with a KB's own content.
type exportMarker struct {
	KB         string `json:"kb,omitempty"`
	Did        string `json:"did,omitempty"`
	Launcher   string `json:"launcher"`
	ExportedAt string `json:"exportedAt"`
	Note       string `json:"note"`
}

func Export(args []string) int {
	u := newUI(false)
	var rootFlag, repo, output string
	force, withGit := false, false

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
			if rootFlag, ok = val(); !ok {
				return 1
			}
		case "--repo":
			if repo, ok = val(); !ok {
				return 1
			}
		case "-o", "--output":
			if output, ok = val(); !ok {
				return 1
			}
		case "--with-git":
			withGit = true
		case "--force":
			force = true
		case "--help", "-h":
			fmt.Print(exportUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", a)
			return 1
		}
	}
	if repo != "" && rootFlag != "" {
		u.fail("--repo names a remote KB; --root names a local one.")
		return 1
	}

	if repo != "" {
		return exportRemote(u, repo, output, force, withGit)
	}
	return exportLocal(u, rootFlag, output, force, withGit)
}

func exportLocal(u *ui, rootFlag, output string, force, withGit bool) int {
	var root string
	if rootFlag != "" {
		r, err := resolveRootArg(rootFlag)
		if err != nil {
			u.fail("%v", err)
			return 1
		}
		root = r
	} else {
		r, src, err := resolveKBRoot()
		if err != nil {
			u.fail("%v", err)
			fmt.Fprintln(os.Stderr, "  Name one:  semiont export --root <path|name>")
			return 1
		}
		root = r
		u.log("KB root %s %s", root, u.dim("("+src+")"))
	}

	id := readKBIdentity(root)
	if output == "" {
		output = archiveName(root, id)
	}
	if !force {
		if _, err := os.Stat(output); err == nil {
			u.fail("%s already exists — pass --force to overwrite.", output)
			return 1
		}
	}

	n, bytes, err := writeArchive(root, output, id, withGit)
	if err != nil {
		u.fail("export failed: %v", err)
		// A half-written archive is worse than none: it looks restorable.
		os.Remove(output)
		return 1
	}
	u.ok("Exported %s %s", output, u.dim(fmt.Sprintf("(%d entries, %s)", n, humanBytes(bytes))))
	fmt.Printf("  %s\n", u.dim("tar -xzf "+filepath.Base(output)+"  → a working KB directory"))
	return 0
}

// exportRemote streams a codespace-hosted KB back over ssh. `gh codespace ssh`
// is already how this launcher reads a remote KB's identity, and tar is present
// on the remote by default — the two facts that make this a single command
// rather than a remote toolchain (D4).
func exportRemote(u *ui, repo, output string, force, withGit bool) int {
	if !requireGh(u, "semiont export --repo") {
		return 1
	}
	ss := loadStackSet()
	st := ss.Stacks["codespace:"+repo]
	if st == nil || st.Codespace == "" {
		u.fail("No codespace stack recorded for %s.", repo)
		fmt.Fprintln(os.Stderr, "  Start it first:  semiont start --runtime codespace --repo "+repo)
		return 1
	}
	if output == "" {
		output = strings.ReplaceAll(repo, "/", "-") + ".tar.gz"
	}
	if !force {
		if _, err := os.Stat(output); err == nil {
			u.fail("%s already exists — pass --force to overwrite.", output)
			return 1
		}
	}

	// --exclude before -C, and the remote root is globbed the same way
	// fetchRemoteDid globs it: `gh codespace ssh` lands in /home/vscode.
	remote := "tar czf - --exclude=./.git -C /workspaces/*/ ."
	if withGit {
		remote = "tar czf - -C /workspaces/*/ ."
	}
	u.log("Streaming %s %s", repo, u.dim("(gh codespace ssh -c "+st.Codespace+" -- "+remote+")"))

	f, err := os.Create(output)
	if err != nil {
		u.fail("could not create %s: %v", output, err)
		return 1
	}
	cmd := exec.Command("gh", "codespace", "ssh", "-c", st.Codespace, "--", remote)
	cmd.Stdout = f
	cmd.Stderr = os.Stderr
	runErr := cmd.Run()
	f.Close()
	if runErr != nil {
		os.Remove(output)
		u.fail("export over ssh failed: %v", runErr)
		return 1
	}
	fi, _ := os.Stat(output)
	var size int64
	if fi != nil {
		size = fi.Size()
	}
	u.ok("Exported %s %s", output, u.dim("("+humanBytes(size)+")"))
	return 0
}

// writeArchive tars root into out, skipping .git. Returns the entry count and
// the uncompressed byte total.
//
// Entries are SORTED, so the same tree produces the same archive — a property
// worth having for something people diff, checksum and store.
func writeArchive(root, out string, id *kbIdentity, withGit bool) (int, int64, error) {
	f, err := os.Create(out)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()

	var paths []string
	err = filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			return relErr
		}
		if rel == "." {
			return nil
		}
		// The only optional exclusion, and the whole correctness surface of
		// this verb. Everything DERIVED already lives outside the root, so
		// .git is the one judgement call in here.
		//
		// Default off, because a KB has two histories and the event log is
		// Semiont's: a restore is complete without git. Available on, because
		// they are not interchangeable — for a git-synced KB the commits are
		// the log's integrity chain ("integrity is provided by git at the
		// commit level", event-storage.ts) and .git/config remembers where the
		// KB came from. So --with-git is the difference between an archive you
		// can RESTORE and one you can also ATTEST.
		//
		// It is NOT a portability question: a tar carrying .git is still a
		// tar, readable without git. D4 is about the archive's format and
		// holds either way.
		if !withGit && (rel == ".git" || strings.HasPrefix(rel, ".git"+string(filepath.Separator))) {
			if fi.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		paths = append(paths, rel)
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	sort.Strings(paths)

	var total int64
	count := 0
	for _, rel := range paths {
		abs := filepath.Join(root, rel)
		fi, lerr := os.Lstat(abs)
		if lerr != nil {
			return 0, 0, lerr
		}
		link := ""
		if fi.Mode()&os.ModeSymlink != 0 {
			if link, err = os.Readlink(abs); err != nil {
				return 0, 0, err
			}
		} else if !fi.Mode().IsRegular() && !fi.IsDir() {
			// Sockets, fifos and devices cannot be KB content and cannot be
			// restored meaningfully. Skipping silently would be the wrong
			// half of that; the caller sees the count not match.
			continue
		}
		h, herr := tar.FileInfoHeader(fi, link)
		if herr != nil {
			return 0, 0, herr
		}
		h.Name = filepath.ToSlash(rel)
		if err := tw.WriteHeader(h); err != nil {
			return 0, 0, err
		}
		if fi.Mode().IsRegular() {
			src, oerr := os.Open(abs)
			if oerr != nil {
				return 0, 0, oerr
			}
			n, cerr := io.Copy(tw, src)
			src.Close()
			if cerr != nil {
				return 0, 0, cerr
			}
			total += n
		}
		count++
	}

	m := exportMarker{
		Launcher:   BuildVersion,
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		Note:       "Advisory only. This archive is the KB directory; restoring it does not read this file.",
	}
	if id != nil {
		m.KB, m.Did = id.Name, id.didWeb()
	}
	blob, _ := json.MarshalIndent(m, "", "  ")
	if err := tw.WriteHeader(&tar.Header{
		Name: ".semiont/export.json", Mode: 0o644,
		Size: int64(len(blob)), ModTime: time.Now(), Typeflag: tar.TypeReg,
	}); err != nil {
		return 0, 0, err
	}
	if _, err := tw.Write(blob); err != nil {
		return 0, 0, err
	}
	return count, total, nil
}

// readKBIdentity reads .semiont/config for the marker. Best-effort: a KB with
// an unreadable config still exports, it just carries less provenance.
func readKBIdentity(root string) *kbIdentity {
	b, err := os.ReadFile(filepath.Join(root, ".semiont", "config"))
	if err != nil {
		return nil
	}
	return parseKBIdentity(b)
}

func archiveName(root string, id *kbIdentity) string {
	name := filepath.Base(root)
	if id != nil && id.Name != "" {
		name = id.Name
	}
	return name + ".tar.gz"
}
