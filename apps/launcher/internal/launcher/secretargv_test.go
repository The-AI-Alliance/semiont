package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// No boot the launcher's goldens record puts a secret value on a container's
// command line, where any process on the machine can read it with ps. A value
// rides argv only when onCommandLine allows its name; every other value crosses
// through the runtime's own environment.
func TestGoldensCarryNoSecretValue(t *testing.T) {
	goldens, err := filepath.Glob(filepath.Join("..", "..", "testdata", "golden", "*"))
	if err != nil || len(goldens) == 0 {
		t.Fatalf("no goldens found (%v): a gate that reads nothing passes on silence", err)
	}
	checked := 0
	for _, g := range goldens {
		b, err := os.ReadFile(g)
		if err != nil {
			t.Fatal(err)
		}
		for n, line := range strings.Split(string(b), "\n") {
			if !strings.Contains(line, " run ") {
				continue
			}
			f := strings.Fields(line)
			for i := 0; i+1 < len(f); i++ {
				if f[i] != "--env" && f[i] != "-e" {
					continue
				}
				checked++
				if name, _, ok := strings.Cut(f[i+1], "="); ok && !onCommandLine(name) {
					t.Errorf("%s:%d carries %s's value on the command line", filepath.Base(g), n+1, name)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no --env or -e found in any golden run line: the gate checked nothing")
	}
}
