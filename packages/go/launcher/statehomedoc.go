package launcher

// statehomedoc.go — the documents of what serves every knowledge base on a
// machine: the Browser's (browserdoc.go) and the worker's (workerpooldoc.go).
// Each belongs to no knowledge base, so it is kept in the launcher's state
// home, not in a knowledge base's repository. The first command that needs
// one and finds none writes it from the launcher's catalog and says where;
// from then on the file is what runs, read with the reader a knowledge base's
// documents are.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// stateHomeDocumentPath: where the state home keeps the document named file;
// "" when there is no state home.
func stateHomeDocumentPath(file string) string {
	dir := StateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, stack.StateHomeDir, file)
}

// loadStateHomeDocument: the document of kind kept as file, and where it is
// kept. Where there is none it is the catalog's, written first unless preview
// (a dry run), which writes nothing; fromCatalog says so. One that does not
// hold to its schema is refused with every place it does not. whose names the
// document in the refusal of a machine with no state home.
func loadStateHomeDocument[T any](file, kind, whose string, catalog T, preview bool) (read T, path string, fromCatalog bool, err error) {
	path = stateHomeDocumentPath(file)
	if path == "" {
		return read, path, false, fmt.Errorf("no home directory resolvable, so there is no state home to keep %s document in", whose)
	}
	read, err = stack.Read[T](path, kind)
	if err == nil || !errors.Is(err, fs.ErrNotExist) {
		return read, path, false, err
	}
	text, err := stack.Marshal(catalog)
	if err != nil {
		return read, path, true, err
	}
	// Vetted by the reader every later command reads it with, before it is
	// written: a document the launcher writes is one it can read.
	if read, err = stack.Parse[T](path, kind, text); err != nil || preview {
		return read, path, true, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return read, path, true, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, text, 0o644); err != nil {
		return read, path, true, err
	}
	return read, path, true, os.Rename(tmp, path)
}

// reportStateHomeDocument: what a command says of a document it loaded —
// where it wrote one from the catalog, headed by noun and saying what an
// edit changes; or the refusal, naming the file and each line, of one that
// does not hold. Whether the command goes on.
func reportStateHomeDocument(u *UI, noun, changes, path string, fromCatalog, preview bool, err error) bool {
	if err != nil {
		u.Fail("%v", err)
		var refused *stack.Refused
		if errors.As(err, &refused) {
			fmt.Fprintf(os.Stderr, "  Fix it, or delete it and the next command that needs it writes the launcher's: %s\n", refused.File)
		}
		return false
	}
	if fromCatalog && !preview {
		u.Log("%s: wrote its document, %s %s", noun, u.Bold(path), u.Dim("(the launcher's catalog; edit it to change "+changes+")"))
	}
	return true
}
