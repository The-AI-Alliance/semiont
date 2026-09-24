// Package harness holds the test scaffolding both the launcher and the verbs
// need.
//
// It exists because these two helpers are used by tests on BOTH sides of the
// package boundary, and a copy in each would be two statements of one fact —
// the thing this codebase refuses everywhere else. They are deliberately the
// only residents: scaffolding that one side alone uses belongs in that side's
// own test files, not here.
package harness

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

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
