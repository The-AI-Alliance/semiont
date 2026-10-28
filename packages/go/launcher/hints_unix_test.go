//go:build unix

package launcher

import (
	"os/exec"
	"regexp"
	"testing"
)

// shell runs a script the way a person pasting it would, and returns what it
// printed.
func shell(t *testing.T, script string) string {
	t.Helper()
	out, err := exec.Command("sh", "-c", script).CombinedOutput()
	if err != nil {
		t.Fatalf("sh could not run:\n%s\n%v\n%s", script, err, out)
	}
	return string(out)
}

// The lines the launcher tells a person to paste do what it says they do, in
// the shell they are for.
func TestTheSuggestedLinesRunInThisSystemsShell(t *testing.T) {
	system := systemName()
	show := `; printf %s "$PROBE_KEY"`

	if got := shell(t, randomHexHint(system, 32)); !regexp.MustCompile(`^[0-9a-f]{64}\n$`).MatchString(got) {
		t.Errorf("the key generator printed %q, want 64 hex characters", got)
	}
	if got := shell(t, setVarHint(system, "PROBE_KEY", "a-plain-value")+show); got != "a-plain-value" {
		t.Errorf("setting a variable left it %q", got)
	}
	if got := shell(t, setVarHint(system, "PROBE_KEY", inlineRandomHex(system, 32))+show); !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(got) {
		t.Errorf("setting a variable to a fresh 32-byte key left it %q", got)
	}
	if got := shell(t, setVarHint(system, "PROBE_KEY", inlineRandomHex(system, 16))+show); !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(got) {
		t.Errorf("setting a variable to a fresh 16-byte key left it %q", got)
	}
	// A rotation: the fresh key first, the old one kept after it.
	rotated := shell(t, "OLD=the-old-key; "+setVarHint(system, "PROBE_KEY", inlineRandomHex(system, 32)+",$OLD")+show)
	if !regexp.MustCompile(`^[0-9a-f]{64},the-old-key$`).MatchString(rotated) {
		t.Errorf("a rotation left the variable %q, want a fresh key, a comma, and the old one", rotated)
	}
}
