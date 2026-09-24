package verbs

// boundary_test.go — the census gate on this package's reach into the
// launcher (LAUNCHER-PACKAGE-BOUNDARIES P1).
//
// The compiler already enforces the direction that matters most: `launcher`
// imports nothing from here, so the launch flow can never come to depend on a
// verb. The reverse direction it cannot enforce — `verbs` imports `launcher`,
// so every exported launcher symbol is reachable from here whether it should
// be or not.
//
// That is what this pins. The list below is the AGREED surface; a new entry
// means a verb reached for something new, which is a decision worth making on
// purpose rather than discovering later. Adding one is fine — say so here.
//
// One entry is a known wart rather than an agreement: `Start`. `browse
// --launch` starts the Browser by re-entering the start command, and it is the
// only call from a verb into the launch flow. Removing it is what would let
// this package depend on a kernel alone; until then it is written down.

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var allowedLauncherSurface = map[string]bool{
	// Output.
	"UI": true, "NewUI": true, "AnsiGreen": true, "AnsiYellow": true,
	// Session and credentials.
	"Session": true, "SessionRejected": true, "LoadSession": true, "RejectedFail": true,
	"VerbSession": true, "VerbTarget": true, "Bearer": true,
	"SaveToken": true, "LoadTokens": true, "TokenEntry": true, "CliClientID": true,
	// Recorded state, and which stack a verb talks to.
	"StackSet": true, "StackState": true, "ServiceState": true, "StateDir": true,
	"LoadStackSet": true, "SelectVerbStack": true, "SelectRuntime": true,
	"CwdKBRoot": true, "GatewayBase": true,
	// The Browser a verb hands off to.
	"BrowserProbe": true, "BrowserTarget": true,
	// The transport seam the tests drive.
	"UseTransport": true,
	// The wart: `browse --launch`. See the note above.
	"Start": true,
}

func TestVerbsReachOnlyTheAgreedLauncherSurface(t *testing.T) {
	ref := regexp.MustCompile(`launcher\.([A-Z][A-Za-z0-9_]*)`)
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		src, err := os.ReadFile(filepath.Clean(e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range ref.FindAllStringSubmatch(string(src), -1) {
			seen[m[1]] = true
		}
	}
	if len(seen) == 0 {
		t.Fatal("no launcher references found at all — this gate would pass for the wrong reason")
	}
	var added []string
	for s := range seen {
		if !allowedLauncherSurface[s] {
			added = append(added, s)
		}
	}
	sort.Strings(added)
	if len(added) > 0 {
		t.Errorf("verbs reached %d new launcher symbol(s): %s\n"+
			"Each one widens what a verb may touch. Add it to allowedLauncherSurface "+
			"if that is the intent, or keep the verb inside its own package.",
			len(added), strings.Join(added, ", "))
	}
}
