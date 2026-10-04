//go:build windows

package launcher

import (
	"io/fs"
	"unsafe"

	"golang.org/x/sys/windows"
)

// fileStandardInfo is kernel32's FILE_STANDARD_INFO.
type fileStandardInfo struct {
	AllocationSize int64
	EndOfFile      int64
	NumberOfLinks  uint32
	DeletePending  bool
	Directory      bool
}

// allocatedBytes: the space a file takes on disk, which Windows reports as
// its allocation size. The file's length stands in where that cannot be
// asked: a file held open for exclusive use by another program.
func allocatedBytes(path string, info fs.FileInfo) int64 {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return info.Size()
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return info.Size()
	}
	defer windows.CloseHandle(h)
	var standard fileStandardInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileStandardInfo,
		(*byte)(unsafe.Pointer(&standard)), uint32(unsafe.Sizeof(standard))); err != nil {
		return info.Size()
	}
	return standard.AllocationSize
}
