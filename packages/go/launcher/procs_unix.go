//go:build unix

package launcher

import (
	"fmt"
	"os/exec"
	"strings"
)

// listenersOn returns the PIDs LISTENING on a TCP port. Several is normal
// (parent+child servers, SO_REUSEPORT), so callers iterate.
//
// Both flags are load-bearing. Without `-sTCP:LISTEN`, lsof also matches CLOSED
// and connected sockets on the port, so a client that merely dialed it reads as
// its holder. Without `-nP`, it resolves names and can stall on a slow resolver.
func listenersOn(port int) []string {
	out, err := capture("lsof", "-nP", fmt.Sprintf("-iTCP:%d", port), "-sTCP:LISTEN")
	if err != nil || out == "" {
		return nil
	}
	var pids []string
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[1] == "PID" {
			continue
		}
		if !seen[fields[1]] {
			seen[fields[1]] = true
			pids = append(pids, fields[1])
		}
	}
	return pids
}

// processName: the command a process runs, or "" when it cannot be read.
func processName(pid string) string {
	comm, err := capture("ps", "-p", pid, "-o", "comm=")
	if err != nil {
		return ""
	}
	return comm
}

// ollamaOnHost: which Ollama runs on this machine — the Desktop app, the
// `ollama serve` daemon, or "" when neither is found.
func ollamaOnHost() string {
	switch {
	case runSilent("pgrep", "-f", "Ollama.app/Contents") == nil:
		return "Ollama Desktop app"
	case runSilent("pgrep", "-f", "ollama serve") == nil:
		return "ollama serve daemon"
	}
	return ""
}

// detachFromConsole: nothing to do on Unix. A forward is started with no
// controlling relationship a Ctrl+C in the launcher would follow.
func detachFromConsole(*exec.Cmd) {}
