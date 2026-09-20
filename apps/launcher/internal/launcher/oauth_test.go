package launcher

// The device grant's terminal side: what `semiont login` shows a person, and
// what it declines to do when nobody is watching.

import (
	"strings"
	"testing"
	"time"
)

// `semiont login` shows the one-time code and, on a terminal, offers to open
// the issuer's page — the shape `gh auth login` uses. Nothing is opened when
// stdin is not a terminal: login runs from scripts, and a CI box either has no
// browser or should not be sent to one.
func TestPromptToOpenDoesNotOpenWithoutATerminal(t *testing.T) {
	// The test binary's stdin is a pipe, so this exercises the non-TTY path.
	// If it ever tried to prompt, the read would block and the test would hang
	// rather than fail — which is itself the signal.
	da := deviceAuthorization{
		UserCode:                "ABCD-1234",
		VerificationURI:         "https://issuer.test/device",
		VerificationURIComplete: "https://issuer.test/device?user_code=ABCD-1234",
	}
	s := captureStdout(t, func() {
		promptToOpen(newUI(false), da, da.VerificationURIComplete, 10*time.Minute)
	})
	// The code comes first and verbatim: a person has to compare it against the
	// page, and retype it if they approve on another machine.
	if !strings.Contains(s, "ABCD-1234") {
		t.Errorf("the one-time code was not shown: %q", s)
	}
	// The SHORT uri is what gets printed — it is the one somebody retypes.
	if !strings.Contains(s, "https://issuer.test/device") {
		t.Errorf("the verification uri was not shown: %q", s)
	}
	if strings.Contains(s, "Press Enter") {
		t.Errorf("prompted to open a browser without a terminal: %q", s)
	}
}

// The platform mapping is a fact per OS, not a guess at one.
func TestOpenBrowserNamesThePlatformCommand(t *testing.T) {
	for _, goos := range []string{"darwin", "windows", "linux"} {
		want := map[string]string{"darwin": "open", "windows": "rundll32", "linux": "xdg-open"}[goos]
		if got := browserCommand(goos, "https://x.test"); got[0] != want {
			t.Errorf("%s: want %q, got %q", goos, want, got[0])
		}
	}
}
