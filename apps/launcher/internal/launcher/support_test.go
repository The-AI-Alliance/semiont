package launcher

import (
	"net"
	"testing"
	"time"
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

	u := newUI(true)
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
