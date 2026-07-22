package launcher

// clean.go — `semiont clean`: remove one root's persistent local-stack
// state (LAUNCHER-STATE.md). start persists postgres/qdrant/neo4j under
// <dataDir>/roots/<key>; this command is the only way that data dies —
// stop deliberately leaves it, and start's database image-mismatch refusal
// names this command as the way out.

import (
	"fmt"
	"os"
	"path/filepath"
)

const cleanUsage = `Usage: semiont clean [options]

Remove the persistent local-stack state (PostgreSQL, Qdrant, Neo4j data)
for one local semiont root. The stack must be stopped first — state is
never removed while a recorded stack may be mounting it.

Options:
  --store <role>   Remove one store only: database, vectors, or graph
  --root <value>   Another root: a path, a registered basename, or a state
                   key as listed by status --verbose (how orphaned state,
                   whose KB directory no longer exists, is named)
  --dry-run        Show what would be removed and its size; remove nothing
  --help           Show this help
`

func Clean(args []string) int {
	u := newUI(false)
	store := ""
	rootArg := ""
	dryRun := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--store":
			if i+1 >= len(args) {
				u.fail("Missing value for --store")
				return 1
			}
			store = args[i+1]
			i++
		case "--root":
			if i+1 >= len(args) {
				u.fail("Missing value for --root")
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
			u.fail("Unknown argument: %s", args[i])
			return 1
		}
	}
	if store != "" {
		if _, ok := stateStores[store]; !ok {
			u.fail("Unknown store %q (stores with persistent state: database, graph, vectors)", store)
			return 1
		}
	}

	key, dir, code := cleanTarget(u, rootArg)
	if code != 0 {
		return code
	}

	// Never sweep state out from under a stack that may be mounting it.
	// stack.json is belief, but the asymmetry decides: a stale "running"
	// costs the user one `semiont stop`; removing mounted dirs corrupts.
	if st := loadLocalState(); st != nil && stateKeyFor(st.KBDid, st.KBRoot) == key {
		u.fail("A recorded local stack is using this state (per %s).", statePath())
		fmt.Fprintln(os.Stderr, "  Stop it first: semiont stop")
		return 1
	}

	type target struct{ label, path string }
	var targets []target
	if store != "" {
		targets = append(targets, target{store, filepath.Join(dir, stateStores[store].dir)})
	} else {
		targets = append(targets, target{"all stores (" + key + ")", dir})
	}

	var total int64
	found := false
	for _, tg := range targets {
		sz, exists := dirSize(tg.path)
		if !exists {
			continue
		}
		found = true
		total += sz
		if dryRun {
			u.log("would remove %s — %s (%s)", tg.path, humanBytes(sz), tg.label)
		}
	}
	if !found {
		u.log("Nothing to remove: no state at %s", dir)
		return 0
	}
	if dryRun {
		u.log("Total: %s %s", humanBytes(total), u.dim("(dry-run; nothing removed)"))
		return 0
	}
	for _, tg := range targets {
		if err := os.RemoveAll(tg.path); err != nil {
			u.fail("cannot remove %s: %v", tg.path, err)
			return 1
		}
	}
	// A scoped clean drops that store's stamp too, so the next start sees
	// first-use, not a mismatch against thin air. A full clean removed
	// meta.json with the dir.
	if store != "" {
		meta := loadRootMeta(dir)
		delete(meta.Stores, store)
		saveRootMeta(dir, meta)
	}
	u.ok("Removed %s — %s freed.", dir, humanBytes(total))
	return 0
}

// cleanTarget resolves which root's state to clean. No --root: the same
// cwd ladder start uses. --root: a path or registered basename first
// (resolveRootArg), else a literal key with a dir under roots/ — the form
// status prints for orphans, whose KB no longer resolves any other way.
func cleanTarget(u *ui, rootArg string) (key, dir string, code int) {
	d := dataDir()
	if d == "" {
		u.fail("No home directory resolvable; nowhere for state to live.")
		return "", "", 1
	}
	switch {
	case rootArg == "":
		root, _, err := resolveKBRoot()
		if err != nil {
			u.fail("%v", err)
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
		if fi, statErr := os.Stat(filepath.Join(d, "roots", rootArg)); statErr == nil && fi.IsDir() {
			key = rootArg
			break
		}
		u.fail("%v", err)
		fmt.Fprintf(os.Stderr, "  (and no state key %q under %s)\n", rootArg, filepath.Join(d, "roots"))
		return "", "", 1
	}
	return key, filepath.Join(d, "roots", key), 0
}
