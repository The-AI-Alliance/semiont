package launcher

// startlock.go — one `semiont start` per KB root at a time.
//
// Two starts on one root interleave destructively: each one's preflight sweeps
// containers the other is about to use, and each recreates what the other
// removed. Live 2026-09-29, a codespace's post-start and the laptop's issuer
// move did exactly that, and the stack ended half on each issuer port. The
// second start now waits for the first, then runs its own whole sequence.
//
// A lock (filelock.go) on a file in the root's state dir: held for the
// process's life and released by the kernel when it exits, crashes included,
// so there is no stale lock to clean up. The file records who holds it, for the message a
// waiting start prints and for `status`.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// startLockBudget bounds how long a start waits for another on the same root.
// A fresh codespace's first start pulls several GB of models; ten minutes was
// not enough live, so the bound is generous. It exists so a wedged start cannot
// hold a waiter forever.
const startLockBudget = 30 * time.Minute

// heldStartLock keeps the lock's file open for the life of the process: an
// *os.File that is garbage-collected closes its descriptor and so releases
// the lock mid-start. Read-only: flock needs no write access, and the holder
// note is written through its own handle, whose errors are reported.
var heldStartLock *os.File

func startLockPath(root string) string {
	dir := stateRootDir(root)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "start.lock")
}

// acquireStartLock takes the root's start lock, waiting (announced, bounded)
// while another start holds it. ok=false: refused, message printed.
func acquireStartLock(u *UI, root string) bool {
	p := startLockPath(root)
	if p == "" {
		return true // no data home: no persistent state to protect
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		u.Fail("cannot create this knowledge base's stores directory %s: %v", filepath.Dir(p), err)
		return false
	}
	f, err := os.OpenFile(p, os.O_RDONLY|os.O_CREATE, 0o600)
	if err != nil {
		u.Fail("cannot open the start lock %s: %v", p, err)
		return false
	}
	t0 := time.Now()
	announced := false
	for {
		err := lockFile(f, false)
		if err == nil {
			// Who holds it, for a waiting start's message and for `status`.
			// Not the lock itself: a start that cannot record it still runs,
			// and the others read "holder unknown".
			note := fmt.Sprintf("pid %d since %s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339))
			if err := os.WriteFile(p, []byte(note), 0o600); err != nil {
				u.Warn("Could not record this start as the holder of %s: %v", p, err)
			}
			heldStartLock = f
			return true
		}
		if !errors.Is(err, errLockHeld) {
			f.Close()
			u.Fail("cannot take the start lock %s: %v", p, err)
			return false
		}
		if !announced {
			u.Log("Another semiont start is running for this KB %s — waiting for it to finish",
				u.Dim("("+startLockHolder(p)+"; up to "+took(startLockBudget)+")"))
			announced = true
		}
		if time.Since(t0) >= startLockBudget {
			f.Close()
			u.Fail("Another semiont start has held this KB for %s (%s).", took(startLockBudget), startLockHolder(p))
			fmt.Fprintln(os.Stderr, "  If that process is gone, its lock went with it; if it is wedged, stop it and retry.")
			return false
		}
		time.Sleep(time.Second)
	}
}

// startInProgress reports whether another process holds the root's start
// lock, and who — without taking it.
func startInProgress(root string) (holder string, busy bool) {
	p := startLockPath(root)
	if p == "" {
		return "", false
	}
	f, err := os.Open(p)
	if err != nil {
		return "", false // never started here
	}
	defer f.Close()
	if err := lockFile(f, false); err != nil {
		return startLockHolder(p), true
	}
	_ = unlockFile(f)
	return "", false
}

func startLockHolder(p string) string {
	b, _ := os.ReadFile(p)
	if h := strings.TrimSpace(string(b)); h != "" {
		return h
	}
	return "holder unknown"
}
