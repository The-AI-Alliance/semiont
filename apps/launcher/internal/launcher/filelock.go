package launcher

// filelock.go — the one way this launcher excludes another process: an
// exclusive lock on an open file, held until the file is closed or the
// process ends, crashes included, so there is no stale lock to clean up. The
// start lock takes it without waiting; the sign-in store waits for it.
//
// Each system has its own call (filelock_unix.go, filelock_windows.go). On
// both, the lock excludes the lock an application on the Rust SDK takes on
// the sign-in store's tokens.lock (specs/src/sign-in-store).

import "errors"

// errLockHeld: another process holds the lock, and the caller asked not to
// wait for it.
var errLockHeld = errors.New("the lock is held by another process")
