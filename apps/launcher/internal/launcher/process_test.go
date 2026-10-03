package launcher

import (
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// waitToBeTerminated: what TestTerminateProcessEndsAProcess starts this test
// binary with, so its child waits to be ended.
const waitToBeTerminated = "wait-to-be-terminated"

// Not a test of its own: the child half of TestTerminateProcessEndsAProcess.
// Run as any other test it returns at once.
func TestHelperWaitsToBeTerminated(t *testing.T) {
	if flag.Arg(0) != waitToBeTerminated {
		return
	}
	time.Sleep(time.Minute)
}

// A process that is running is alive, and one that has ended is not.
func TestProcessAliveKnowsARunningProcessFromAnEndedOne(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Error("this process is running, and processAlive says it is not")
	}
	ended := exec.Command(os.Args[0], "-test.run=^$")
	if err := ended.Run(); err != nil {
		t.Fatalf("running a child that exits at once: %v", err)
	}
	if processAlive(ended.Process.Pid) {
		t.Errorf("pid %d has exited and been waited for, and processAlive says it runs", ended.Process.Pid)
	}
}

// terminateProcess ends a process that would otherwise go on.
func TestTerminateProcessEndsAProcess(t *testing.T) {
	child := exec.Command(os.Args[0], "-test.run=^TestHelperWaitsToBeTerminated$", waitToBeTerminated)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- child.Wait() }()
	select {
	case err := <-exited:
		t.Fatalf("the child ended by itself (%v): it was meant to wait", err)
	case <-time.After(300 * time.Millisecond):
	}
	if !processAlive(child.Process.Pid) {
		t.Fatal("the waiting child is not alive")
	}
	terminateProcess(child.Process.Pid)
	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		_ = child.Process.Kill()
		t.Fatal("the child was still running ten seconds after terminateProcess")
	}
}

// processName names what a process runs: for this process, the test binary
// it was started as. Linux reports the first fifteen characters of a name.
func TestProcessNameNamesWhatAProcessRuns(t *testing.T) {
	started := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	name := processName(strconv.Itoa(os.Getpid()))
	if name == "" || !strings.HasPrefix(started, name) {
		t.Errorf("this process was started as %q, and processName calls it %q", started, name)
	}
	if got := processName("not-a-pid"); got != "" {
		t.Errorf("a pid that is not one was named %q", got)
	}
}
