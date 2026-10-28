//go:build windows

package semiont

import (
	"os"
	"syscall"
	"unsafe"
)

var lockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")

const lockfileExclusiveLock = 0x00000002

// lockFile takes an exclusive lock on f (LockFileEx), waiting until it is
// held. Closing f lets it go. The lock covers one byte far past anything the
// lock file holds, the byte every writer of the sign-in store locks; a program
// that locks the whole file holds it too (specs/src/sign-in-store/README.md).
func lockFile(f *os.File) error {
	where := syscall.Overlapped{OffsetHigh: 0x40000000}
	locked, _, err := lockFileEx.Call(f.Fd(), lockfileExclusiveLock, 0, 1, 0, uintptr(unsafe.Pointer(&where)))
	if locked == 0 {
		return err
	}
	return nil
}
