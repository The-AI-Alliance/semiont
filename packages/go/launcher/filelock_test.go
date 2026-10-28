package launcher

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openLock(t *testing.T, path string) *os.File {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDONLY|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// A second taker that will not wait is told the lock is held; once the holder
// lets go, by unlocking or by closing the file, the lock is there to take.
func TestALockExcludesASecondTakerUntilItIsLetGo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "probe.lock")
	holder, second := openLock(t, path), openLock(t, path)
	if err := lockFile(holder, false); err != nil {
		t.Fatalf("the first take: %v", err)
	}
	if err := lockFile(second, false); !errors.Is(err, errLockHeld) {
		t.Fatalf("a second take of a held lock gave %v, want errLockHeld", err)
	}
	if err := unlockFile(holder); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	if err := lockFile(second, false); err != nil {
		t.Fatalf("a take after the unlock: %v", err)
	}
	third := openLock(t, path)
	if err := lockFile(third, false); !errors.Is(err, errLockHeld) {
		t.Fatalf("a take while the second holds it gave %v, want errLockHeld", err)
	}
	second.Close()
	if err := lockFile(third, false); err != nil {
		t.Fatalf("a take after the holder closed its file: %v", err)
	}
}

// A taker that waits gets the lock when the holder lets go, and not before.
func TestAWaitingTakerGetsTheLockWhenTheHolderLetsGo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "probe.lock")
	holder, waiter := openLock(t, path), openLock(t, path)
	if err := lockFile(holder, true); err != nil {
		t.Fatal(err)
	}
	got := make(chan error, 1)
	go func() { got <- lockFile(waiter, true) }()
	select {
	case err := <-got:
		t.Fatalf("the waiter took a held lock (%v)", err)
	case <-time.After(150 * time.Millisecond):
	}
	if err := unlockFile(holder); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("the waiter's take: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiter never got the lock the holder let go")
	}
}

// What the holder writes in the lock file is readable while it holds the
// lock: a waiting start names who it is waiting for.
func TestALockFilesContentIsReadableWhileItIsHeld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "probe.lock")
	holder := openLock(t, path)
	if err := lockFile(holder, false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("pid 1 since now\n"), 0o600); err != nil {
		t.Fatalf("writing the holder's note under the lock: %v", err)
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != "pid 1 since now\n" {
		t.Fatalf("reading the holder's note under the lock: %q, %v", b, err)
	}
}
