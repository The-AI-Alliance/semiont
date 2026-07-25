package launcher_test

// TEMPORARY measurement probe — delete after reading. Prints a start's own
// stdout (which carries took() durations per wait) plus wall clock, so the
// 15s-per-start cost can be attributed instead of guessed at.

import (
	"testing"
	"time"
)

func TestProbeStartTiming(t *testing.T) {
	s := newScenario(t, "container")
	t0 := time.Now()
	stdout, stderr, code := s.run(t, "start")
	t.Logf("=== start took %s (exit %d) ===\n%s\n--- stderr ---\n%s",
		time.Since(t0).Round(time.Millisecond), code, stdout, stderr)

	t1 := time.Now()
	s.stdin = "hunter2secret\n"
	stdout2, _, code2 := s.run(t, "login", "--email", "admin@example.com")
	t.Logf("=== login took %s (exit %d) ===\n%s", time.Since(t1).Round(time.Millisecond), code2, stdout2)
}
