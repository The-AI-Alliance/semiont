// Package harness holds the test scaffolding both the launcher and the verbs
// need.
//
// It exists because these helpers are used by tests on BOTH sides of the
// package boundary, and a copy in each would be two statements of one fact —
// the thing this codebase refuses everywhere else. They are deliberately the
// only residents: scaffolding that one side alone uses belongs in that side's
// own test files, not here.
package harness

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// Exe is the file name a program has on this system: `.exe` on the end on
// Windows, which is how a program is found on PATH there.
func Exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// Says is what a stand-in program does when it is run.
type Says struct {
	// Out is a line it prints.
	Out string `json:"out"`
	// Exit is its exit code.
	Exit int `json:"exit"`
	// OnlyGiven is an argument it has to be given to do any of this. Run
	// without it, the program prints nothing and exits 1.
	OnlyGiven string `json:"onlyGiven"`
	// PrintsTheFile: it prints the file its last argument names, as `cat`
	// does.
	PrintsTheFile bool `json:"printsTheFile"`
	// Waits: it then stays running until something ends it, as `sleep` does.
	Waits bool `json:"waits"`
}

// standIn is the stand-in program, built once per test binary.
var standIn = sync.OnceValues(func() ([]byte, error) {
	dir, err := os.MkdirTemp("", "standin")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	bin := filepath.Join(dir, Exe("standin"))
	const pkg = "github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness/standin"
	if out, err := exec.Command("go", "build", "-o", bin, pkg).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("building %s: %v\n%s", pkg, err, out)
	}
	return os.ReadFile(bin)
})

// StandIn puts a program called `name` in dir that does what `says` and
// nothing else: a runtime that answers one way, a provider's CLI that reads
// one file. A shell script would do that on two systems out of three.
func StandIn(t *testing.T, dir, name string, says Says) {
	t.Helper()
	program, err := standIn()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, Exe(name)), program, 0o755); err != nil {
		t.Fatal(err)
	}
	script, err := json.Marshal(says)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".says"), script, 0o644); err != nil {
		t.Fatal(err)
	}
}

// HomeEnv is the environment that puts a program's home at `home` on every
// system: HOME, with the XDG homes left to their defaults under it, for macOS
// and Linux, and USERPROFILE and LOCALAPPDATA for Windows.
func HomeEnv(home string) map[string]string {
	return map[string]string{
		"HOME":            home,
		"XDG_STATE_HOME":  "",
		"XDG_DATA_HOME":   "",
		"XDG_CONFIG_HOME": "",
		"USERPROFILE":     home,
		"LOCALAPPDATA":    filepath.Join(home, "AppData", "Local"),
	}
}

// Home gives a test a home directory of its own, and returns it. Nothing the
// test does then reaches the real registry, sign-ins or kept secrets, on any
// system.
func Home(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	for name, value := range HomeEnv(home) {
		t.Setenv(name, value)
	}
	return home
}

// NoRuntimes points PATH at an empty directory, so nothing finds a container
// runtime — the state a machine with none is in.
func NoRuntimes(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", t.TempDir())
}

// DeadOrigin returns an origin nothing is listening on: a port is bound to
// learn a free number, then closed. A connection there is refused rather than
// hanging, which is what makes it usable as a probe target in a test.
func DeadOrigin(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return "http://" + addr
}

// CaptureOutput runs fn with os.Stdout and os.Stderr replaced by pipes and
// returns what each received. Both packages' commands report by printing, so
// both need to read what a command actually said.
func CaptureOutput(t *testing.T, fn func()) (stdout, stderr string) {
	t.Helper()
	oldOut, oldErr := os.Stdout, os.Stderr
	rOut, wOut, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	rErr, wErr, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout, os.Stderr = wOut, wErr
	drain := func(r *os.File, out chan<- string) {
		var sb strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			sb.Write(buf[:n])
			if err != nil {
				break
			}
		}
		out <- sb.String()
	}
	outCh, errCh := make(chan string, 1), make(chan string, 1)
	go drain(rOut, outCh)
	go drain(rErr, errCh)
	fn()
	wOut.Close()
	wErr.Close()
	os.Stdout, os.Stderr = oldOut, oldErr
	return <-outCh, <-errCh
}

// MustContainAll fails the test unless `s` contains every fragment. Used on
// both sides to assert what a command reported without pinning its exact
// wording.
func MustContainAll(t *testing.T, label, haystack string, needles ...string) {
	t.Helper()
	for _, n := range needles {
		if !strings.Contains(haystack, n) {
			t.Errorf("%s missing %q; full text:\n%s", label, n, haystack)
		}
	}
}

// LiveOrigin returns the origin of a server that answers 200 to anything, and
// stops when the test does — DeadOrigin's counterpart.
func LiveOrigin(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// CaptureStdout is CaptureOutput for the commands that report on stdout alone.
func CaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	out, _ := CaptureOutput(t, fn)
	return out
}
