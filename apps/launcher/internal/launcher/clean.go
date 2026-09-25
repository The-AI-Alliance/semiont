package launcher

// clean.go — `semiont clean`: remove one root's persistent local-stack
// state (LAUNCHER-STATE.md). start persists postgres/qdrant/neo4j under
// <dataDir>/roots/<key>; this command is the only way that data dies —
// stop deliberately leaves it, and start's database image-mismatch refusal
// names this command as the way out.
//
// The root dir also holds the generated `jwt-secret` (loadOrCreateJWTSecret),
// so an UNSCOPED clean removes it along with the stores: the accounts its
// tokens name are in the postgres data going away, so keeping the key would
// preserve nothing. A --store clean targets one subdir and leaves it.

import (
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const cleanUsage = `Usage: semiont clean [options]

Remove the persistent local-stack state (PostgreSQL, Qdrant, Neo4j data,
and the gateway's own derived stores)
for one local semiont root. The stack must be stopped first — state is
never removed while a recorded stack may be mounting it.

An unscoped clean also removes this root's generated JWT secret, so every
token issued against it stops verifying — which is consistent, since the
user accounts those tokens name lived in the PostgreSQL data just removed.
A --store clean keeps the secret.

Options:
  --store <role>   Remove one store only: database, vectors, graph,
                   anchored-text, messaging (the NATS daemon's JetStream
                   store: the job queue and the gateway's ledger claims —
                   pending work is dropped; jobs are re-submittable), or state
                   (views + the gateway's fs jobs queue; views rebuild from
                   the event log on next start, queued jobs are lost)
  --root <value>   Another root: a path, a registered basename, or a state
                   key as listed by status --verbose (how orphaned state,
                   whose KB directory no longer exists, is named)
  --dry-run        Show what would be removed and its size; remove nothing
  --help           Show this help
`

func Clean(args []string) int {
	u := NewUI(false)
	store := ""
	rootArg := ""
	dryRun := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--store":
			if i+1 >= len(args) {
				u.Fail("Missing value for --store")
				return 1
			}
			store = args[i+1]
			i++
		case "--root":
			if i+1 >= len(args) {
				u.Fail("Missing value for --root")
				return 1
			}
			rootArg = args[i+1]
			i++
		case "--dry-run":
			dryRun = true
		case "--help", "-h":
			fmt.Print(cleanUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", args[i])
			return 1
		}
	}
	if store != "" {
		if _, ok := stateStores[store]; !ok {
			u.Fail("Unknown store %q (stores with persistent state: %s)", store, strings.Join(slices.Sorted(maps.Keys(stateStores)), ", "))
			return 1
		}
	}

	key, dir, code := cleanTarget(u, rootArg)
	if code != 0 {
		return code
	}

	// Never sweep state out from under a stack that may be mounting it.
	// stack.json is belief, but the asymmetry decides: a stale "running"
	// costs the user one `semiont stop`; removing mounted dirs corrupts. The
	// same asymmetry is why an UNREADABLE record refuses outright instead of
	// reading as "no stack is using this".
	ss := LoadStackSet()
	if ss.refuseUnreadable(u) {
		return 1
	}
	if st := ss.Stacks["local"]; st != nil && stateKeyFor(st.KBDid, st.KBRoot) == key {
		u.Fail("A recorded local stack is using this state (per %s).", statePath())
		fmt.Fprintln(os.Stderr, "  Stop it first: semiont stop")
		return 1
	}

	type target struct {
		label, path string
		size        int64
	}
	var targets []target
	if store != "" {
		targets = append(targets, target{store, filepath.Join(dir, stateStores[store].dir), 0})
	} else {
		targets = append(targets, target{"all stores (" + key + ")", dir, 0})
	}

	var kept []target
	for _, tg := range targets {
		sz, exists := dirSize(tg.path)
		if !exists {
			continue
		}
		tg.size = sz
		kept = append(kept, tg)
		if dryRun {
			u.Log("would remove %s — %s (%s)", tg.path, humanBytes(sz), tg.label)
		}
	}
	if len(kept) == 0 {
		if store != "" {
			u.Log("Nothing to remove: no %s state under %s", store, dir)
		} else {
			u.Log("Nothing to remove: no state at %s", dir)
		}
		return 0
	}
	if dryRun {
		var total int64
		for _, tg := range kept {
			total += tg.size
		}
		u.Log("Total: %s %s", humanBytes(total), u.Dim("(dry-run; nothing removed)"))
		return 0
	}
	for _, tg := range kept {
		if err := os.RemoveAll(tg.path); err != nil {
			u.Fail("cannot remove %s: %v", tg.path, err)
			return 1
		}
		// Name what was actually removed — a scoped clean removes ONE
		// store's dir, never the root's.
		u.Ok("Removed %s — %s freed.", tg.path, humanBytes(tg.size))
	}
	// A scoped clean drops that store's stamp too, so the next start sees
	// first-use, not a mismatch against thin air. A full clean removed
	// meta.json with the dir.
	if store != "" {
		meta := loadRootMeta(dir)
		delete(meta.Stores, store)
		saveRootMeta(dir, meta)
	}
	return 0
}

// cleanTarget resolves which root's state to clean. No --root: the same
// cwd ladder start uses. --root: a path or registered basename first
// (resolveRootArg), else a literal key with a dir under roots/ — the form
// status prints for orphans, whose KB no longer resolves any other way.
func cleanTarget(u *UI, rootArg string) (key, dir string, code int) {
	d := dataDir()
	if d == "" {
		u.Fail("No home directory resolvable; nowhere for state to live.")
		return "", "", 1
	}
	switch {
	case rootArg == "":
		root, _, err := resolveKBRoot()
		if err != nil {
			u.Fail("%v", err)
			fmt.Fprintln(os.Stderr, "  Run inside a KB, or name one: semiont clean --root <path|name|key>")
			return "", "", 1
		}
		key = rootKey(root)
	default:
		root, err := resolveRootArg(rootArg)
		if err == nil {
			key = rootKey(root)
			break
		}
		// A literal key must be a plain basename — anything else (".."; a
		// path) would let RemoveAll reach outside roots/.
		if rootArg == filepath.Base(rootArg) && rootArg != "." && rootArg != ".." {
			if fi, statErr := os.Stat(filepath.Join(d, "roots", rootArg)); statErr == nil && fi.IsDir() {
				key = rootArg
				break
			}
		}
		u.Fail("%v", err)
		fmt.Fprintf(os.Stderr, "  (and no state key %q under %s)\n", rootArg, filepath.Join(d, "roots"))
		return "", "", 1
	}
	return key, filepath.Join(d, "roots", key), 0
}
