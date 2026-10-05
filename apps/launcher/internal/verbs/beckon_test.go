package verbs

// beckon_test.go — the audience note beckon prints, split out of the
// launcher's models_test.go when the verbs moved to their own package: it
// tests a verb's wording and had only ever lived there because everything
// lived there.

import (
	"strings"
	"testing"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"
)

// The subscriber count is the only thing standing between "sent" and "seen",
// so what each value licenses the CLI to SAY is the deliverable — not the
// number. Three genuinely different answers; conflating any two of them is
// how a tour script ends up trusting a ✓ that meant nothing.
func TestAudienceNote(t *testing.T) {
	u := launcher.NewUI(true) // no ANSI, so the assertions are about words
	for _, c := range []struct {
		name        string
		subscribers int
		counted     bool
		want        string
		absent      string
	}{
		{"nobody listening is said plainly", 0, true, "nothing is subscribed to beckon:focus", "no delivery confirmation"},
		{"an uncounted emit claims nothing", 0, false, "no delivery confirmation", "nothing is subscribed"},
		{"one subscriber, still not delivery", 1, true, "1 subscriber", "1 subscribers"},
		{"several subscribers", 4, true, "4 subscribers", "nothing is subscribed"},
	} {
		got := audienceNote(u, c.subscribers, c.counted, "beckon:focus")
		if !strings.Contains(got, c.want) {
			t.Errorf("%s: audienceNote(%d) = %q, want it to contain %q", c.name, c.subscribers, got, c.want)
		}
		if c.absent != "" && strings.Contains(got, c.absent) {
			t.Errorf("%s: audienceNote(%d) = %q, must not contain %q", c.name, c.subscribers, got, c.absent)
		}
	}
	// A positive count must never be read as delivery.
	if got := audienceNote(u, 3, true, "beckon:focus"); !strings.Contains(got, "no confirmation anyone looked") {
		t.Errorf("a subscriber count must not be dressed up as delivery: %q", got)
	}
}
