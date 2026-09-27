package launcher

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// The health budget is WALL-CLOCK, not a count of attempts. A failing probe
// costs the client's 2s timeout plus the 1s pacing sleep, so the old
// attempt-count loop could run past 3x its stated bound — a "600s" wait was
// observed taking 1346s. Against a black hole (a routable address that never
// answers, so every probe burns the full client timeout) the wait must still
// respect its budget.
func TestWaitForHTTPHonorsWallClockBudget(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	// Accept connections and never answer: every probe hits the full timeout.
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close()
		}
	}()

	u := NewUI(true)
	t0 := time.Now()
	_, ok := waitForHTTP(u, "black hole", "http://"+ln.Addr().String()+"/health", 3)
	elapsed := time.Since(t0)
	if ok {
		t.Fatal("a server that never answers must not report ready")
	}
	// Budget 3s; one probe may overshoot the deadline, so allow the client
	// timeout on top. The old attempt-count loop took ~9s here.
	if elapsed > 6*time.Second {
		t.Errorf("3s budget took %s — the wait is counting attempts, not seconds", elapsed)
	}
}

// A container that has stopped will never answer, so waiting out the budget
// for its health only delays the logs that say why: a gateway refusing its
// configuration stopped within seconds and the launcher waited 120. The wait
// watches the container it waits for, ends when that container stops (docker
// and podman say exited or dead, Apple container says stopped), and waits on
// while it runs or while the runtime cannot say.
func TestWaitForContainerHTTPEndsWhenTheContainerStops(t *testing.T) {
	cases := []struct {
		runtime, inspect string
		ends             bool
	}{
		{"docker", "echo exited", true},
		{"docker", "echo dead", true},
		{"container", `echo '[{"status":"stopped"}]'`, true},
		{"docker", "echo running", false},
		{"container", `echo '[{"status":"running"}]'`, false},
		{"docker", "exit 1", false},
	}
	for _, c := range cases {
		t.Run(c.runtime+": "+c.inspect, func(t *testing.T) {
			shim := t.TempDir()
			if err := os.WriteFile(filepath.Join(shim, c.runtime), []byte("#!/bin/sh\n"+c.inspect+"\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", shim)

			t0 := time.Now()
			_, ok := waitForContainerHTTP(NewUI(true), c.runtime, "Gateway", "semiont-gateway", harness.DeadOrigin(t)+"/api/health", 4)
			elapsed := time.Since(t0)
			if ok {
				t.Fatal("nothing answers, so the wait must not report ready")
			}
			if c.ends && elapsed > 2*time.Second {
				t.Errorf("the container has stopped, and the wait ran %s of its 4s budget", took(elapsed))
			}
			if !c.ends && elapsed < 4*time.Second {
				t.Errorf("the container may still come up, and the wait gave up after %s of its 4s budget", took(elapsed))
			}
		})
	}
}
