package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestContainerPathsMatchTheImage gates a class of drift nothing else catches:
// the launcher mounts a host directory ONTO a container path, and the backend
// image declares that same path in an ENV so the app knows where to look. Two
// literals, in two languages, in two files, and no compiler that can see both.
//
// Drift is silent in the worst way. The mount still succeeds — every runtime
// creates the target if it is absent — so the stack boots clean and the app
// reads an empty directory forever. For the anchored-text store that surfaces
// as "OCR got slow again", months later, with nothing in any log to explain it.
//
// Reading the Dockerfile from a Go test crosses a module boundary deliberately:
// the coupling is real and spans both sides, so a check that does not span it
// would only assert one side against a copy of itself.
func TestContainerPathsMatchTheImage(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "backend", "Dockerfile"))
	if err != nil {
		t.Fatalf("reading the backend Dockerfile: %v", err)
	}
	declared := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), "ENV ")
		if !ok {
			continue
		}
		if name, value, ok := strings.Cut(rest, "="); ok {
			declared[strings.TrimSpace(name)] = strings.Trim(strings.TrimSpace(value), `"`)
		}
	}
	if len(declared) == 0 {
		t.Fatal("parsed no ENV lines out of the backend Dockerfile — the parser, not the paths, is what broke")
	}

	// Each row: the ENV the image uses to tell the backend where something is,
	// and the container path the launcher mounts onto. Add a row whenever a
	// mount gains an ENV.
	for _, c := range []struct{ env, mounts string }{
		{"SEMIONT_ROOT", kbMountTarget},
		{"SEMIONT_ANCHORED_TEXT_DIR", stateStores["anchored-text"].mounts[0].target},
	} {
		got, ok := declared[c.env]
		if !ok {
			t.Errorf("apps/backend/Dockerfile declares no %s, but the launcher mounts onto %s expecting it", c.env, c.mounts)
			continue
		}
		if got != c.mounts {
			t.Errorf("%s: the image says %q, the launcher mounts onto %q — the backend would read an empty directory and never report it",
				c.env, got, c.mounts)
		}
	}
}
