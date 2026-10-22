package launcher

// inittemplate.go — `semiont init`'s explicit template-copy paths.
// The mechanism is a shallow `git clone` (git is already a launcher
// requirement; there is no listing API over raw fetches, and a clone is an
// atomic ref) — or a local directory used directly, which is also the
// hermetic test seam. Two hard rules: identity (the project file) is NEVER
// copied — init's own is already written — and every copied document passes
// the SAME vet as generated ones, with the WHOLE init refusing pre-write on
// the first failure (no partial trees).

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

const defaultTemplateRepo = "https://github.com/The-AI-Alliance/semiont-template-kb"

// materializeTemplate returns a local directory holding the template tree:
// the source itself when it is a directory, else a shallow clone in a temp
// dir (caller cleans up via the returned func).
func materializeTemplate(u *UI, src, ref string) (dir string, cleanup func(), ok bool) {
	if fi, err := os.Stat(src); err == nil && fi.IsDir() {
		return src, func() {}, true
	}
	tmp, err := os.MkdirTemp("", "semiont-template-*")
	if err != nil {
		u.Fail("Creating a temp dir for the template clone: %v", err)
		return "", nil, false
	}
	// `--` before positionals: a src beginning with "-" would otherwise be
	// read as a git option (option injection).
	args := []string{"clone", "--depth", "1", "--branch", ref, "--", src, tmp}
	u.Log("Fetching template %s", u.Dim("(git "+strings.Join(args, " ")+")"))
	if out, err := captureBoth("git", args...); err != nil {
		_ = os.RemoveAll(tmp)
		u.Fail("Template clone failed: %s", strings.TrimSpace(out))
		return "", nil, false
	}
	return tmp, func() { _ = os.RemoveAll(tmp) }, true
}

// copyTemplateStack vets and copies the template's .semiont/stack: the four
// documents a knowledge base shares and each Inference document beside them,
// vetted together before any is written (writeVettedStack).
func copyTemplateStack(u *UI, root, tplDir string) bool {
	src := filepath.Join(tplDir, stack.Dir)
	if _, err := os.Stat(src); err != nil {
		u.Fail("The template has no %s: %v", stack.Dir, err)
		return false
	}
	files := map[string][]byte{}
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// Refuse symlinks: a template (or local dir) could symlink a document
		// at an arbitrary local path, reading it into the newborn KB.
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("template document %s is a symlink — refusing (a symlinked document could read arbitrary local files)", d.Name())
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".yaml") {
			return nil
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return fmt.Errorf("reading template document %s: %v", rel, err)
		}
		files[rel] = b
		return nil
	})
	if err != nil {
		u.Fail("%v", err)
		return false
	}
	if len(files) == 0 {
		u.Fail("The template carried no documents in %s.", stack.Dir)
		return false
	}
	return writeVettedStack(u, root, files)
}

// copyDevcontainer copies the template's .devcontainer set verbatim EXCEPT
// the display name in devcontainer.json, which becomes the newborn's — each
// KB's codespace must self-identify (template-init.yml step 5). This is
// what makes a locally-born KB eligible for --runtime codespace.
func copyDevcontainer(u *UI, root, tplDir, kbName string) bool {
	src := filepath.Join(tplDir, ".devcontainer")
	if _, err := os.Stat(src); err != nil {
		u.Fail("The template has no .devcontainer: %v", err)
		return false
	}
	dst := filepath.Join(root, ".devcontainer")
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s is a symlink — refusing (a symlinked file could copy arbitrary local paths into the KB)", p)
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if d.Name() == "devcontainer.json" {
			b = rewriteDevcontainerName(b, kbName)
		}
		info, _ := d.Info()
		mode := fs.FileMode(0o644)
		if info != nil && info.Mode()&0o111 != 0 {
			mode = 0o755 // scripts keep their executability
		}
		return os.WriteFile(target, b, mode)
	})
	if err != nil {
		u.Fail("Copying .devcontainer: %v", err)
		return false
	}
	u.Ok(".devcontainer copied %s", u.Dim("(display name → "+kbName+"; this KB is codespace-capable)"))
	return true
}

// rewriteDevcontainerName replaces the "name" value. Targeted string
// surgery, not a JSON round-trip: devcontainer.json is JSONC in the wild,
// and a reserialize would destroy comments and ordering.
func rewriteDevcontainerName(b []byte, kbName string) []byte {
	s := string(b)
	const marker = `"name":`
	i := strings.Index(s, marker)
	if i < 0 {
		return b
	}
	rest := s[i+len(marker):]
	open := strings.IndexByte(rest, '"')
	if open < 0 {
		return b
	}
	close := strings.IndexByte(rest[open+1:], '"')
	if close < 0 {
		return b
	}
	// JSON-escape: a --name (or dir basename) with a quote or backslash would
	// otherwise produce invalid JSON/JSONC.
	// strconv.Quote yields a full quoted string, so drop the surrounding
	// quotes we already have in the splice.
	escaped := strconv.Quote(kbName)
	escaped = escaped[1 : len(escaped)-1]
	return []byte(s[:i] + marker + rest[:open+1] + escaped + rest[open+1+close:])
}
