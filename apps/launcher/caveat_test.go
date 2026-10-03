package main_test

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// brewCaveat: the caveat .goreleaser.yaml gives the Homebrew formula, which
// brew prints after install and on `brew info semiont`.
func brewCaveat(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(".goreleaser.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	in := false
	for _, line := range strings.Split(string(b), "\n") {
		switch {
		case strings.TrimSpace(line) == "caveats: |":
			in = true
		case in && line != "" && !strings.HasPrefix(line, "      "):
			in = false
		case in:
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

// The caveat points a new install at settings (LAUNCHER-SETTINGS D5), and
// every command it names is one the launcher has: a census of real verbs and
// settings, so a renamed or deleted one fails here rather than in a person's
// terminal.
func TestBrewCaveatNamesOnlyRealCommands(t *testing.T) {
	caveat := brewCaveat(t)
	if !strings.Contains(caveat, "semiont settings") {
		t.Fatalf("the caveat does not point at semiont settings:\n%s", caveat)
	}
	// A home of its own: the launcher logs every invocation under its home,
	// and the real one is not this test's to write in.
	home := os.Environ()
	for name, value := range harness.HomeEnv(t.TempDir()) {
		home = append(home, name+"="+value)
	}
	run := func(args ...string) string {
		cmd := exec.Command(launcherBin, args...)
		cmd.Env = home
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("semiont %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	help := run("--help")
	settingsHelp := run("settings", "--help")
	for _, m := range regexp.MustCompile(`semiont ([a-z-]+)((?: [a-z-]+| --[a-z]+)*)`).FindAllStringSubmatch(caveat, -1) {
		verb := m[1]
		if !regexp.MustCompile(`(?m)^  ` + verb + ` `).MatchString(help) {
			t.Errorf("the caveat names `semiont %s`, which semiont --help does not list", verb)
		}
		if verb != "settings" {
			continue
		}
		for _, word := range strings.Fields(m[2]) {
			if !strings.Contains(settingsHelp, word) {
				t.Errorf("the caveat names `semiont settings ... %s`, which semiont settings --help does not know", word)
			}
		}
	}
}
