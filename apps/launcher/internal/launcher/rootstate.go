package launcher

// rootstate.go — persistent per-root local-stack state (LAUNCHER-STATE.md).
// Each local semiont root gets its own directory under the launcher's data
// home; infra containers bind-mount their store subdirs from it, so postgres
// rows (which include users the event log does NOT record) survive restarts,
// and the qdrant/neo4j projections skip their rebuild. The mount shapes are
// the ones the Phase 0 spikes measured on Apple container's virtiofs:
// chmod/chown of a mount root is refused and in-mount chown silently no-ops,
// but host-side mode bits pass through and created-inside writes land — so
// postgres points PGDATA at a subdir the entrypoint creates inside the
// mount, and (P2) neo4j's dirs get host-side 0777 to satisfy its `test -w`
// boot gate.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// dataDir is the launcher's data home: the same ~/Library/Application
// Support/semiont bucket the state file uses on macOS (Apple keeps one home
// for both), $XDG_DATA_HOME/semiont (default ~/.local/share/semiont)
// elsewhere — DB contents are XDG data, not XDG state. "" when no home is
// resolvable.
func dataDir() string {
	if runtime.GOOS == "darwin" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return ""
		}
		return filepath.Join(dir, "semiont")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	if s := os.Getenv("XDG_DATA_HOME"); s != "" {
		return filepath.Join(s, "semiont")
	}
	return filepath.Join(home, ".local", "share", "semiont")
}

var keyUnsafe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// rootKey names a root's state directory: the KB's did:web domain, sanitized
// — identity travels with the KB, so a moved clone keeps its state.
//
// The "path-" + hash branch below is NOT a fallback for did-less KBs any
// more: since identity became required (KB-IDENTITY-VS-ADDRESS decision 8)
// `start` refuses a KB that declares no [site] domain, so no new path-keyed
// directory can be created. It survives because directories created BEFORE
// that rule still exist on disk, and `clean` — the only way that data dies —
// must be able to name them. Delete it once no such directory can plausibly
// remain, not before: the alternative is bytes nothing can remove.
//
// meta.json keeps the unsanitized truth so status and clean can always name
// the root.
func rootKey(root string) string {
	return stateKeyFor(loadKBIdentity(root).didWeb(), root)
}

// stateKeyFor derives the key from an already-known identity — the form
// clean and status use against RECORDS (stack.json's kbDid/kbRoot), where
// re-reading .semiont/config would answer for the wrong tree (or none, for
// an orphan).
func stateKeyFor(did, root string) string {
	if d, ok := strings.CutPrefix(did, "did:web:"); ok && d != "" {
		return keyUnsafe.ReplaceAllString(d, "-")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		abs = root
	}
	sum := sha256.Sum256([]byte(abs))
	return "path-" + hex.EncodeToString(sum[:])[:12]
}

// stateRootDir: <dataDir>/roots/<key> for this KB root; "" when homeless.
func stateRootDir(root string) string {
	d := dataDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, "roots", rootKey(root))
}

// stateStoreSpec: how one infra role's container consumes its state subdir.
type stateStoreSpec struct {
	dir    string       // the store's subdir under the root's state dir
	mounts []stateMount // bind mounts within it
	env    []string     // extra env the mount shape requires
	mode   os.FileMode  // non-zero: host-side perms on the mount dirs (virtiofs test -w gate)
	// projection: this store derives from the event log — an image mismatch
	// auto-cleans and rebuilds instead of refusing. False = system of
	// record (database): existing data is never auto-deleted.
	projection bool
}

// stateMount: one -v within a store. sub "" mounts the store dir itself.
type stateMount struct{ sub, target string }

// stateStores: the roles whose containers persist state, with the mount
// shapes the Phase 0 spikes measured (LAUNCHER-STATE.md Decision).
var stateStores = map[string]stateStoreSpec{
	// The entrypoint chmods $PGDATA only — a created-inside subdir — never
	// the mount root (which virtiofs refuses; Phase 0, 7/7).
	"database": {
		dir:    "postgres",
		mounts: []stateMount{{"", "/var/lib/postgresql/data"}},
		env:    []string{"PGDATA=/var/lib/postgresql/data/pgdata"},
	},
	// Qdrant just writes files; a plain mount works (Phase 0, 7/7).
	"vectors": {
		dir:        "qdrant",
		mounts:     []stateMount{{"", "/qdrant/storage"}},
		projection: true,
	},
	// Neo4j's entrypoint gates on `test -w` of /data and /logs and insists
	// on chowning an unwritable mount root — refused on virtiofs, and
	// in-mount chown silently no-ops. Host-side 0777 satisfies the gate so
	// the chown is never attempted (Phase 0, 8/8).
	"graph": {
		dir:        "neo4j",
		mounts:     []stateMount{{"data", "/data"}, {"logs", "/logs"}},
		mode:       0o777,
		projection: true,
	},
	// The backend's own derived state: the anchored-text store, one coordinate
	// map per representation, ~2.9s/page of OCR to rebuild. Unmounted it lives
	// in the container and dies on every stop, and nothing re-derives it —
	// reconcile plans from Qdrant, which persists, so it sees matching
	// checksums and does nothing.
	//
	// The container path is a constant of the backend image, which declares it
	// as SEMIONT_ANCHORED_TEXT_DIR exactly the way it declares SEMIONT_ROOT=/kb.
	// So this side carries no KB identifier and nothing here has to know how
	// the backend composes its own paths — the same arrangement every other
	// store already has (/qdrant/storage, /var/lib/postgresql/data).
	//
	// projection: reproducible from the resource's bytes, so an image change
	// clears rather than refuses — and `clean --store anchored-text` is safe.
	"anchored-text": {
		dir:        "anchored-text",
		mounts:     []stateMount{{"", "/anchored-text"}},
		projection: true,
	},
	// The XDG state tree, SHARED between the gateway and the Archivist
	// (EXTRACT-ARCHIVIST D6): the Archivist rebuilds and maintains the view
	// projections under <state>/semiont/<name>/projections, and the
	// gateway's Gatherer READS them — without one host dir mounted into
	// both, the gateway sees only its own boot-stale, never-rebuilt copies.
	// Everything under it is derived ("recomputation rather than
	// information" — project.ts), so a stamp mismatch clears. The ARCHIVIST
	// owns the stamp: it is the projection writer.
	"state": {
		dir:        "state",
		mounts:     []stateMount{{"", "/semiont-state"}},
		projection: true,
	},
}

// storeDir: the store's directory under a root's state dir.
func (spec stateStoreSpec) storeDir(root string) string {
	dir := stateRootDir(root)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, spec.dir)
}

// stateMountArgs renders the -v/-e run args for a role's persistent state.
// nil for roles without a store, or when no data home resolves — the stack
// still boots, just ephemeral, as before this feature.
func stateMountArgs(role, root string) []string {
	spec, ok := stateStores[role]
	if !ok {
		return nil
	}
	sd := spec.storeDir(root)
	if sd == "" {
		return nil
	}
	var args []string
	for _, m := range spec.mounts {
		args = append(args, "-v", filepath.Join(sd, m.sub)+":"+m.target)
	}
	for _, e := range spec.env {
		args = append(args, "-e", e)
	}
	return args
}

// rootMeta is <stateRootDir>/meta.json: which root this state belongs to
// and which image wrote each store — the stamp the freshness/safety split
// reads (database mismatch refuses; projections auto-clean, P2).
type rootMeta struct {
	KBRoot    string               `json:"kbRoot"`
	Did       string               `json:"did,omitempty"`
	CreatedAt time.Time            `json:"createdAt"`
	Stores    map[string]storeMeta `json:"stores"`
}

type storeMeta struct {
	Image string `json:"image"`
}

// loadRootMeta: the dir's meta.json, or a zero-valued meta (never nil).
func loadRootMeta(dir string) *rootMeta {
	m := &rootMeta{Stores: map[string]storeMeta{}}
	if dir == "" {
		return m
	}
	b, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return m
	}
	var read rootMeta
	if json.Unmarshal(b, &read) != nil {
		return m
	}
	if read.Stores == nil {
		read.Stores = map[string]storeMeta{}
	}
	return &read
}

// saveRootMeta writes the stamp atomically (temp + rename). Best-effort by
// design: the stamp protects FUTURE starts; failing THIS boot over it would
// punish the user for a full disk twice.
func saveRootMeta(dir string, m *rootMeta) {
	if dir == "" {
		return
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now().UTC()
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	tmp := filepath.Join(dir, "meta.json.tmp")
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, filepath.Join(dir, "meta.json"))
}

// storeDirNonEmpty: whether a store subdir already holds anything — the
// difference between first use (mount and go) and existing data (the
// image-mismatch check applies).
func storeDirNonEmpty(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
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

// loadOrCreateJWTSecret resolves the backend's token-signing key for one root:
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
// Contrast the worker secret (fullStartSecret): that one may be regenerated per
// start because every consumer is a container started in the same run, so
// nothing outlives it. Tokens DO outlive the stack. Hence the different rule.
func loadOrCreateJWTSecret(u *ui, root string) (string, bool) {
	if s := os.Getenv("JWT_SECRET"); s != "" {
		// The backend reads this as an ordered RING: the first value signs,
		// every value verifies, so `<new>,<old>` keeps outstanding tokens
		// working across a deliberate rotation (JWT-SECRET-ROTATION.md). The
		// launcher only carries it — splitting is the backend's business, and
		// re-joining a parsed ring here could only introduce a difference.
		//
		// Validate each MEMBER though. The backend refuses to boot on a short
		// one, and a whole-string length check happily passes "<valid>,short"
		// — so the trap is caught here, where the fix-it can be printed,
		// rather than as a crash-loop inside a container.
		keys := strings.Split(s, ",")
		for i, k := range keys {
			if len(strings.TrimSpace(k)) < 32 {
				u.fail("JWT_SECRET key %d of %d is %d characters; the backend requires at least 32 and will refuse to start.",
					i+1, len(keys), len(strings.TrimSpace(k)))
				fmt.Fprintln(os.Stderr, "  JWT_SECRET is an ordered list: the first key signs, every key verifies.")
				fmt.Fprintln(os.Stderr, "  Generate one:  openssl rand -hex 32")
				fmt.Fprintln(os.Stderr, "  Rotate with:   export JWT_SECRET=$(openssl rand -hex 32),$OLD")
				return "", false
			}
		}
		u.log("Token-signing key: %s", u.dim(jwtProvenance("from JWT_SECRET in the environment", len(keys))))
		return s, true
	}

	p := jwtSecretPath(root)
	if p == "" {
		u.fail("No home directory resolvable, so the backend's JWT secret cannot be persisted.")
		fmt.Fprintln(os.Stderr, "  Export one yourself:  export JWT_SECRET=$(openssl rand -hex 32)")
		return "", false
	}

	if b, err := os.ReadFile(p); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			u.log("Token-signing key: %s", u.dim(jwtProvenance("reused from "+p, len(strings.Split(s, ",")))))
			return s, true
		}
	}

	b := make([]byte, 32) // 64 hex chars — comfortably over the backend's 32 minimum
	if _, err := rand.Read(b); err != nil {
		u.fail("Generating the backend's JWT secret: %v", err)
		return "", false
	}
	secret := hex.EncodeToString(b)

	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		u.fail("Creating %s: %v", filepath.Dir(p), err)
		return "", false
	}
	// Not best-effort, unlike saveRootMeta: a secret we failed to persist would
	// be a DIFFERENT secret next start, and the resulting token failures are far
	// harder to diagnose than this error.
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(secret+"\n"), 0o600); err != nil {
		u.fail("Writing %s: %v", p, err)
		return "", false
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		u.fail("Writing %s: %v", p, err)
		return "", false
	}
	// Say so loudly. A silently regenerated key invalidates every token already
	// issued, and the incident that produced this whole plan looked exactly
	// like an ordinary start — jobs wedged in Yielding, no line anywhere saying
	// the key had changed underneath them.
	u.log("Token-signing key: %s", u.dim(jwtProvenance("generated and persisted at "+p, 1)))
	return secret, true
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

// dirSize: total bytes of regular files under path, and whether the path
// exists at all — absent must stay distinguishable from empty ("unknown is
// not missing"). Go-native walk; unreadable entries are skipped, not fatal.
func dirSize(path string) (int64, bool) {
	if _, err := os.Stat(path); err != nil {
		return 0, false
	}
	var total int64
	_ = filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() {
			if info, e := d.Info(); e == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total, true
}

// humanBytes: one rounding for every size the launcher prints.
func humanBytes(n int64) string {
	const k = 1024
	switch {
	case n >= k*k*k:
		return fmt.Sprintf("%.1f GB", float64(n)/(k*k*k))
	case n >= k*k:
		return fmt.Sprintf("%.1f MB", float64(n)/(k*k))
	case n >= k:
		return fmt.Sprintf("%.1f KB", float64(n)/k)
	default:
		return fmt.Sprintf("%d B", n)
	}
}
