package launcher

// browserdoc.go — the Browser's document: the image the Browser runs, its
// memory, and the port it is published on. The Browser belongs to no
// knowledge base, so its document is kept in the launcher's state home, not
// in a knowledge base's repository. The first command that needs it and finds
// none writes it from the launcher's catalog and says where; from then on the
// file is what runs, read with the reader a knowledge base's documents are.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// browserDocument: the Browser's document as a command read it.
type browserDocument struct {
	path string
	spec stack.BrowserSpec
	// fromCatalog: there was no document. This command wrote the catalog's,
	// or, in a dry run, plans with what a start would write.
	fromCatalog bool
}

// browserDocumentPath: where the Browser's document is kept; "" when there is
// no state home.
func browserDocumentPath() string {
	dir := StateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, stack.StateHomeDir, stack.BrowserFile)
}

// catalogBrowser: the Browser's document as the launcher writes it, from its
// catalog, as `semiont init` writes a knowledge base's.
func catalogBrowser() stack.Browser {
	d := semiontDescriptor("browser")
	return stack.Browser{
		ApiVersion: stack.APIVersion,
		Kind:       "Browser",
		Metadata:   stack.Metadata{Name: "browser"},
		Spec: stack.BrowserSpec{
			Image:     semiontImage("browser", "latest"),
			Resources: limits(d.mem),
			Port:      d.defaultPort,
		},
	}
}

// loadBrowserDocument: the Browser's document, written from the catalog first
// when there is none, unless preview (a dry run), which writes nothing. One
// that does not hold to its schema is refused with every place it does not.
func loadBrowserDocument(preview bool) (browserDocument, error) {
	path := browserDocumentPath()
	if path == "" {
		return browserDocument{}, errors.New("no home directory resolvable, so there is no state home to keep the Browser's document in")
	}
	doc := browserDocument{path: path}
	read, err := stack.Read[stack.Browser](path, "Browser")
	switch {
	case err == nil:
		doc.spec = read.Spec
		return doc, nil
	case !errors.Is(err, fs.ErrNotExist):
		return doc, err
	}
	doc.fromCatalog = true
	text, err := stack.Marshal(catalogBrowser())
	if err != nil {
		return doc, err
	}
	// Vetted by the reader every later command reads it with, before it is
	// written: a document the launcher writes is one it can read.
	written, err := stack.Parse[stack.Browser](path, "Browser", text)
	if err != nil {
		return doc, err
	}
	doc.spec = written.Spec
	if preview {
		return doc, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return doc, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, text, 0o644); err != nil {
		return doc, err
	}
	return doc, os.Rename(tmp, path)
}

// readBrowserDocument: loadBrowserDocument for a command, which says where it
// wrote one and refuses, naming the file and each line, one that does not
// hold.
func readBrowserDocument(u *UI, preview bool) (browserDocument, bool) {
	doc, err := loadBrowserDocument(preview)
	if err != nil {
		u.Fail("%v", err)
		var refused *stack.Refused
		if errors.As(err, &refused) {
			fmt.Fprintf(os.Stderr, "  Fix it, or delete it and the next command that needs it writes the launcher's: %s\n", refused.File)
		}
		return doc, false
	}
	if doc.fromCatalog && !preview {
		u.Log("Browser: wrote its document, %s %s", u.Bold(doc.path), u.Dim("(the launcher's catalog; edit it to change the image, memory or port)"))
	}
	return doc, true
}

// endpoint: where a person opens the Browser the document describes.
func (d browserDocument) endpoint() string {
	return fmt.Sprintf("http://localhost:%d", d.spec.Port)
}
