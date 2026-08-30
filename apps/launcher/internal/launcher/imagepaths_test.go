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
// declaredEnv parses one Dockerfile's ENV lines. Reading them from a Go test
// crosses a module boundary deliberately: the coupling is real and spans both
// sides, so a check that does not span it would only assert one side against a
// copy of itself.
func declaredEnv(t *testing.T, parts ...string) map[string]string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(parts...))
	if err != nil {
		t.Fatalf("reading %s: %v", filepath.Join(parts...), err)
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
		t.Fatalf("parsed no ENV lines out of %s — the parser, not the paths, is what broke", filepath.Join(parts...))
	}
	return declared
}

func TestContainerPathsMatchTheImage(t *testing.T) {
	// Each row: an image, the ENV it uses to find something, and the container
	// path the launcher mounts onto for it. The row belongs to whichever image
	// MOUNTS the store — anchored-text moved from the backend to the Smelter
	// with the mount and the stamp (ANCHORED-TEXT-TO-SMELTER P4/P5), and the
	// Smelter was declaring no such ENV while `smelter-main` refused to boot
	// without it. Add a row whenever a mount gains an ENV; move one whenever a
	// mount moves.
	for _, c := range []struct {
		label  string
		file   []string
		env    string
		mounts string
	}{
		{"backend", []string{"..", "..", "..", "backend", "Dockerfile"}, "SEMIONT_ROOT", kbMountTarget},
		{"smelter", []string{"..", "..", "..", "..", "packages", "make-meaning", "Dockerfile.smelter"},
			"SEMIONT_ANCHORED_TEXT_DIR", stateStores["anchored-text"].mounts[0].target},
	} {
		declared := declaredEnv(t, c.file...)
		got, ok := declared[c.env]
		if !ok {
			t.Errorf("the %s image declares no %s, but the launcher mounts onto %s expecting it", c.label, c.env, c.mounts)
			continue
		}
		if got != c.mounts {
			t.Errorf("%s/%s: the image says %q, the launcher mounts onto %q — the service would read an empty directory and never report it",
				c.label, c.env, got, c.mounts)
		}
	}
}
