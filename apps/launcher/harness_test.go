package main_test

// The test harness's own guarantees: fakert behaves like a runtime about the
// ports it publishes, and a scenario's cleanup frees every port it took — or
// fails the test that leaked it, never a later one.

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// heldPort: a loopback port this test holds open until it ends.
func heldPort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
}

// freePort: a loopback port nothing holds right now.
func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
}

func portIsFree(port string) bool {
	ln, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		return false
	}
	ln.Close()
	return true
}

// shimCmd runs one of the scenario's fakert personas with its environment.
func shimCmd(s *scenario, name string, args ...string) *exec.Cmd {
	cmd := exec.Command(filepath.Join(s.shim, name), args...)
	cmd.Env = s.env()
	return cmd
}

// namedByTheFake: what the fake says a process runs, asked the way the
// launcher asks this system.
func namedByTheFake(s *scenario, pid string) (string, error) {
	if runtime.GOOS == "windows" {
		out, err := shimCmd(s, "tasklist", "/FI", "PID eq "+pid, "/FO", "CSV", "/NH").Output()
		image, _, _ := strings.Cut(strings.TrimPrefix(string(out), `"`), `"`)
		return strings.TrimSuffix(image, ".exe"), err
	}
	out, err := shimCmd(s, "ps", "-p", pid, "-o", "comm=").Output()
	return strings.TrimSpace(string(out)), err
}

// A real runtime refuses to publish a port something else holds — Docker says
// "port is already allocated" and exits 125. fakert used to report success
// when its listener could not bind, because its readiness check only dialed
// the port and the other holder answered (CI run 36800353204: every later
// request of that test went to another test's server).
func TestFakeRuntimeRefusesAPortAlreadyHeld(t *testing.T) {
	s := newScenario(t, "docker")
	port := heldPort(t)
	out, err := shimCmd(s, "docker", "run", "-d", "--name", "semiont-gateway", "-p", port+":4000", "img").CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 125 {
		t.Fatalf("run -d on a held port: err %v, want exit 125\n%s", err, out)
	}
	mustContain(t, "run -d", string(out), "port is already allocated", port)
	if _, err := os.Stat(filepath.Join(s.fakertDir, "serve-semiont-gateway.pid")); err == nil {
		t.Error("a container that never started was recorded as running")
	}
}

// errorRecorder stands in for a testing.T, to check what killServes reports.
type errorRecorder struct{ errors []string }

func (r *errorRecorder) Helper() {}
func (r *errorRecorder) Errorf(format string, a ...any) {
	r.errors = append(r.errors, fmt.Sprintf(format, a...))
}

// A cleanup that cannot free a port says which, so the test that leaked the
// listener fails rather than whichever test next needs the port.
func TestKillServesNamesAPortItCouldNotFree(t *testing.T) {
	s := newScenario(t)
	port := heldPort(t) // held by this test, so no kill frees it
	// A process that is not a listener: killing it frees nothing.
	bin := t.TempDir()
	harness.StandIn(t, bin, "bystander", harness.Says{Waits: true})
	child := exec.Command(filepath.Join(bin, harness.Exe("bystander")))
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _, _ = child.Process.Wait() })
	pidfile := filepath.Join(s.fakertDir, "serve-semiont-leaky.pid")
	if err := os.WriteFile(pidfile, []byte(strconv.Itoa(child.Process.Pid)+"\n"+port), 0o644); err != nil {
		t.Fatal(err)
	}
	var rec errorRecorder
	s.killServes(&rec)
	if len(rec.errors) != 1 {
		t.Fatalf("killServes reported %d errors, want one naming port %s: %v", len(rec.errors), port, rec.errors)
	}
	mustContain(t, "killServes's report", rec.errors[0], port, "serve-semiont-leaky.pid")
}

// A codespace forward's pidfile records the port it holds, as `run -d`'s do,
// so cleanup waits for that port as well as killing the process.
func TestForwardPidfileRecordsItsPort(t *testing.T) {
	s := newScenario(t, "gh")
	local := freePort(t)
	fwd := shimCmd(s, "gh", "codespace", "ports", "forward", "4000:"+local, "-c", "fake-cs")
	if err := fwd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fwd.Process.Kill(); _, _ = fwd.Process.Wait() })
	pidfile := filepath.Join(s.fakertDir, "serve-gh-forward-"+local+".pid")
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && portIsFree(local) {
		time.Sleep(20 * time.Millisecond)
	}
	b, err := os.ReadFile(pidfile)
	if err != nil {
		t.Fatalf("no forward pidfile: %v", err)
	}
	lines := strings.SplitN(strings.TrimSpace(string(b)), "\n", 2)
	if len(lines) != 2 || strings.TrimSpace(lines[1]) != local {
		t.Fatalf("forward pidfile %q does not record port %s", b, local)
	}
	// The fake still names the forward gh, which forwardAlive requires.
	if name, err := namedByTheFake(s, strings.TrimSpace(lines[0])); err != nil || name != "gh" {
		t.Errorf("the forward is named %q (%v), want gh", name, err)
	}
	s.killServes(t)
	if !portIsFree(local) {
		t.Errorf("port %s still held after killServes", local)
	}
}

// A published port needs a name: the name is how fakert knows which image's
// routes to serve, and without one its listener died before binding while
// `run -d` reported a container running. It refuses, as it refuses every
// invocation it cannot model, and leaves nothing listening.
func TestUnnamedRunWithAPortIsRefused(t *testing.T) {
	s := newScenario(t, "docker")
	port := freePort(t)
	out, err := shimCmd(s, "docker", "run", "-d", "-p", port+":80", "img").CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 64 {
		t.Fatalf("run -d -p without --name: err %v, want exit 64\n%s", err, out)
	}
	mustContain(t, "run -d", string(out), "--name")
	if !portIsFree(port) {
		t.Errorf("port %s held after a refused run", port)
	}
}

// A listener that cannot start says why, and the run fails: before, `run -d`
// reported a running container whatever happened to its listener.
func TestServeThatCannotStartFailsTheRun(t *testing.T) {
	s := newScenario(t, "docker")
	port := freePort(t)
	out, err := shimCmd(s, "docker", "run", "-d", "--name", "semiont-nonesuch", "-p", port+":80", "img").CombinedOutput()
	if err == nil {
		t.Fatalf("run -d of a service with no image succeeded:\n%s", out)
	}
	mustContain(t, "run -d", string(out), "semiont-nonesuch")
	if _, err := os.Stat(filepath.Join(s.fakertDir, "serve-semiont-nonesuch.pid")); err == nil {
		t.Error("a container whose listener never started was recorded as running")
	}
}

// The fake gateway survives concurrent requests. `status` asks three limits
// operations at once, and the fake counted bearer uses in an unguarded map: Go
// kills a process on concurrent map writes, so the gateway died mid-status and
// every call after it failed fast — no ceilings, and a session reported as
// "stack not reachable" (CI runs 36800353204 and 36951774369).
func TestFakeGatewaySurvivesConcurrentRequests(t *testing.T) {
	s := newScenario(t, "docker")
	port := freePort(t)
	if out, err := shimCmd(s, "docker", "run", "-d", "--name", "semiont-gateway", "-p", port+":4000", "img").CombinedOutput(); err != nil {
		t.Fatalf("run -d: %v\n%s", err, out)
	}
	whoami := func() (int, error) {
		req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+port+"/api/users/me", nil)
		if err != nil {
			return 0, err
		}
		req.Header.Set("Authorization", "Bearer fake-jwt-token")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.StatusCode, nil
	}
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 200 {
				_, _ = whoami()
			}
		}()
	}
	wg.Wait()
	if code, err := whoami(); err != nil || code != http.StatusOK {
		t.Fatalf("after concurrent requests the fake gateway answers (%d, %v), want 200: it did not survive them", code, err)
	}
}
