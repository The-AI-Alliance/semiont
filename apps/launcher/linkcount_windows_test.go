//go:build windows

package main_test

import "os"

// linkCount: Windows does not report a link count through os.FileInfo, and a
// directory held open there cannot be unlinked at all.
func linkCount(os.FileInfo) (uint64, bool) { return 0, false }
