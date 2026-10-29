//go:build unix

package launcher

import "syscall"

// processAlive: a process with this id exists. PIDs are reused, so this alone
// does not say it is the process the id was recorded for.
func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// terminateProcess asks the process to end (SIGTERM). Best-effort: a process
// already gone is the outcome wanted.
func terminateProcess(pid int) {
	_ = syscall.Kill(pid, syscall.SIGTERM)
}
