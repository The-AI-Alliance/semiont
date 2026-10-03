//go:build unix

package harness

import (
	"fmt"
	"os"
	"testing"
)

// OpenToOthers: what a path lets someone other than its owner do, or "" when
// that is nothing.
func OpenToOthers(t *testing.T, path string) string {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Sprintf("is mode %04o", perm)
	}
	return ""
}
