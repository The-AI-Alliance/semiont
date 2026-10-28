//go:build windows

package launcher

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// lockedByte: the one byte the lock covers, far past anything a lock file
// holds. A Windows lock is mandatory for the bytes it covers: no other handle
// can read or write them. Locking a byte no content reaches leaves the file's
// own bytes — the start lock's note of who holds it — readable and writable,
// and still excludes every other taker: another launcher locking the same
// byte, and a program that locks the whole file, as the Rust SDK's File::lock
// does on tokens.lock.
func lockedByte() *windows.Overlapped {
	return &windows.Overlapped{OffsetHigh: 0x40000000}
}

// lockFile takes an exclusive lock on f (LockFileEx). With wait it blocks
// until the lock is held; without, it returns errLockHeld at once when another
// process holds it.
func lockFile(f *os.File, wait bool) error {
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK)
	if !wait {
		flags |= windows.LOCKFILE_FAIL_IMMEDIATELY
	}
	err := windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, lockedByte())
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return errLockHeld
	}
	return err
}

// unlockFile releases a lock lockFile took, for a caller that keeps the file
// open. Closing the file releases it too.
func unlockFile(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, lockedByte())
}
