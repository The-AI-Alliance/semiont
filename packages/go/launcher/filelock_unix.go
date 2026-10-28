//go:build unix

package launcher

import (
	"errors"
	"os"
	"syscall"
)

// lockFile takes an exclusive lock on f (flock). With wait it blocks until the
// lock is held; without, it returns errLockHeld at once when another process
// holds it.
func lockFile(f *os.File, wait bool) error {
	how := syscall.LOCK_EX
	if !wait {
		how |= syscall.LOCK_NB
	}
	for {
		err := syscall.Flock(int(f.Fd()), how)
		switch {
		case err == syscall.EINTR:
			continue
		case errors.Is(err, syscall.EWOULDBLOCK):
			return errLockHeld
		}
		return err
	}
}

// unlockFile releases a lock lockFile took, for a caller that keeps the file
// open. Closing the file releases it too.
func unlockFile(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
