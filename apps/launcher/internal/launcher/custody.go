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
// mints nothing here — the codespace's own launcher mints its credentials,
// on its own filesystem. An `aws` platform would put these in
// Secrets Manager; there is no second provider to write until there is a
// second platform that needs one.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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
	return daemonCredentialVar(name) || strings.HasPrefix(name, "SEMIONT_OIDC_CLIENT_SECRET_")
}

// daemonPasswords: the daemons the launcher runs and keeps a password for
// (SECRET-DELIVERY P4, D1 RULED: "B for daemons the launcher runs"). Each is
// generated once per root and kept, because a data directory keeps the
// password it was initialized with. The variable names are the launcher's,
// machine-wide (ruled 2026-09-29: "names are fine") — `semiont settings secret`
// registrations are machine-wide while a daemon's presence is per-KB config,
// so no config may borrow one. The custody names are also the files under
// roots/<key>/ where KB skills that connect to a daemon directly are told to
// read its password (FLEET-P4-DAEMON-PASSWORDS): keep them stable.
var daemonPasswords = map[string]struct {
	env, custody, display string
	// kept: the daemon writes the password into its store at initialization,
	// so a store with data and no kept password predates custody.
	kept bool
}{
	"graph":     {"NEO4J_PASSWORD", "neo4j-password", "Neo4j", true},
	"database":  {"POSTGRES_PASSWORD", "postgres-password", "PostgreSQL", true},
	"messaging": {"NATS_PASSWORD", "nats-password", "the broker", false},
}

// brokerUser: the user of the broker the launcher runs. Not a secret; the
// pair travels together all the same.
const brokerUser = "semiont"

// daemonCredentialVar: one of the launcher's daemon-credential names.
func daemonCredentialVar(name string) bool {
	if name == "NATS_USER" {
		return true
	}
	for _, d := range daemonPasswords {
		if d.env == name {
			return true
		}
	}
	return false
}

// loadOrCreateDaemonPassword: the kept password of a daemon the launcher runs
// for this root, generated and persisted on first use. A store that already
// holds data with no kept password was initialized with one the launcher does
// not have — the old literal from a config, or custody lost with the store
// kept — and a daemon started over it rejects every login, so that refuses,
// naming the clean. It never wipes a store itself.
func loadOrCreateDaemonPassword(u *UI, root, role string) (string, bool) {
	d := daemonPasswords[role]
	store, ok := custodyFor(u, root)
	if !ok {
		return "", false
	}
	if s, ok := store.get(u, d.custody); !ok || s != "" {
		return s, ok
	}
	if spec, ok := stateStores[role]; ok && d.kept && storeHoldsData(spec.storeDir(root)) {
		u.Fail("%s's store at %s holds data, but the launcher keeps no password for it.", d.display, spec.storeDir(root))
		fmt.Fprintln(os.Stderr, "  It was initialized with a password the launcher does not have (a config's literal, or one whose file was lost),")
		fmt.Fprintln(os.Stderr, "  and the daemon would reject every login. Clear it — the launcher then generates and keeps a new one:")
		fmt.Fprintf(os.Stderr, "    semiont clean --store %s\n", role)
		return "", false
	}
	secret, ok := generateHexSecret(u, 16, d.display+"'s password")
	if !ok || !store.put(u, d.custody, secret) {
		return "", false
	}
	u.Log("%s password: %s", d.display, u.Dim("generated and kept"))
	return secret, true
}

// storeHoldsData: anything but empty directories under dir. What the daemon
// wrote may be owned by its own uid and unreadable here; that counts as data.
func storeHoldsData(dir string) bool {
	found := false
	_ = filepath.WalkDir(dir, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			if p != dir {
				found = true
			}
			return filepath.SkipDir
		}
		if !e.IsDir() {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// custodyNames: every value the launcher keeps for a root, sorted — what a
// store lists, moves and clears.
func custodyNames() []string {
	names := []string{custodyJWTSecret, custodyKeycloakAdmin}
	for _, svc := range serviceClients {
		names = append(names, serviceClientCustody(svc))
	}
	for _, d := range daemonPasswords {
		names = append(names, d.custody)
	}
	sort.Strings(names)
	return names
}

// The custody names of the gateway's token-signing key and Keycloak's
// bootstrap admin password. VALUES, so deliberately not in roots.json
// (pointers only) and not in meta.json (0644) — the same posture as
// tokens.json.
const (
	custodyJWTSecret     = "jwt-secret"
	custodyKeycloakAdmin = "keycloak-admin-password"
)

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
				fmt.Fprintln(os.Stderr, "  Generate one:  "+randomHexHint(systemName(), 32))
				fmt.Fprintln(os.Stderr, "  Rotate with:   "+setVarHint(systemName(), "JWT_SECRET", inlineRandomHex(systemName(), 32)+",$OLD"))
				return "", false
			}
		}
		u.Log("Token-signing key: %s", u.Dim(jwtProvenance("from JWT_SECRET in the environment", len(keys))))
		return s, true
	}

	exportHint := func() {
		fmt.Fprintln(os.Stderr, "  Or export one yourself:  "+setVarHint(systemName(), "JWT_SECRET", inlineRandomHex(systemName(), 32)))
	}
	store, ok := custodyFor(u, root)
	if !ok {
		exportHint()
		return "", false
	}
	s, ok := store.get(u, custodyJWTSecret)
	if !ok {
		exportHint()
		return "", false
	}
	if s != "" {
		u.Log("Token-signing key: %s", u.Dim(jwtProvenance("reused", len(strings.Split(s, ",")))))
		return s, true
	}

	// 32 bytes → 64 hex chars, comfortably over the gateway's 32 minimum.
	secret, ok := generateHexSecret(u, 32, "the gateway's JWT secret")
	if !ok || !store.put(u, custodyJWTSecret, secret) {
		return "", false
	}
	// Say so loudly. A silently regenerated key invalidates every token already
	// issued, and the incident that produced this whole plan looked exactly
	// like an ordinary start — jobs wedged in Yielding, no line anywhere saying
	// the key had changed underneath them.
	u.Log("Token-signing key: %s", u.Dim(jwtProvenance("generated and kept", 1)))
	return secret, true
}

// keycloakAdminPassword resolves the bootstrap admin password WITHOUT creating
// one — $KC_BOOTSTRAP_ADMIN_PASSWORD, else the persisted per-root value, else
// "" — and names where it came from, for the caller that logs it. False when
// the store could not answer (reported), which is not "none kept".
//
// The read-only half exists for `semiont useradd`, which administers the realm
// Keycloak already created: generating a password there would hand the gateway
// a credential the realm has never seen, and the admin API would refuse it with
// nothing to explain why.
func keycloakAdminPassword(u *UI, root string) (secret, source string, ok bool) {
	if s := os.Getenv("KC_BOOTSTRAP_ADMIN_PASSWORD"); s != "" {
		return s, "from KC_BOOTSTRAP_ADMIN_PASSWORD in the environment", true
	}
	store, ok := custodyFor(u, root)
	if !ok {
		return "", "", false
	}
	s, ok := store.get(u, custodyKeycloakAdmin)
	if !ok || s == "" {
		return "", "", ok
	}
	return s, "reused", true
}

// serviceClientCustody: the custody name of a sidecar's service-account
// secret. One per client, so rotating one sidecar's credential is a single
// deletion rather than a stack-wide reset — which is the whole point of giving
// them separate accounts instead of one shared string.
func serviceClientCustody(svc string) string { return "oidc-client-secret-" + svc }

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
	store, ok := custodyFor(u, root)
	if !ok {
		return "", false
	}
	name := serviceClientCustody(svc)
	if s, ok := store.get(u, name); !ok || s != "" {
		return s, ok
	}
	secret, ok := generateHexSecret(u, 16, "the "+svc+" service-account secret")
	if !ok || !store.put(u, name, secret) {
		return "", false
	}
	u.Log("%s service account: %s", svc, u.Dim("generated and kept"))
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
	s, source, ok := keycloakAdminPassword(u, root)
	if !ok {
		// The store did not answer; the environment is the other way in.
		fmt.Fprintln(os.Stderr, "  Or export one yourself:  "+setVarHint(systemName(), "KC_BOOTSTRAP_ADMIN_PASSWORD", inlineRandomHex(systemName(), 16)))
		return "", false
	}
	if s != "" {
		u.Log("Keycloak admin password: %s", u.Dim(source+" (console user: "+keycloakAdminUser+")"))
		return s, true
	}
	store, ok := custodyFor(u, root)
	if !ok {
		return "", false
	}
	secret, ok := generateHexSecret(u, 16, "Keycloak's admin password")
	if !ok || !store.put(u, custodyKeycloakAdmin, secret) {
		return "", false
	}
	u.Log("Keycloak admin password: %s", u.Dim("generated and kept (console user: "+keycloakAdminUser+")"))
	return secret, true
}

func generateHexSecret(u *UI, bytes int, what string) (string, bool) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		u.Fail("Generating %s: %v", what, err)
		return "", false
	}
	return hex.EncodeToString(b), true
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
