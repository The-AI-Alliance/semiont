package launcher

// The state home's documents, where writing one fails: the failure is the
// command's, and no document is left half written.

import (
	"errors"
	"io/fs"
	"os"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// A document whose temporary file cannot be written is refused, and none is
// kept.
func TestAStateHomeDocumentThatCannotBeWrittenIsRefused(t *testing.T) {
	harness.Home(t)
	path := workerPoolDocumentPath()
	if err := os.MkdirAll(path+".tmp", 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := loadWorkerPoolDocument(false); err == nil {
		t.Fatal("a document that could not be written was answered as written")
	}
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a document that could not be written is kept at %s (%v)", path, err)
	}
}
