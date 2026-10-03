//go:build windows

package launcher

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"unicode/utf16"
)

// shell runs a script the way a person pasting it would, in the PowerShell
// Windows ships, and returns what it printed. The script goes in encoded, as
// PowerShell takes one whole: a command line would put two layers of quoting
// between the text under test and the shell that reads it.
func shell(t *testing.T, script string) string {
	t.Helper()
	units := utf16.Encode([]rune(script))
	raw := make([]byte, 2*len(units))
	for i, unit := range units {
		binary.LittleEndian.PutUint16(raw[2*i:], unit)
	}
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw)).Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			t.Fatalf("powershell could not run:\n%s\n%v\n%s", script, err, exit.Stderr)
		}
		t.Fatalf("powershell could not run:\n%s\n%v", script, err)
	}
	return strings.TrimRight(string(out), "\r\n")
}

// The lines the launcher tells a person to paste do what it says they do, in
// the shell they are for.
func TestTheSuggestedLinesRunInThisSystemsShell(t *testing.T) {
	system := systemName()
	show := `; [Console]::Out.Write($env:PROBE_KEY)`

	if got := shell(t, randomHexHint(system, 32)); !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(got) {
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
	rotated := shell(t, `$OLD = "the-old-key"; `+setVarHint(system, "PROBE_KEY", inlineRandomHex(system, 32)+",$OLD")+show)
	if !regexp.MustCompile(`^[0-9a-f]{64},the-old-key$`).MatchString(rotated) {
		t.Errorf("a rotation left the variable %q, want a fresh key, a comma, and the old one", rotated)
	}
}
