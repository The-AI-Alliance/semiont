//go:build windows

package launcher

import (
	"os"

	"golang.org/x/sys/windows"
)

// stillActive: the exit code Windows reports for a process that has not
// exited (STILL_ACTIVE).
const stillActive = 259

// processAlive: a process with this id exists and has not exited. PIDs are
// reused, so this alone does not say it is the process the id was recorded
// for.
func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}

// terminateProcess ends the process. Windows has no SIGTERM to ask with, so
// this is TerminateProcess. Best-effort: a process already gone is the outcome
// wanted.
func terminateProcess(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Kill()
		_ = p.Release()
	}
}
