//go:build windows

package launcher

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// listenersOn returns the PIDs LISTENING on a TCP port, from `netstat -ano`.
func listenersOn(port int) []string {
	out, err := capture("netstat", "-ano", "-p", "TCP")
	if err != nil {
		return nil
	}
	return netstatListeners(out, port)
}

// processName: what a process runs, from `tasklist`, which names the
// system's own processes too — the ones this user may not open to ask. The
// image's name without its .exe (gh), or "" when there is no such process.
func processName(pid string) string {
	out, err := capture("tasklist", "/FI", "PID eq "+pid, "/FO", "CSV", "/NH")
	if err != nil {
		return ""
	}
	return tasklistImage(out, pid)
}

// ollamaOnHost: which Ollama runs on this machine. The distinction the Unix
// build draws (the Desktop app or the daemon) is macOS's; here nothing is
// detected.
func ollamaOnHost() string { return "" }

// detachFromConsole gives a forward its own process group, so a Ctrl+C in the
// launcher's console does not reach the tunnel.
func detachFromConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}
