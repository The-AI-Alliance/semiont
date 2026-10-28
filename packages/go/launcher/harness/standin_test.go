package harness

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// ran: what a stand-in printed and how it exited.
func ran(t *testing.T, dir, name string, args ...string) (string, int) {
	t.Helper()
	out, err := exec.Command(filepath.Join(dir, Exe(name)), args...).Output()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return string(out), 0
	case errors.As(err, &exit):
		return string(out), exit.ExitCode()
	}
	t.Fatalf("running %s: %v", name, err)
	return "", 0
}

// A stand-in does what its Says describes, and nothing else: tests rest on it
// answering one way for one question and another way for the rest.
func TestAStandInDoesWhatItIsTold(t *testing.T) {
	dir := t.TempDir()

	StandIn(t, dir, "knows-one", Says{Out: "running", OnlyGiven: "semiont-browser"})
	if out, code := ran(t, dir, "knows-one", "inspect", "semiont-browser"); out != "running\n" || code != 0 {
		t.Errorf("given the argument it knows: %q, exit %d; want the line and 0", out, code)
	}
	if out, code := ran(t, dir, "knows-one", "inspect", "0000deadbeef"); out != "" || code != 1 {
		t.Errorf("given another argument: %q, exit %d; want nothing and 1", out, code)
	}

	StandIn(t, dir, "fails", Says{Out: "dead", Exit: 3})
	if out, code := ran(t, dir, "fails"); out != "dead\n" || code != 3 {
		t.Errorf("told to print and fail: %q, exit %d; want the line and 3", out, code)
	}

	StandIn(t, dir, "silent", Says{})
	if out, code := ran(t, dir, "silent", "anything"); out != "" || code != 0 {
		t.Errorf("told nothing: %q, exit %d; want nothing and 0", out, code)
	}

	file := filepath.Join(dir, "value")
	if err := os.WriteFile(file, []byte("from the file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	StandIn(t, dir, "reads", Says{PrintsTheFile: true})
	if out, code := ran(t, dir, "reads", "read", file); out != "from the file\n" || code != 0 {
		t.Errorf("told to print the file: %q, exit %d", out, code)
	}
	if _, code := ran(t, dir, "reads", filepath.Join(dir, "no-such-file")); code == 0 {
		t.Error("told to print a file that is not there, and it exited 0")
	}

	StandIn(t, dir, "waits", Says{Waits: true})
	waiting := exec.Command(filepath.Join(dir, Exe("waits")))
	if err := waiting.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan error, 1)
	go func() { ended <- waiting.Wait() }()
	select {
	case err := <-ended:
		t.Fatalf("told to wait, and it ended by itself: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	_ = waiting.Process.Kill()
	<-ended
}

// A home of the test's own is where every system looks for one.
func TestHomeNamesItForEverySystem(t *testing.T) {
	home := Home(t)
	for name, want := range map[string]string{
		"HOME":            home,
		"USERPROFILE":     home,
		"LOCALAPPDATA":    filepath.Join(home, "AppData", "Local"),
		"XDG_STATE_HOME":  "",
		"XDG_DATA_HOME":   "",
		"XDG_CONFIG_HOME": "",
	} {
		if got := os.Getenv(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if got, err := os.UserHomeDir(); err != nil || got != home {
		t.Errorf("os.UserHomeDir() = %q, %v; want the test's own home", got, err)
	}
}
