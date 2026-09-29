package launcher

// startlock.go — one `semiont start` per KB root at a time
// (bugs/codespace-issuer-move-races-post-start.md P1).
//
// Two starts on one root interleave destructively: each one's preflight sweeps
// containers the other is about to use, and each recreates what the other
// removed. Live 2026-09-29, a codespace's post-start and the laptop's issuer
// move did exactly that, and the stack ended half on each issuer port. The
// second start now waits for the first, then runs its own whole sequence.
//
// An flock on a file in the root's state dir: held for the process's life and
// released by the kernel when it exits, crashes included, so there is no
// stale lock to clean up. The file records who holds it, for the message a
// waiting start prints and for `status`.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// startLockBudget bounds how long a start waits for another on the same root.
// A fresh codespace's first start pulls several GB of models; ten minutes was
// not enough live, so the bound is generous. It exists so a wedged start cannot
// hold a waiter forever.
const startLockBudget = 30 * time.Minute

// heldStartLock keeps the lock's file open for the life of the process: an
// *os.File that is garbage-collected closes its descriptor and so releases
// the lock mid-start.
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
		u.Fail("cannot create state dir %s: %v", filepath.Dir(p), err)
		return false
	}
	f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		u.Fail("cannot open the start lock %s: %v", p, err)
		return false
	}
	t0 := time.Now()
	announced := false
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			_ = f.Truncate(0)
			_, _ = f.WriteAt([]byte(fmt.Sprintf("pid %d since %s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339))), 0)
			heldStartLock = f
			return true
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
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
	f, err := os.OpenFile(p, os.O_RDWR, 0)
	if err != nil {
		return "", false // never started here
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return startLockHolder(p), true
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return "", false
}

func startLockHolder(p string) string {
	b, _ := os.ReadFile(p)
	if h := strings.TrimSpace(string(b)); h != "" {
		return h
	}
	return "holder unknown"
}
