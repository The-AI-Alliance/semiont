package launcher

import (
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// powershellKey: the PowerShell that ends in 32 random bytes as hex.
const powershellKey = `$b = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { '{0:x2}' -f $_ })`

// A hint is a command of the system the launcher runs on: a POSIX shell's on
// macOS and Linux, PowerShell's on Windows.
func TestHintsAreTheSystemsOwnCommands(t *testing.T) {
	for _, c := range []struct{ what, system, got, want string }{
		{"who holds a port", "linux", holdersHint("linux", 4000), "lsof -ti :4000"},
		{"who holds a port", "macos", holdersHint("macos", 4000), "lsof -ti :4000"},
		{"who holds a port", "windows", holdersHint("windows", 4000), "netstat -ano | findstr :4000"},

		{"ending processes", "linux", stopProcessesHint("linux", []string{"12", "34"}), "kill 12 34"},
		{"ending processes", "windows", stopProcessesHint("windows", []string{"12", "34"}), "taskkill /PID 12 /PID 34"},

		{"setting a file aside", "macos",
			setAsideHint("macos", "/Users/a/Library/Application Support/semiont/stack.json", "/Users/a/Library/Application Support/semiont/stack.json.unreadable"),
			`mv "/Users/a/Library/Application Support/semiont/stack.json" "/Users/a/Library/Application Support/semiont/stack.json.unreadable"`},
		{"setting a file aside", "windows",
			setAsideHint("windows", `C:\Users\a b\AppData\Local\semiont\stack.json`, `C:\Users\a b\AppData\Local\semiont\stack.json.unreadable`),
			`move "C:\Users\a b\AppData\Local\semiont\stack.json" "C:\Users\a b\AppData\Local\semiont\stack.json.unreadable"`},

		{"setting a variable", "linux", setVarHint("linux", "ANTHROPIC_API_KEY", "<your-key>"), "export ANTHROPIC_API_KEY=<your-key>"},
		{"setting a variable", "windows", setVarHint("windows", "ANTHROPIC_API_KEY", "<your-key>"), `$env:ANTHROPIC_API_KEY = "<your-key>"`},

		{"making a key", "linux", randomHexHint("linux", 32), "openssl rand -hex 32"},
		{"making a key", "windows", randomHexHint("windows", 32), powershellKey},

		{"setting a variable to a fresh key", "linux",
			setVarHint("linux", "JWT_SECRET", inlineRandomHex("linux", 32)),
			"export JWT_SECRET=$(openssl rand -hex 32)"},
		{"setting a variable to a fresh key", "windows",
			setVarHint("windows", "JWT_SECRET", inlineRandomHex("windows", 32)),
			`$env:JWT_SECRET = "$(` + powershellKey + `)"`},

		{"a fresh key ahead of the old one", "macos",
			setVarHint("macos", "JWT_SECRET", inlineRandomHex("macos", 32)+",$OLD"),
			"export JWT_SECRET=$(openssl rand -hex 32),$OLD"},
		{"a fresh key ahead of the old one", "windows",
			setVarHint("windows", "JWT_SECRET", inlineRandomHex("windows", 32)+",$OLD"),
			`$env:JWT_SECRET = "$(` + powershellKey + `),$OLD"`},
	} {
		if c.got != c.want {
			t.Errorf("%s on %s:\n got  %s\n want %s", c.what, c.system, c.got, c.want)
		}
	}
}

// When the store that keeps a value does not answer, the launcher says how to
// supply the value through the environment, in this system's shell: the
// variable it reads, and a key of the length it generates.
func TestAnUnreachableStoreNamesTheVariableToSet(t *testing.T) {
	harness.Home(t)
	harness.NoRuntimes(t) // and so no `op` either
	t.Setenv("JWT_SECRET", "")
	t.Setenv("KC_BOOTSTRAP_ADMIN_PASSWORD", "")
	root := t.TempDir()
	if err := saveStoreSetting(rootKey(root), secretRef{Provider: "op", Path: "Semiont"}, true); err != nil {
		t.Fatal(err)
	}
	u := NewUI(true)
	system := systemName()
	for _, c := range []struct {
		what string
		ask  func() bool
		want string
	}{
		{"the token-signing key", func() bool { _, ok := loadOrCreateJWTSecret(u, root); return ok },
			"Or export one yourself:  " + setVarHint(system, "JWT_SECRET", inlineRandomHex(system, 32))},
		{"Keycloak's admin password", func() bool { _, ok := loadOrCreateKeycloakAdminPassword(u, root); return ok },
			"Or export one yourself:  " + setVarHint(system, "KC_BOOTSTRAP_ADMIN_PASSWORD", inlineRandomHex(system, 16))},
	} {
		var ok bool
		stderr := captureStderr(t, func() { ok = c.ask() })
		if ok {
			t.Errorf("%s: resolved with its store unreachable", c.what)
		}
		if !strings.Contains(stderr, c.want) {
			t.Errorf("%s: the refusal does not say\n  %s\nit says:\n%s", c.what, c.want, stderr)
		}
	}
}
