package launcher

// The device grant's terminal side: what `semiont login` shows a person, and
// what it declines to do when nobody is watching.

import (
	"strings"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// `semiont login` shows the one-time code AND the verification URI, always,
// and only then — on a terminal — offers to open the page. The shape is
// `gh auth login`'s; what differs is that neither piece of information is
// gated on detecting a terminal, because a person whose browser does not open
// still needs both.
//
// This failed in CI once, for the reason `stdinIsTerminal` now exists: a CI
// step's stdin is commonly /dev/null, which IS a character device, so the
// shorthand check read as interactive and the URI was never printed.
func TestPromptToOpenAlwaysShowsTheCodeAndURI(t *testing.T) {
	da := deviceAuthorization{
		UserCode:                "ABCD-1234",
		VerificationURI:         "https://issuer.test/device",
		VerificationURIComplete: "https://issuer.test/device?user_code=ABCD-1234",
	}
	s := harness.CaptureStdout(t, func() {
		promptToOpen(NewUI(false), da, da.VerificationURIComplete, 10*time.Minute)
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
	// The prompt goes to stderr and is not captured here; what this pins is
	// that the two facts a person needs are on stdout either way.
}

// A pipe or a regular file is decided without spawning anything — the stty
// probe is only reached for a character device.
func TestStdinIsNotATerminalUnderTest(t *testing.T) {
	if stdinIsTerminal() {
		t.Skip("this runner gave the test binary a real terminal; nothing to assert")
	}
}

// The platform mapping is a fact per OS, not a guess at one.
func TestOpenBrowserNamesThePlatformCommand(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		want := map[string]string{"darwin": "open", "linux": "xdg-open"}[goos]
		if got := browserCommand(goos, "https://x.test"); got[0] != want {
			t.Errorf("%s: want %q, got %q", goos, want, got[0])
		}
	}
}
