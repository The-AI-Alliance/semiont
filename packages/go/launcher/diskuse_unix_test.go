//go:build unix

package launcher

import (
	"os"
	"path/filepath"
	"testing"
)

// A sparse file is long and takes little, and a vector store keeps them: its
// directory measured eight times what it took when lengths were summed.
func TestDiskUseIsNotTheLengthOfASparseFile(t *testing.T) {
	dir := t.TempDir()
	megabytes(t, filepath.Join(dir, "dense"), 1)
	sparse, err := os.Create(filepath.Join(dir, "sparse"))
	if err != nil {
		t.Fatal(err)
	}
	if err := sparse.Truncate(64 << 20); err != nil {
		t.Fatal(err)
	}
	sparse.Close()
	if fi, err := os.Stat(filepath.Join(dir, "sparse")); err != nil || fi.Size() != 64<<20 {
		t.Fatalf("the sparse file is not 64 MB long: %v, %v", fi, err)
	}
	n, ok := diskUse(dir)
	if !ok || n < 1<<20 || n > 2<<20 {
		t.Errorf("a megabyte of data beside a 64 MB sparse file measures %d bytes", n)
	}
}
