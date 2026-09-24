package launcher

import (
	"regexp"
	"strings"
	"testing"
)

// The hint is constructed, so a call site cannot invent a flag. What it can
// still do is grow one HERE — so its own output is checked against useradd's
// help, which is the only enumeration of the accepted flags that exists (the
// parser is a switch).
//
// This reads two strings this package owns. An earlier version scanned every
// .go file for advertisements, which is what construction replaced: it missed
// a concatenated one, and widening the regex to catch it is the kind of fix
// that only holds until the next spelling.
func TestUseraddHintUsesRealFlags(t *testing.T) {
	flag := regexp.MustCompile(`--[a-z-]+`)
	for _, hint := range []string{useraddHint(""), useraddHint("owner/name")} {
		found := flag.FindAllString(hint, -1)
		if len(found) == 0 {
			t.Fatalf("no flags in %q — the hint changed shape", hint)
		}
		for _, f := range found {
			if !strings.Contains(useraddUsage, f+" ") && !strings.Contains(useraddUsage, f+"\n") {
				t.Errorf("the start summary tells people to run %q, but useradd's help documents no %s — following it gets \"Unknown flag\"", hint, f)
			}
		}
	}
}
