package launcher

// paths.go — where the launcher keeps what it keeps, on each system. Each home
// is a pure function of what the system says of the person's directories, so
// one test runs every system's rule whichever machine it runs on; the
// functions that read the environment call them.
//
// The state home is the one another program finds too (the Rust SDK reads
// tokens.json there), so its rule is the spec's (stateDirFor, statefile.go).
// The data home and the log dir are this launcher's own.

import (
	"os"
	"runtime"
	"strings"
)

// systemName: this build's OS as the path rules name it — "macos", "windows",
// or anything else.
func systemName() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	}
	return runtime.GOOS
}

// systemSeparator: the path separator of a system, whichever one this build
// is for. A rule gives one answer on any test host.
func systemSeparator(system string) string {
	if system == "windows" {
		return `\`
	}
	return "/"
}

// pathUnder: names below base, joined with the system's separator.
func pathUnder(system, base string, names ...string) string {
	sep := systemSeparator(system)
	return strings.TrimRight(base, sep) + sep + strings.Join(names, sep)
}

// localAppDataFor: Windows' local application-data directory: LOCALAPPDATA,
// or where it is by default, under the home.
func localAppDataFor(home, localAppData string) string {
	if localAppData != "" {
		return localAppData
	}
	return pathUnder("windows", home, "AppData", "Local")
}

// dataDirFor: the launcher's data home — the databases and stores of each
// knowledge base. The same ~/Library/Application Support/semiont the state
// home uses on macOS (Apple keeps one home for both) and the same
// %LOCALAPPDATA%\semiont on Windows; $XDG_DATA_HOME/semiont (default
// ~/.local/share/semiont) elsewhere — database contents are XDG data, not
// XDG state. "" when there is no home.
func dataDirFor(system, home, xdgDataHome, localAppData string) string {
	switch {
	case home == "":
		return ""
	case system == "macos":
		return pathUnder(system, home, "Library", "Application Support", "semiont")
	case system == "windows":
		return pathUnder(system, localAppDataFor(home, localAppData), "semiont")
	case xdgDataHome != "":
		return pathUnder(system, xdgDataHome, "semiont")
	}
	return pathUnder(system, home, ".local", "share", "semiont")
}

// logDirFor: where launcher logs live — ~/Library/Logs/semiont on macOS (the
// platform's log home), %LOCALAPPDATA%\semiont\logs on Windows, and
// $XDG_STATE_HOME/semiont (default ~/.local/state/semiont) elsewhere: the XDG
// base-dir spec assigns logs and history to the state dir. "" when there is no
// home.
func logDirFor(system, home, xdgStateHome, localAppData string) string {
	switch {
	case home == "":
		return ""
	case system == "macos":
		return pathUnder(system, home, "Library", "Logs", "semiont")
	case system == "windows":
		return pathUnder(system, localAppDataFor(home, localAppData), "semiont", "logs")
	case xdgStateHome != "":
		return pathUnder(system, xdgStateHome, "semiont")
	}
	return pathUnder(system, home, ".local", "state", "semiont")
}

// userHome: the person's home directory, or "" when the system names none.
func userHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// stagingParent: where a start stages the configs it mounts into containers.
// /tmp on macOS and Linux, never $TMPDIR: Apple `container` cannot mount from
// /var/folders. The system's temporary directory on Windows.
func stagingParent() string {
	if runtime.GOOS == "windows" {
		return os.TempDir()
	}
	return "/tmp"
}

// stagingPattern: every staging dir a start made, for the sweep and for what
// status and a dry run print.
func stagingPattern() string {
	return pathUnder(systemName(), stagingParent(), "semiont-config.*")
}
