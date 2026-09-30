package launcher

// custodystore.go — where the launcher keeps the values it mints (custody.go).

import (
	"os"
	"path/filepath"
	"strings"
)

// custodyStore: one KB root's custody values, by custody name. The filesystem
// is its only backend: one 0600 file per value under the root's state dir.
// Every read, write and location of a custody value goes through it
// (TestCustodyValuesGoThroughTheStore), so a second backend (SECRETS-STORE P2)
// changes this file and none of its callers.
type custodyStore struct{ dir string }

// custodyFor: root's store, and false when no home directory resolves, so
// there is nowhere to keep anything.
func custodyFor(root string) (custodyStore, bool) {
	dir := stateRootDir(root)
	return custodyStore{dir}, dir != ""
}

// where: the location of one value, for messages that tell a person where it
// is kept.
func (s custodyStore) where(name string) string { return filepath.Join(s.dir, name) }

// get: the kept value, or "" when none is kept.
func (s custodyStore) get(name string) string { return readPersistedSecret(s.where(name)) }

// put keeps a value, failing loudly when it cannot.
func (s custodyStore) put(u *UI, name, value string) bool {
	return persistSecret(u, s.where(name), value)
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
