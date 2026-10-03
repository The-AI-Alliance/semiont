package launcher

// custodystore.go — where the launcher keeps the values it mints (custody.go).

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// custodyStore: one KB root's custody values, by custody name. Every read,
// write and location of a custody value goes through it
// (TestCustodyValuesGoThroughTheStore), and every operation is shown on the
// terminal before it runs: the operation and the secret's name, never its
// value (SECRETS-STORE, ruled 2026-09-29). The lines are printed here, not by
// the callers or the backends, so no caller can skip one and no backend can
// differ.
type custodyStore struct{ b custodyBackend }

// custodyBackend: where one root's values are kept.
type custodyBackend interface {
	// where: where one value is kept, for messages that tell a person where
	// to find it.
	where(name string) string
	// describe: the store as a whole.
	describe() string
	// get: the kept value, or "" when none is kept. False when the store
	// could not answer, reported: an unanswered read is never "nothing kept",
	// which would mint a replacement over a value that exists.
	get(u *UI, name string) (string, bool)
	put(u *UI, name, value string) bool
	remove(u *UI, name string) bool
	// names: the custody names the store holds.
	names(u *UI) ([]string, bool)
}

// openCustody: the stores this process has opened, by state key, so a start
// reads a root's 1Password item once however many values it needs.
var openCustody = map[string]custodyStore{}

// custodyFor: root's store — the one configured for it (`semiont settings
// secret-store`), else the filesystem. False, reported, when the configured store
// cannot be reached or there is nowhere to keep anything: never another store
// in its place, which would mint new values over the ones kept there.
func custodyFor(u *UI, root string) (custodyStore, bool) {
	return custodyForKey(u, rootKey(root))
}

// custodyForKey: custodyFor by state key. This is the lookup of a caller
// that keeps values, so a new knowledge base adopts the machine's default
// store here, at its first need (adoptDefaultStore).
func custodyForKey(u *UI, key string) (custodyStore, bool) {
	if s, ok := openCustody[key]; ok {
		return s, true
	}
	ref, configured, err := storeSettingFor(key)
	if err != nil {
		u.Fail("%v", err)
		return custodyStore{}, false
	}
	if !configured {
		var ok bool
		if ref, configured, ok = adoptDefaultStore(u, key); !ok {
			return custodyStore{}, false
		}
	}
	s, ok := custodyStoreAt(u, key, ref, configured)
	if ok {
		openCustody[key] = s
	}
	return s, ok
}

// configuredCustody: the store a root's setting names today, adopting
// nothing — for a caller that clears or moves values (clean, the
// secret-store setter), which is no knowledge base's first need.
func configuredCustody(u *UI, key string) (custodyStore, bool) {
	ref, configured, err := storeSettingFor(key)
	if err != nil {
		u.Fail("%v", err)
		return custodyStore{}, false
	}
	return custodyStoreAt(u, key, ref, configured)
}

// adoptDefaultStore: the machine's default store, for a root with no setting
// that keeps nothing in files — a new knowledge base (LAUNCHER-SETTINGS D4:
// new KBs only). It is recorded as the root's own setting, so a later change
// to the default moves nothing. A root that keeps files stays on them.
func adoptDefaultStore(u *UI, key string) (secretRef, bool, bool) {
	def, set, err := defaultStoreSetting()
	if err != nil {
		u.Fail("%v", err)
		return secretRef{}, false, false
	}
	if !set {
		return secretRef{}, false, true
	}
	files, ok := custodyStoreAt(u, key, secretRef{}, false)
	if !ok {
		return secretRef{}, false, false
	}
	kept, ok := files.names(u)
	if !ok {
		return secretRef{}, false, false
	}
	if len(kept) > 0 {
		return secretRef{}, false, true
	}
	showCustodyOp(u, "adopt the default for new knowledge bases", custodyStoreNamed(key, def, true).describe())
	if err := saveStoreSetting(key, def, true); err != nil {
		u.Fail("Recording the store: %v", err)
		return secretRef{}, false, false
	}
	return def, true, true
}

// custodyStoreAt: the store a setting names for one root, reachable.
// configured false is the filesystem default.
func custodyStoreAt(u *UI, key string, ref secretRef, configured bool) (custodyStore, bool) {
	if !configured {
		d := dataDir()
		if d == "" {
			u.Fail("No home directory resolvable, so there is nowhere to keep the launcher's secrets.")
			return custodyStore{}, false
		}
		return custodyStore{fileBackend{filepath.Join(d, "roots", key)}}, true
	}
	s := custodyStoreNamed(key, ref, configured)
	if p := secretProviders[ref.Provider]; !onPath(p.bin) {
		u.Fail("This knowledge base keeps its secrets in %s, and '%s' is not on PATH.", s.b.describe(), p.bin)
		fmt.Fprintf(os.Stderr, "  Install the %s CLI. The launcher never falls back to another store.\n", p.display)
		return custodyStore{}, false
	}
	return s, true
}

// custodyStoreNamed: the store a setting names, without reaching it — what
// status describes, since status never reaches for secrets.
func custodyStoreNamed(key string, ref secretRef, configured bool) custodyStore {
	if !configured {
		return custodyStore{fileBackend{filepath.Join(dataDir(), "roots", key)}}
	}
	return custodyStore{&opBackend{vault: ref.Path, title: opItemTitle(key)}}
}

func (s custodyStore) describe() string { return s.b.describe() }

func (s custodyStore) where(name string) string { return s.b.where(name) }

func (s custodyStore) get(u *UI, name string) (string, bool) {
	showCustodyOp(u, "read "+name, s.b.where(name))
	return s.b.get(u, name)
}

func (s custodyStore) put(u *UI, name, value string) bool {
	showCustodyOp(u, "write "+name, s.b.where(name))
	return s.b.put(u, name, value)
}

func (s custodyStore) remove(u *UI, name string) bool {
	showCustodyOp(u, "delete "+name, s.b.where(name))
	return s.b.remove(u, name)
}

func (s custodyStore) names(u *UI) ([]string, bool) {
	showCustodyOp(u, "list", s.b.describe())
	return s.b.names(u)
}

// showCustodyOp prints one store operation to stderr, --quiet or not: the
// rule is that every operation is shown, and stderr keeps the line out of
// what a verb prints for a pipe.
func showCustodyOp(u *UI, op, where string) {
	fmt.Fprintf(os.Stderr, "%s secrets: %s %s\n", u.Wrap(AnsiCyan, "▸"), op, u.Dim("("+where+")"))
}

// fileBackend: one 0600 file per value under the root's state dir. The
// default store, and the only one for a root that configures none. It is not
// secure (fileStoreCaveat), and says so wherever it is named.
type fileBackend struct{ dir string }

// fileStoreCaveat: said wherever the file store is named. Its values are plain
// text: mode 0600 keeps other accounts out, but anything running as this user
// can read them, and every backup of the home directory copies them.
const fileStoreCaveat = "plain files, not secure: for development only"

func (f fileBackend) where(name string) string { return filepath.Join(f.dir, name) }

func (f fileBackend) describe() string {
	return "the files under " + f.dir + " — " + fileStoreCaveat
}

func (f fileBackend) get(u *UI, name string) (string, bool) {
	b, err := os.ReadFile(f.where(name))
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", true
	case err != nil:
		u.Fail("Reading %s: %v", f.where(name), err)
		return "", false
	}
	return strings.TrimSpace(string(b)), true
}

// put writes one value to its own 0600 file, atomically. Not best-effort,
// unlike saveRootMeta: a value we failed to keep would be a DIFFERENT value
// next start, and the resulting failures are far harder to diagnose than this
// error.
func (f fileBackend) put(u *UI, name, value string) bool {
	p := f.where(name)
	if err := os.MkdirAll(f.dir, 0o755); err != nil {
		u.Fail("Creating %s: %v", f.dir, err)
		return false
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(value+"\n"), 0o600); err != nil {
		u.Fail("Writing %s: %v", p, err)
		return false
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		u.Fail("Writing %s: %v", p, err)
		return false
	}
	if err := ownerOnlyFile(p); err != nil {
		u.Fail("Keeping %s to its owner: %v", p, err)
		return false
	}
	return true
}

func (f fileBackend) remove(u *UI, name string) bool {
	if err := os.Remove(f.where(name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		u.Fail("Removing %s: %v", f.where(name), err)
		return false
	}
	return true
}

func (f fileBackend) names(u *UI) ([]string, bool) {
	var out []string
	for _, name := range custodyNames() {
		_, err := os.Stat(f.where(name))
		switch {
		case err == nil:
			out = append(out, name)
		case !errors.Is(err, fs.ErrNotExist):
			u.Fail("Reading %s: %v", f.where(name), err)
			return nil, false
		}
	}
	return out, true
}
