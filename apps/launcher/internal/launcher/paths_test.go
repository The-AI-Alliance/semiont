package launcher

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The data home and the log dir on each system, whichever machine runs this:
// each path is composed with the system's own separator.
func TestTheDataHomeAndTheLogDirAreWhereEachSystemPutsThem(t *testing.T) {
	const winLocal = `C:\Users\alice\AppData\Local`
	for _, c := range []struct {
		why                      string
		system, home, xdg, local string
		wantData, wantLog        string
	}{
		{why: "macOS keeps data beside state, and logs in the platform's log home",
			system: "macos", home: "/Users/alice",
			wantData: "/Users/alice/Library/Application Support/semiont", wantLog: "/Users/alice/Library/Logs/semiont"},
		{why: "macOS reads no XDG variable",
			system: "macos", home: "/Users/alice", xdg: "/var/x",
			wantData: "/Users/alice/Library/Application Support/semiont", wantLog: "/Users/alice/Library/Logs/semiont"},
		{why: "Linux defaults",
			system: "linux", home: "/home/alice",
			wantData: "/home/alice/.local/share/semiont", wantLog: "/home/alice/.local/state/semiont"},
		{why: "Linux follows the XDG variable it is given",
			system: "linux", home: "/home/alice", xdg: "/var/x",
			wantData: "/var/x/semiont", wantLog: "/var/x/semiont"},
		{why: "Windows keeps both under the local application data",
			system: "windows", home: `C:\Users\alice`, local: winLocal,
			wantData: winLocal + `\semiont`, wantLog: winLocal + `\semiont\logs`},
		{why: "Windows follows LOCALAPPDATA where it is not under the home",
			system: "windows", home: `C:\Users\alice`, local: `D:\Profiles\alice\Local`,
			wantData: `D:\Profiles\alice\Local\semiont`, wantLog: `D:\Profiles\alice\Local\semiont\logs`},
		{why: "Windows, with LOCALAPPDATA not set: where it is by default",
			system: "windows", home: `C:\Users\alice`,
			wantData: winLocal + `\semiont`, wantLog: winLocal + `\semiont\logs`},
		{why: "Windows reads no XDG variable",
			system: "windows", home: `C:\Users\alice`, xdg: `D:\x`, local: winLocal,
			wantData: winLocal + `\semiont`, wantLog: winLocal + `\semiont\logs`},
		{why: "no home, no data home and no log dir", system: "linux", xdg: "/var/x"},
		{why: "no home on Windows either", system: "windows", local: winLocal},
	} {
		if got := dataDirFor(c.system, c.home, c.xdg, c.local); got != c.wantData {
			t.Errorf("%s: the data home is %q, want %q", c.why, got, c.wantData)
		}
		if got := logDirFor(c.system, c.home, c.xdg, c.local); got != c.wantLog {
			t.Errorf("%s: the log dir is %q, want %q", c.why, got, c.wantLog)
		}
	}
}

// On macOS the data home is the state home: Apple keeps one bucket for both.
// On Windows too. The spec's cases say where the state home is; this holds the
// data home to the same place on those two systems.
func TestTheDataHomeIsTheStateHomeWhereTheSystemKeepsOneBucket(t *testing.T) {
	for _, c := range []struct{ system, home, local string }{
		{"macos", "/Users/alice", ""},
		{"windows", `C:\Users\alice`, `C:\Users\alice\AppData\Local`},
		{"windows", `C:\Users\alice`, ""},
	} {
		if data, state := dataDirFor(c.system, c.home, "", c.local), stateDirFor(c.system, c.home, "", c.local); data != state {
			t.Errorf("%s: the data home %q is not the state home %q", c.system, data, state)
		}
	}
}

// The staging dirs are found where they are made: the pattern the sweep, stop
// and status use matches a directory stageDir creates.
func TestTheStagingPatternMatchesWhatAStartStages(t *testing.T) {
	x := &liveExec{u: NewUI(true)}
	stage, ok := x.stageDir()
	if !ok {
		t.Fatal("stageDir failed")
	}
	t.Cleanup(func() { _ = os.RemoveAll(stage) })
	found, err := filepath.Glob(stagingPattern())
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range found {
		if dir == stage {
			return
		}
	}
	t.Errorf("%s is not among what %s matches: %v", stage, stagingPattern(), found)
}

// A POSIX tool run by its name is a line that fails on Windows at run time
// and compiles everywhere. Each lives in a file built for the systems that
// have it, with its Windows counterpart beside it. This fails on one added
// anywhere else.
func TestNoPOSIXToolIsRunOutsideAPerSystemFile(t *testing.T) {
	// The tool is the FIRST argument: `capture(rt, "ps", …)` is the container
	// runtime's own `ps`, on every system.
	run := regexp.MustCompile(`(capture|runSilent|runVisible|exec\.Command)\("(lsof|ps|pgrep|stty|sysctl|defaults|open|xdg-open|netstat|tasklist|rundll32)"`)
	perSystem := regexp.MustCompile(`_(unix|darwin|linux|windows)\.go$`)
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || perSystem.MatchString(f) {
			continue
		}
		scanned++
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range run.FindAllString(string(b), -1) {
			t.Errorf("%s runs a system tool by name outside a per-system file: %s", f, m)
		}
	}
	if scanned < 20 {
		t.Fatalf("scanned %d files: this census is looking in the wrong place", scanned)
	}
}
