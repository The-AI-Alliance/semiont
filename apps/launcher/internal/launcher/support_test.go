package launcher

import (
	"net"
	"os"
	"path/filepath"
	"strings"
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

// The command line shows what the launcher injects and carries no credential.
// The echo's allowlist is derived from injectedVars, not kept by hand: a
// hand-kept one once hid an injected value an operator needed to see
// (bugs/codespace-move-output-misleads.md). Since SECRET-DELIVERY P6 the
// credentials leave argv itself, for the runtime command's environment.
func TestCommandLineShowsInjectedValuesAndCarriesNoCredentials(t *testing.T) {
	argv, env := offCommandLine([]string{"run",
		"--env", "GATEWAY_HOST=192.168.64.1",
		"--env", "SEMIONT_OIDC_CLIENT_ID=semiont-worker",
		"--env", "SEMIONT_OIDC_CLIENT_SECRET=s3cret",
		"--env", "JWT_SECRET=jwt-value",
		"--env", "ANTHROPIC_API_KEY=sk-value",
		"-e", "POSTGRES_PASSWORD=pg-value",
	})
	got := strings.Join(argv, " ")
	for _, shown := range []string{"GATEWAY_HOST=192.168.64.1", "SEMIONT_OIDC_CLIENT_ID=semiont-worker"} {
		if !strings.Contains(got, shown) {
			t.Errorf("%s was hidden:\n%s", shown, got)
		}
	}
	for _, secret := range []string{"s3cret", "jwt-value", "sk-value", "pg-value"} {
		if strings.Contains(got, secret) {
			t.Errorf("a credential reached the command line (%s):\n%s", secret, got)
		}
	}
	want := []string{"SEMIONT_OIDC_CLIENT_SECRET=s3cret", "JWT_SECRET=jwt-value", "ANTHROPIC_API_KEY=sk-value", "POSTGRES_PASSWORD=pg-value"}
	if strings.Join(env, " ") != strings.Join(want, " ") {
		t.Errorf("the runtime's environment carries %v, want %v", env, want)
	}
}

// A census over what the launcher injects: a name that reads like a credential
// must be classified as one, so a new injected secret cannot start showing in
// the echo by default.
func TestInjectedCredentialsAreClassified(t *testing.T) {
	// Whole underscore-separated words, not substrings: KEYCLOAK_HOST is a
	// host, API_KEY is a credential.
	credentialWord := map[string]bool{"SECRET": true, "PASSWORD": true, "TOKEN": true, "KEY": true}
	for name := range injectedVars {
		for _, word := range strings.Split(name, "_") {
			if credentialWord[word] && !injectedCredentials[name] {
				t.Errorf("%s is injected and reads like a credential, but injectedCredentials does not name it — it would be shown in echoed commands", name)
			}
		}
	}
}
