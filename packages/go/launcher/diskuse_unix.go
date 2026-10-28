//go:build unix

package launcher

import (
	"io/fs"
	"syscall"
)

// allocatedBytes: the space a file takes on disk, from the blocks the
// filesystem counts for it. A block here is 512 bytes whatever the
// filesystem's own block size.
func allocatedBytes(_ string, info fs.FileInfo) int64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return int64(st.Blocks) * 512
	}
	return info.Size()
}
