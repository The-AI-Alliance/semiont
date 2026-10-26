//go:build unix

package semiont

import (
	"os"
	"syscall"
)

// lockFile takes an exclusive lock on f (flock), waiting until it is held.
// Closing f lets it go.
func lockFile(f *os.File) error {
	for {
		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != syscall.EINTR {
			return err
		}
	}
}
