package launcher

// rootstate.go — persistent per-root local-stack state.
// Each local semiont root gets its own directory under the launcher's data
// home; infra containers bind-mount their store subdirs from it, so postgres
// rows (which include users the event log does NOT record) survive restarts,
// and the qdrant/neo4j projections skip their rebuild. The mount shapes are
// the ones spikes measured on Apple container's virtiofs: chmod/chown of a
// mount root is refused and in-mount chown silently no-ops, but host-side
// mode bits pass through and created-inside writes land — so postgres points
// PGDATA at a subdir the entrypoint creates inside the mount, and neo4j's
// dirs get host-side 0777 to satisfy its `test -w` boot gate.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// dataDir is the launcher's data home on this machine (dataDirFor). "" when
// no home is resolvable.
func dataDir() string {
	return dataDirFor(systemName(), userHome(), os.Getenv("XDG_DATA_HOME"), os.Getenv("LOCALAPPDATA"))
}

var keyUnsafe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// rootKey names a root's state directory: the KB's did:web domain, sanitized
// — identity travels with the KB, so a moved clone keeps its state.
//
// The "path-" + hash branch below is NOT a fallback for did-less KBs any
// more: since identity became required `start` refuses a KB that declares no
// [site] domain, so no new path-keyed directory can be created. It survives
// because directories created BEFORE that rule still exist on disk, and
// `clean` — the only way that data dies — must be able to name them. Delete
// it once no such directory can plausibly remain, not before: the
// alternative is bytes nothing can remove.
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
	holds  string       // what it keeps, as status --verbose says it beside the directory
	mounts []stateMount // bind mounts within it
	env    []string     // extra env the mount shape requires
	mode   os.FileMode  // non-zero: host-side perms on the mount dirs (see the rows that set it)
	// projection: this store derives from the event log — an image mismatch
	// auto-cleans and rebuilds instead of refusing. False = system of
	// record (database): existing data is never auto-deleted.
	projection bool
	// owner: the role whose image stamps this store — the writer whose code
	// the contents reflect. Exactly one service takes the stamped mount path
	// per store; sharers mount via stateMountsShared.
	owner string
}

// stateMount: one -v within a store. sub "" mounts the store dir itself.
type stateMount struct{ sub, target string }

// stateStores: the roles whose containers persist state — host bind mounts,
// in the shapes the spikes on Apple container measured.
var stateStores = map[string]stateStoreSpec{
	// The entrypoint chmods $PGDATA only — a created-inside subdir — never
	// the mount root (which virtiofs refuses; measured, 7/7).
	"database": {
		dir:    "postgres",
		holds:  "database",
		mounts: []stateMount{{"", "/var/lib/postgresql/data"}},
		env:    []string{"PGDATA=/var/lib/postgresql/data/pgdata"},
		owner:  "database",
	},
	// Qdrant just writes files; a plain mount works (measured, 7/7).
	"vectors": {
		dir:        "qdrant",
		holds:      "vectors",
		mounts:     []stateMount{{"", "/qdrant/storage"}},
		projection: true,
		owner:      "vectors",
	},
	// Neo4j's entrypoint gates on `test -w` of /data and /logs and insists
	// on chowning an unwritable mount root — refused on virtiofs, and
	// in-mount chown silently no-ops. Host-side 0777 satisfies the gate so
	// the chown is never attempted (measured, 8/8).
	"graph": {
		dir:        "neo4j",
		holds:      "graph",
		mounts:     []stateMount{{"data", "/data"}, {"logs", "/logs"}},
		mode:       0o777,
		projection: true,
		owner:      "graph",
	},
	// The gateway's own derived state: the anchored-text store, one coordinate
	// map per representation, ~2.9s/page of OCR to rebuild. Unmounted it lives
	// in the container and dies on every stop, and nothing re-derives it —
	// reconcile plans from Qdrant, which persists, so it sees matching
	// checksums and does nothing.
	//
	// The container path is a constant of the gateway image, which declares it
	// as SEMIONT_ANCHORED_TEXT_DIR exactly the way it declares SEMIONT_ROOT=/kb.
	// So this side carries no KB identifier and nothing here has to know how
	// the gateway composes its own paths — the same arrangement every other
	// store already has (/qdrant/storage, /var/lib/postgresql/data).
	//
	// projection: reproducible from the resource's bytes, so an image change
	// clears rather than refuses — and `clean --store anchored-text` is safe.
	//
	// mode: the Smelter runs as uid 1001. On a Linux Docker host the invoker
	// is some other uid, so a 0755 dir is unwritable inside (macOS runtimes
	// map ownership and hide it).
	"anchored-text": {
		dir:        "anchored-text",
		holds:      "text positions for each representation",
		mounts:     []stateMount{{"", "/anchored-text"}},
		mode:       0o777,
		projection: true,
		owner:      "smelter",
	},
	// JetStream's data dir (streams + KV buckets, one daemon). projection:
	// true is a DECISION, not an inheritance: queued work is clearable
	// operational state — jobs survive restarts via the mount, a deliberate
	// clear drops re-submittable work, and job state stays out of KB exports.
	// Same classification the jobs dir had on the state store.
	// Renamed jobs → messaging with the role; `dir` was already "nats", so
	// the on-disk tree never moves and nothing is orphaned. The daemon
	// always mounts it: the job queue and the gateway's ledger claims both
	// live in it.
	"messaging": {
		dir:        "nats",
		holds:      "job queue and signals",
		mounts:     []stateMount{{"", "/data"}},
		projection: true,
		owner:      "messaging",
	},
	// The XDG state tree, shared across the Archivist (projection writer —
	// owns the stamp) and the librarian (reads views). The gateway mounts it
	// only for its supervisor's events log.
	//
	// mode: all three run as uid 1001 — the same Linux ownership gap as
	// anchored-text. The Archivist died with EACCES in a codespace (uid 1000).
	"state": {
		dir:        "state",
		holds:      "views and projections",
		mounts:     []stateMount{{"", "/semiont-state"}},
		mode:       0o777,
		projection: true,
		owner:      "archivist",
	},
}

// clearStoreContents empties a store dir without unlinking the dir itself.
// Delete-and-recreate orphans every container share attached to the old
// directory (Apple container virtiofs, measured 2026-09-07: the attached
// container sees an empty mount and ENOENT on writes, forever); clearing
// contents is invisible to attached shares.
//
// A container clears it, as root, because containers wrote it: neo4j as
// 7474, postgres as 70, qdrant and nats as root, Semiont's images as 1001.
// On Linux the invoker is none of those, and a host-side RemoveAll fails on
// the first subdir a container created (reproduced with the real images).
// macOS runtimes map ownership and hid it. Only the store dir is mounted —
// never the root dir, which holds secrets.
func clearStoreContents(rt, sd string) error {
	if out, err := captureBoth(rt, storeClearArgs(sd)...); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(out))
	}
	return nil
}

// storeClearArgs: the run that empties sd — every entry, dotfiles included,
// and not the mount point itself.
func storeClearArgs(sd string) []string {
	return []string{"run", "--rm", "-v", sd + ":/store", "busybox:1.38.0",
		"find", "/store", "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+"}
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
// reads (database mismatch refuses; projections auto-clean).
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

// diskUse: what the regular files under path take on disk, and whether the
// path exists at all — absent must stay distinguishable from empty ("unknown
// is not missing"). What a file takes is the space allocated to it, not its
// length: a sparse file, as a vector store's are, is long and takes little,
// and summing lengths reported eight times what one held. Go-native walk;
// unreadable entries are skipped, not fatal.
func diskUse(path string) (int64, bool) {
	if _, err := os.Stat(path); err != nil {
		return 0, false
	}
	var total int64
	_ = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() {
			if info, e := d.Info(); e == nil {
				total += allocatedBytes(p, info)
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
