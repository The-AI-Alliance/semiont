package launcher

// browserdoc.go — the Browser's document: the image the Browser runs, its
// memory, and the port it is published on. The Browser belongs to no
// knowledge base, so its document is one of the state home's
// (statehomedoc.go).

import (
	"fmt"

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
	return stateHomeDocumentPath(stack.BrowserFile)
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
// when there is none, unless preview (a dry run), which writes nothing.
func loadBrowserDocument(preview bool) (browserDocument, error) {
	read, path, fromCatalog, err := loadStateHomeDocument(stack.BrowserFile, "Browser", "the Browser's", catalogBrowser(), preview)
	return browserDocument{path: path, spec: read.Spec, fromCatalog: fromCatalog}, err
}

// readBrowserDocument: loadBrowserDocument for a command, which says where it
// wrote one and refuses one that does not hold.
func readBrowserDocument(u *UI, preview bool) (browserDocument, bool) {
	doc, err := loadBrowserDocument(preview)
	return doc, reportStateHomeDocument(u, "Browser", "the image, memory or port", doc.path, doc.fromCatalog, preview, err)
}

// endpoint: where a person opens the Browser the document describes.
func (d browserDocument) endpoint() string {
	return fmt.Sprintf("http://localhost:%d", d.spec.Port)
}
