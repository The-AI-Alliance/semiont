package launcher

// The Browser's document: where it is kept, that the first command that needs
// it writes it from the launcher's catalog, and that one that does not hold to
// its schema is refused with its file and line.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// It is kept in the state home, in stack/, beside the record of what runs.
func TestTheBrowserDocumentIsKeptInTheStateHome(t *testing.T) {
	harness.Home(t)
	path := browserDocumentPath()
	want := filepath.Join(filepath.Dir(statePath()), "stack", "browser.yaml")
	if path != want {
		t.Errorf("the Browser's document is at %s, want %s", path, want)
	}
}

// With no home there is no state home, and nowhere to keep it: refused, never
// a document kept somewhere else.
func TestWithNoStateHomeTheBrowserDocumentIsRefused(t *testing.T) {
	harness.Home(t)
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	if _, err := loadBrowserDocument(false); err == nil {
		t.Fatal("a Browser document was found or kept with no state home")
	}
}

// The first command that needs it and finds none writes the catalog's, which
// holds to the schema. From then on the file is what runs.
func TestTheFirstNeedWritesTheBrowserDocumentFromTheCatalog(t *testing.T) {
	harness.Home(t)
	doc, err := loadBrowserDocument(false)
	if err != nil {
		t.Fatal(err)
	}
	catalog := catalogBrowser().Spec
	if !doc.fromCatalog || doc.spec != catalog {
		t.Errorf("with no document: %+v, want the catalog's %+v, written", doc, catalog)
	}
	text, err := os.ReadFile(browserDocumentPath())
	if err != nil {
		t.Fatalf("the document was not written: %v", err)
	}
	if refusals, err := stack.Check("Browser", text); err != nil || len(refusals) > 0 {
		t.Fatalf("the document written does not hold to its schema: %v %+v\n%s", err, refusals, text)
	}

	moved := strings.Replace(string(text), fmt.Sprintf("port: %d", catalog.Port), fmt.Sprintf("port: %d", catalog.Port+1), 1)
	if moved == string(text) {
		t.Fatalf("the document written names no port: %s", text)
	}
	if err := os.WriteFile(browserDocumentPath(), []byte(moved), 0o644); err != nil {
		t.Fatal(err)
	}
	again, err := loadBrowserDocument(false)
	if err != nil {
		t.Fatal(err)
	}
	if again.fromCatalog || again.spec.Port != catalog.Port+1 {
		t.Errorf("an edited document read as %+v, want port %d from the file", again, catalog.Port+1)
	}
}

// A dry run writes nothing: it plans with the document a start would write.
func TestADryRunWritesNoBrowserDocument(t *testing.T) {
	harness.Home(t)
	doc, err := loadBrowserDocument(true)
	if err != nil {
		t.Fatal(err)
	}
	if !doc.fromCatalog || doc.spec != catalogBrowser().Spec || doc.path != browserDocumentPath() {
		t.Errorf("a dry run with no document planned %+v, want the catalog's, at %s", doc, browserDocumentPath())
	}
	if _, err := os.Stat(doc.path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a dry run wrote %s (%v)", doc.path, err)
	}
}

// A document that does not hold is refused, live or in a dry run, with its
// file and the line of the place it does not, and is left as it is.
func TestABrowserDocumentThatDoesNotHoldIsRefusedByLine(t *testing.T) {
	harness.Home(t)
	path := browserDocumentPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	text := `apiVersion: semiont.the-ai-alliance.github.io/v1alpha1
kind: Browser
metadata:
  name: browser
spec:
  image: ghcr.io/the-ai-alliance/semiont-browser:latest
  resources:
    limits:
      memory: 1G
  port: 70000
`
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, preview := range []bool{false, true} {
		_, err := loadBrowserDocument(preview)
		var refused *stack.Refused
		if !errors.As(err, &refused) || refused.File != path || len(refused.Refusals) != 1 || refused.Refusals[0].Line != 10 {
			t.Errorf("preview %v: a port out of range was answered %v, want a refusal of %s on line 10", preview, err, path)
		}
	}
	if after, _ := os.ReadFile(path); string(after) != text {
		t.Errorf("a refused document was replaced:\n%s", after)
	}
}
