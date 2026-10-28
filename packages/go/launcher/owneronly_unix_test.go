//go:build unix

package launcher

import (
	"os"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// A directory kept to its owner is closed to its group and to everyone else,
// whatever it was made with.
func TestOwnerOnlyDirClosesAnOpenDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if harness.OpenToOthers(t, dir) == "" {
		t.Fatal("a 0777 directory reads as closed: the check sees nothing")
	}
	if err := ownerOnlyDir(dir); err != nil {
		t.Fatal(err)
	}
	if open := harness.OpenToOthers(t, dir); open != "" {
		t.Errorf("%s %s after ownerOnlyDir", dir, open)
	}
}
