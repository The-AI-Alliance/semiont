package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// LAUNCHER-SERVICE-MODEL P5. Two mechanisms shared the word "secret".
//
//   - CUSTODY: a value the launcher GENERATES ONCE per root and KEEPS.
//     It must outlive the stack, because regenerating it invalidates every
//     token already issued.
//   - RESOLUTION: a value the launcher never has. The config declares a
//     POINTER; a provider answers it at start; the value lives in memory for
//     one process and is written nowhere.
//
// The tests below assert that difference rather than describing it: the
// custody value survives a restart, the resolution value is re-read, and the
// resolution value reaches no disk at all.

func custodyRoot(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("JWT_SECRET", "")
	root := filepath.Join(home, "kb")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

// A custody value survives a restart: the second process gets the FIRST
// one's value, because a fresh one would silently invalidate every token
// already signed with it.
func TestCustodySurvivesARestart(t *testing.T) {
	root := custodyRoot(t)
	u := NewUI(false)

	first, ok := loadOrCreateJWTSecret(u, root)
	if !ok || first == "" {
		t.Fatalf("no key minted: %q ok=%v", first, ok)
	}
	// A second process, same root: the store is the file, so this is the
	// restart.
	second, ok := loadOrCreateJWTSecret(u, root)
	if !ok || second != first {
		t.Errorf("a restart minted a different token-signing key (%q → %q) — every token already issued would fail to verify", first, second)
	}

	// The same property, per service account and for the realm's admin.
	a1, _ := loadOrCreateServiceClientSecret(u, root, "weaver")
	a2, _ := loadOrCreateServiceClientSecret(u, root, "weaver")
	if a1 == "" || a1 != a2 {
		t.Errorf("weaver's account credential changed across a restart (%q → %q) — the realm honours the first", a1, a2)
	}
	if b1, _ := loadOrCreateServiceClientSecret(u, root, "smelter"); b1 == a1 {
		t.Error("two services share one credential; separate accounts are the point of minting them separately")
	}
	p1, _ := loadOrCreateKeycloakAdminPassword(u, root)
	p2, _ := loadOrCreateKeycloakAdminPassword(u, root)
	if p1 == "" || p1 != p2 {
		t.Errorf("the bootstrap admin password changed across a restart (%q → %q) — the realm already exists and would refuse the new one", p1, p2)
	}
}

// A custody value is KEPT, and kept where only its owner can read it: its
// own file under this root's state dir, mode 0600. Never in roots.json,
// which holds pointers.
func TestCustodyIsKeptPerRootAndPrivate(t *testing.T) {
	root := custodyRoot(t)
	u := NewUI(false)
	secret, _ := loadOrCreateJWTSecret(u, root)

	p := jwtSecretPath(root)
	if p == "" {
		t.Fatal("no custody path for this root")
	}
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatalf("the key was not kept: %v", err)
	}
	if mode := fi.Mode().Perm(); mode != 0o600 {
		t.Errorf("%s is mode %04o — a signing key is readable only by its owner", p, mode)
	}
	if got := strings.TrimSpace(readPersistedSecret(p)); got != secret {
		t.Errorf("the kept value is not the one handed out: %q vs %q", got, secret)
	}
	if b, err := os.ReadFile(rootsPath()); err == nil && strings.Contains(string(b), secret) {
		t.Errorf("a custody VALUE reached %s, which holds pointers only", rootsPath())
	}
}

// A resolution value is RE-READ. The launcher holds nothing between two
// resolutions, so a value that changed at the provider is the value the next
// start uses.
func TestResolutionIsReReadEveryTime(t *testing.T) {
	dir := t.TempDir()
	vault := filepath.Join(dir, "value")
	// A provider whose "CLI" is `cat`: the argv is built by the launcher from
	// the stored path, exactly as a real provider's is.
	secretProviders["testvault"] = secretProvider{
		display: "Test vault", bin: "cat", pathHint: "<file>",
		argv: func(p string) []string { return []string{p} },
	}
	t.Cleanup(func() { delete(secretProviders, "testvault") })
	ref := secretRef{Provider: "testvault", Path: vault}

	if err := os.WriteFile(vault, []byte("first-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := resolveSecret(ref)
	if err != nil || got != "first-value" {
		t.Fatalf("resolve = %q, %v", got, err)
	}
	// Rotated at the provider, with no launcher involvement.
	if err := os.WriteFile(vault, []byte("second-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = resolveSecret(ref)
	if err != nil || got != "second-value" {
		t.Fatalf("resolve after rotation = %q, %v — a resolution that returns a stale value is holding one, and it must hold none", got, err)
	}
}

// The prose contract this file exists to make mechanical: "the launcher
// NEVER persists a secret value, anywhere, ever." A resolved value must
// reach no file the launcher owns — not the root's state dir, not the
// machine registry.
func TestResolutionValueReachesNoDisk(t *testing.T) {
	root := custodyRoot(t)
	dir := t.TempDir()
	vault := filepath.Join(dir, "value")
	const sentinel = "resolution-sentinel-2f7c1b"
	if err := os.WriteFile(vault, []byte(sentinel+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	secretProviders["testvault"] = secretProvider{
		display: "Test vault", bin: "cat", pathHint: "<file>",
		argv: func(p string) []string { return []string{p} },
	}
	t.Cleanup(func() { delete(secretProviders, "testvault") })

	if got, err := resolveSecret(secretRef{Provider: "testvault", Path: vault}); err != nil || got != sentinel {
		t.Fatalf("resolve = %q, %v", got, err)
	}
	// Mint the custody values too, so the state dir exists and is populated:
	// the point is that the RESOLVED value is not among what got written.
	u := NewUI(false)
	loadOrCreateJWTSecret(u, root)
	loadOrCreateServiceClientSecret(u, root, "weaver")

	for _, base := range []string{stateRootDir(root), filepath.Dir(rootsPath())} {
		if base == "" {
			continue
		}
		_ = filepath.Walk(base, func(p string, fi os.FileInfo, err error) error {
			if err != nil || fi.IsDir() {
				return nil
			}
			b, rerr := os.ReadFile(p)
			if rerr == nil && strings.Contains(string(b), sentinel) {
				t.Errorf("a RESOLVED value was written to %s — the launcher stores pointers, never values", p)
			}
			return nil
		})
	}
}

// Where the two mechanisms TOUCH, and the defect that lives there.
//
// A resolved value reaches the CONTAINER's environment, appended from the
// config's ${VAR} references. Custody's own values are appended AFTER it, so
// for a name custody owns, the resolved value is silently discarded — after
// the provider's authorization prompt has already been answered. A privileged
// prompt followed by a silent no-op is the one outcome the launcher refuses
// everywhere else (see stop's --runtime mismatch).
func TestCustodyOwnedNamesCannotBeResolved(t *testing.T) {
	for _, name := range []string{"JWT_SECRET", "KC_BOOTSTRAP_ADMIN_PASSWORD", "SEMIONT_OIDC_CLIENT_SECRET", "SEMIONT_OIDC_CLIENT_SECRET_WEAVER"} {
		if !custodyOwned(name) {
			t.Errorf("%s is minted and kept by the launcher, but nothing stops a config sourcing it from a provider — the resolved value would be overridden without a word", name)
		}
	}
	// Everything else is the config's to source.
	for _, name := range []string{"ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "SEMIONT_OIDC_CLIENT_ID"} {
		if custodyOwned(name) {
			t.Errorf("%s is the config's to source, but custody claims it", name)
		}
	}
}

func TestSecretSetRefusesACustodyOwnedName(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	if code := secretSet(NewUI(false), "JWT_SECRET", "op://vault/item/field"); code == 0 {
		t.Error("registering a provider for JWT_SECRET was accepted; the launcher mints that value itself and would discard whatever the provider returned")
	}
	if b, err := os.ReadFile(rootsPath()); err == nil && strings.Contains(string(b), "JWT_SECRET") {
		t.Error("a refused registration was written to the registry anyway")
	}
}
