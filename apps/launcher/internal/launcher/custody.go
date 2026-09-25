package launcher

// custody.go — the secrets the launcher MINTS and KEEPS
// (LAUNCHER-SERVICE-MODEL D8).
//
// Two mechanisms shared the word "secret", and they are opposites:
//
//   - CUSTODY, here. A value the launcher generates once per root and keeps
//     in its own 0600 file. It MUST outlive the stack, because regenerating
//     it invalidates every token already issued — which is how a fresh key
//     per start once surfaced as `Invalid token signature`, with jobs hung in
//     Yielding forever and nothing anywhere saying the key had changed.
//   - RESOLUTION, in resolution.go. A value the launcher never has. The
//     config declares a POINTER; a provider answers it at start; the value
//     lives in memory for one process and is written nowhere.
//
// The platform question (D8): custody's provider is the local filesystem,
// because the launcher only ever mints for a LOCAL stack. A codespace stack
// mints nothing here — compose owns the services inside it, and their
// credentials are the codespace's. An `aws` platform would put these in
// Secrets Manager; there is no second provider to write until there is a
// second platform that needs one.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// custodyOwned: the environment variables whose values are the launcher's to
// MINT and KEEP — so a config may not source one from a secret provider.
//
// The two mechanisms meet in the container's environment: resolved values
// are appended from the config's ${VAR} references, and custody's are
// appended after them. For a name custody owns, the resolved value is
// therefore discarded — silently, and after the provider's authorization
// prompt has already been answered. Refusing the registration is the rule
// stop applies to a mismatched --runtime: a privileged no-op must not look
// like success.
//
// Exporting one of these yourself is a different thing and still works: the
// launcher's own process reads the environment first, which is how a
// JWT_SECRET rotation ring is handed over (JWT-SECRET-ROTATION.md).
func custodyOwned(name string) bool {
	switch name {
	case "JWT_SECRET", "KC_BOOTSTRAP_ADMIN_PASSWORD", "SEMIONT_OIDC_CLIENT_SECRET":
		return true
	}
	return strings.HasPrefix(name, "SEMIONT_OIDC_CLIENT_SECRET_")
}

// jwtSecretPath: <stateRootDir>/jwt-secret. A VALUE, so deliberately not in
// roots.json (pointers only) and not in meta.json (0644) — its own 0600 file,
// the same posture as tokens.json.
func jwtSecretPath(root string) string {
	dir := stateRootDir(root)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "jwt-secret")
}

// loadOrCreateJWTSecret resolves the gateway's token-signing key for one root:
// $JWT_SECRET, else the persisted per-root secret, else a freshly generated one
// that is persisted before use.
//
// Per-ROOT, and PERSISTED — the two properties that matter, both learned the
// hard way. The secret signs tokens for users who live in this root's postgres
// store, so it shares their lifecycle (a full `semiont clean` removes the state
// dir and takes this with it, which is correct: the users went too). And
// persistence is what the retired CLI's generate-on-boot lacked once it ran
// inside a container — a fresh secret per start silently invalidates every
// token already issued, surfacing as `Invalid token signature` and jobs that
// hang in Yielding forever rather than as an error anyone can read.
//
// The retired shared worker secret was the contrast: regenerated per start,
// because every consumer was a container started in that same run and nothing
// outlived it. Tokens DO outlive the stack, which is why this one is persisted —
// and why the per-service issuer credentials are too, since the realm that
// honours them is written once, on first boot.
func loadOrCreateJWTSecret(u *UI, root string) (string, bool) {
	if s := os.Getenv("JWT_SECRET"); s != "" {
		// The gateway reads this as an ordered RING: the first value signs,
		// every value verifies, so `<new>,<old>` keeps outstanding tokens
		// working across a deliberate rotation (JWT-SECRET-ROTATION.md). The
		// launcher only carries it — splitting is the gateway's business, and
		// re-joining a parsed ring here could only introduce a difference.
		//
		// Validate each MEMBER though. The gateway refuses to boot on a short
		// one, and a whole-string length check happily passes "<valid>,short"
		// — so the trap is caught here, where the fix-it can be printed,
		// rather than as a crash-loop inside a container.
		keys := strings.Split(s, ",")
		for i, k := range keys {
			if len(strings.TrimSpace(k)) < 32 {
				u.Fail("JWT_SECRET key %d of %d is %d characters; the gateway requires at least 32 and will refuse to start.",
					i+1, len(keys), len(strings.TrimSpace(k)))
				fmt.Fprintln(os.Stderr, "  JWT_SECRET is an ordered list: the first key signs, every key verifies.")
				fmt.Fprintln(os.Stderr, "  Generate one:  openssl rand -hex 32")
				fmt.Fprintln(os.Stderr, "  Rotate with:   export JWT_SECRET=$(openssl rand -hex 32),$OLD")
				return "", false
			}
		}
		u.Log("Token-signing key: %s", u.Dim(jwtProvenance("from JWT_SECRET in the environment", len(keys))))
		return s, true
	}

	p := jwtSecretPath(root)
	if p == "" {
		u.Fail("No home directory resolvable, so the gateway's JWT secret cannot be persisted.")
		fmt.Fprintln(os.Stderr, "  Export one yourself:  export JWT_SECRET=$(openssl rand -hex 32)")
		return "", false
	}

	if s := readPersistedSecret(p); s != "" {
		u.Log("Token-signing key: %s", u.Dim(jwtProvenance("reused from "+p, len(strings.Split(s, ",")))))
		return s, true
	}

	// 32 bytes → 64 hex chars, comfortably over the gateway's 32 minimum.
	secret, ok := generateHexSecret(u, 32, "the gateway's JWT secret")
	if !ok {
		return "", false
	}
	if !persistSecret(u, p, secret) {
		return "", false
	}
	// Say so loudly. A silently regenerated key invalidates every token already
	// issued, and the incident that produced this whole plan looked exactly
	// like an ordinary start — jobs wedged in Yielding, no line anywhere saying
	// the key had changed underneath them.
	u.Log("Token-signing key: %s", u.Dim(jwtProvenance("generated and persisted at "+p, 1)))
	return secret, true
}

// keycloakAdminPasswordPath: <stateRootDir>/keycloak-admin-password — a VALUE,
// so its own 0600 file beside jwt-secret.
func keycloakAdminPasswordPath(root string) string {
	dir := stateRootDir(root)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "keycloak-admin-password")
}

// keycloakAdminPassword resolves the bootstrap admin password WITHOUT creating
// one — $KC_BOOTSTRAP_ADMIN_PASSWORD, else the persisted per-root value, else
// "" — and names where it came from, for the caller that logs it.
//
// The read-only half exists for `semiont useradd`, which administers the realm
// Keycloak already created: generating a password there would hand the gateway
// a credential the realm has never seen, and the admin API would refuse it with
// nothing to explain why.
func keycloakAdminPassword(root string) (secret, source string) {
	if s := os.Getenv("KC_BOOTSTRAP_ADMIN_PASSWORD"); s != "" {
		return s, "from KC_BOOTSTRAP_ADMIN_PASSWORD in the environment"
	}
	p := keycloakAdminPasswordPath(root)
	if p == "" {
		return "", ""
	}
	if s := readPersistedSecret(p); s != "" {
		return s, "reused from " + p
	}
	return "", ""
}

// serviceClientSecretPath: where a sidecar's service-account secret is kept for
// this root. One file per client, so rotating one sidecar's credential is a
// single deletion rather than a stack-wide reset — which is the whole point of
// giving them separate accounts instead of one shared string.
func serviceClientSecretPath(root, svc string) string {
	dir := stateRootDir(root)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "oidc-client-secret-"+svc)
}

// serviceClientSecretEnv: the environment variable that pins one sidecar's
// credential, e.g. SEMIONT_OIDC_CLIENT_SECRET_WEAVER.
func serviceClientSecretEnv(svc string) string {
	return "SEMIONT_OIDC_CLIENT_SECRET_" + strings.ToUpper(svc)
}

// loadOrCreateServiceClientSecret: the persisted per-root credential for one
// sidecar's Keycloak service account, generating and persisting one on first
// use. The same value reaches two places — the realm document Keycloak imports
// and the container that has to present it — so both read it from here rather
// than passing it between them.
func loadOrCreateServiceClientSecret(u *UI, root, svc string) (string, bool) {
	// An explicit value wins, the same precedence $KC_BOOTSTRAP_ADMIN_PASSWORD
	// has. Per service rather than one for all:
	// separate credentials are the point of this, and an override that collapsed
	// them back to one shared string would quietly undo it.
	if s := os.Getenv(serviceClientSecretEnv(svc)); s != "" {
		return s, true
	}
	p := serviceClientSecretPath(root, svc)
	if p == "" {
		u.Fail("No home directory resolvable, so the %s service-account secret cannot be persisted.", svc)
		return "", false
	}
	if s := readPersistedSecret(p); s != "" {
		return s, true
	}
	secret, ok := generateHexSecret(u, 16, "the "+svc+" service-account secret")
	if !ok {
		return "", false
	}
	if !persistSecret(u, p, secret) {
		return "", false
	}
	u.Log("%s service account: %s", svc, u.Dim("generated and persisted at "+p))
	return secret, true
}

// loadOrCreateKeycloakAdminPassword resolves Keycloak's bootstrap admin
// password for one root: $KC_BOOTSTRAP_ADMIN_PASSWORD, else the persisted
// per-root value, else a freshly generated one persisted before use.
//
// Per-root and persisted for the JWT secret's reason: Keycloak creates the
// admin on its FIRST boot against an empty database and never reads the
// variable again, so the value must outlive the stack with the database that
// holds the admin it created — a regenerated one locks the console out.
func loadOrCreateKeycloakAdminPassword(u *UI, root string) (string, bool) {
	if s, source := keycloakAdminPassword(root); s != "" {
		u.Log("Keycloak admin password: %s", u.Dim(source+" (console user: "+keycloakAdminUser+")"))
		return s, true
	}
	p := keycloakAdminPasswordPath(root)
	if p == "" {
		u.Fail("No home directory resolvable, so Keycloak's admin password cannot be persisted.")
		fmt.Fprintln(os.Stderr, "  Export one yourself:  export KC_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 16)")
		return "", false
	}
	secret, ok := generateHexSecret(u, 16, "Keycloak's admin password")
	if !ok {
		return "", false
	}
	if !persistSecret(u, p, secret) {
		return "", false
	}
	u.Log("Keycloak admin password: %s", u.Dim("generated and persisted at "+p+" (console user: "+keycloakAdminUser+")"))
	return secret, true
}

// readPersistedSecret: the trimmed contents of a per-root secret file, or ""
// when there is none to read.
func readPersistedSecret(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func generateHexSecret(u *UI, bytes int, what string) (string, bool) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		u.Fail("Generating %s: %v", what, err)
		return "", false
	}
	return hex.EncodeToString(b), true
}

// persistSecret writes a per-root secret to its own 0600 file, atomically.
// Not best-effort, unlike saveRootMeta: a secret we failed to persist would be
// a DIFFERENT secret next start, and the resulting failures are far harder to
// diagnose than this error.
func persistSecret(u *UI, p, secret string) bool {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		u.Fail("Creating %s: %v", filepath.Dir(p), err)
		return false
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(secret+"\n"), 0o600); err != nil {
		u.Fail("Writing %s: %v", p, err)
		return false
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		u.Fail("Writing %s: %v", p, err)
		return false
	}
	return true
}

// jwtProvenance renders one provenance line. The VALUE never appears — this
// says where the key came from and, when the operator supplied a rotation
// ring, how many are being honoured. A count is safe; a key is not.
func jwtProvenance(source string, keys int) string {
	if keys > 1 {
		return fmt.Sprintf("%s — %d keys (rotation ring: the first signs, all verify)", source, keys)
	}
	return source
}
