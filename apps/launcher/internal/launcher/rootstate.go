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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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

// rootKey names a root's state directory. The KB's did:web domain when
// declared — identity travels with the KB, so a moved clone keeps its state
// — else "path-" + a stable hash of the absolute root path. meta.json keeps
// the unsanitized truth so status and clean can always name the root.
func rootKey(root string) string {
	if ident := loadKBIdentity(root); ident != nil && ident.Domain != "" {
		return keyUnsafe.ReplaceAllString(ident.Domain, "-")
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
