//go:build unix

package main_test

import (
	"os"
	"syscall"
)

// linkCount: how many names a file has. Zero for an open file means it was
// unlinked while held.
func linkCount(fi os.FileInfo) (uint64, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Nlink), true
}
