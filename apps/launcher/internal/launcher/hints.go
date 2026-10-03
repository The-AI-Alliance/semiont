package launcher

import (
	"fmt"
	"strings"
)

// The commands the launcher suggests are the ones the system it runs on has:
// a POSIX shell's on macOS and Linux, PowerShell's on Windows. Each is a pure
// function of the system, so every system's wording is tested on any host.

// holdersHint: what shows who holds a port.
func holdersHint(system string, port int) string {
	if system == "windows" {
		return fmt.Sprintf("netstat -ano | findstr :%d", port)
	}
	return fmt.Sprintf("lsof -ti :%d", port)
}

// stopProcessesHint: what ends processes.
func stopProcessesHint(system string, pids []string) string {
	if system == "windows" {
		return "taskkill /PID " + strings.Join(pids, " /PID ")
	}
	return "kill " + strings.Join(pids, " ")
}

// setAsideHint: what moves a file out of the way, under the name it gives.
func setAsideHint(system, path, aside string) string {
	if system == "windows" {
		// The quotes are written plainly: %q would double every backslash.
		return fmt.Sprintf(`move "%s" "%s"`, path, aside)
	}
	return fmt.Sprintf("mv %q %q", path, aside)
}

// setVarHint: what sets an environment variable for the commands typed after
// it. The value is written as the shell reads it, so one from inlineRandomHex
// is run and a $NAME in it is expanded.
func setVarHint(system, name, value string) string {
	if system == "windows" {
		return fmt.Sprintf(`$env:%s = "%s"`, name, value)
	}
	return fmt.Sprintf("export %s=%s", name, value)
}

// powershellRandomHex: PowerShell statements that end in n random bytes as
// hex, from the system's cryptographic generator. Windows has no openssl, and
// Get-Random is not that generator in the PowerShell Windows ships.
func powershellRandomHex(n int) string {
	return fmt.Sprintf("$b = [byte[]]::new(%d); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | %% { '{0:x2}' -f $_ })", n)
}

// randomHexHint: what prints n random bytes as hex.
func randomHexHint(system string, n int) string {
	if system == "windows" {
		return powershellRandomHex(n)
	}
	return fmt.Sprintf("openssl rand -hex %d", n)
}

// inlineRandomHex: the same, as the shell takes it inside a command line.
func inlineRandomHex(system string, n int) string {
	return "$(" + randomHexHint(system, n) + ")"
}
