package launcher

import "testing"

func isReady(tn *turn) bool {
	select {
	case <-tn.ready:
		return true
	default:
		return false
	}
}

// Turns are given in the order they were taken, one at a time; a turn left
// before it came is skipped, and one given up readies the next.
func TestTurnsAreGivenInTheOrderTaken(t *testing.T) {
	var line turnstile
	first := line.take()
	second := line.take()
	third := line.take()
	fourth := line.take()
	if !isReady(first) || isReady(second) || isReady(third) || isReady(fourth) {
		t.Fatal("the first turn taken is the only one ready")
	}
	line.abandon(third)
	line.give(first)
	if !isReady(second) || isReady(fourth) {
		t.Fatal("giving the first turn readies the second, and only it")
	}
	line.abandon(second)
	if !isReady(fourth) {
		t.Fatal("abandoning the held turn readies the next still in line, past the one that left")
	}
	line.give(fourth)
	if fifth := line.take(); !isReady(fifth) {
		t.Fatal("a turn taken with nobody holding one is ready at once")
	}
}

func TestGivingATurnNotHeldPanics(t *testing.T) {
	var line turnstile
	line.take()
	waiting := line.take()
	defer func() {
		if recover() == nil {
			t.Fatal("giving up a turn not held did not panic")
		}
	}()
	line.give(waiting)
}

// Each secret value noted is scrubbed wherever it appears, a value that
// contains another whole; one too short to scrub is left.
func TestScrubSecretsRemovesEachNotedValue(t *testing.T) {
	inner := "scrub-test-4f1c9a"
	outer := "Bearer scrub-test-4f1c9a.b7e2d0"
	short := "s3cr7"
	noteSecret(inner)
	noteSecret(outer)
	noteSecret(short)
	line := "auth: Bearer scrub-test-4f1c9a.b7e2d0; key scrub-test-4f1c9a; pin s3cr7"
	want := "auth: ‹secret›; key ‹secret›; pin s3cr7"
	if got := scrubSecrets(line); got != want {
		t.Errorf("scrubSecrets(%q) = %q, want %q", line, got, want)
	}
}

func TestStripANSIRemovesTerminalEscapes(t *testing.T) {
	cases := map[string]string{
		"plain":                              "plain",
		AnsiBold + "bold" + AnsiReset:        "bold",
		"\033[38;5;214mwarn\033[0m: careful": "warn: careful",
		"cut off \033[":                      "cut off ",
	}
	for in, want := range cases {
		if got := stripANSI(in); got != want {
			t.Errorf("stripANSI(%q) = %q, want %q", in, got, want)
		}
	}
}
