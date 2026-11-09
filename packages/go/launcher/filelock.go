package launcher

// filelock.go — the one way this launcher excludes another process: an
// exclusive lock on an open file, held until the file is closed or the
// process ends, crashes included, so there is no stale lock to clean up. The
// start lock takes it without waiting; the sign-in store, the stack record
// and the roots registry wait for it.
//
// Each system has its own call (filelock_unix.go, filelock_windows.go). On
// both, the lock excludes the lock an application on the Rust SDK takes on
// the sign-in store's tokens.lock (protocol/specs/src/sign-in-store).

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// errLockHeld: another process holds the lock, and the caller asked not to
// wait for it.
var errLockHeld = errors.New("the lock is held by another process")

// exclusively runs change while this process holds the lock beside file
// (file + ".lock"). Every knowledge base's commands read, change and rewrite
// the machine's stack record and roots registry, and two starts of different
// knowledge bases run at once, so each read-modify-write holds it: without
// it, one start's write drops what the other wrote since it read. A lock that
// cannot be made or taken is an error, and change does not run. With no home
// (file is ""), there is nothing to lock and nowhere to write, and change
// runs.
func exclusively(file string, change func()) error {
	if file == "" {
		change()
		return nil
	}
	lock := file + ".lock"
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return fmt.Errorf("cannot make the lock %s: %w", lock, err)
	}
	f, err := os.OpenFile(lock, os.O_RDONLY|os.O_CREATE, ownerOnlyFileMode)
	if err != nil {
		return fmt.Errorf("cannot make the lock %s: %w", lock, err)
	}
	defer f.Close()
	if err := lockFile(f, true); err != nil {
		return fmt.Errorf("cannot take the lock %s: %w", lock, err)
	}
	change()
	return nil
}
