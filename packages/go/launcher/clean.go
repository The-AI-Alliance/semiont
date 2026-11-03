package launcher

// clean.go — `semiont clean`: remove one root's persistent local-stack
// state. start persists qdrant/neo4j and the rest under
// <dataDir>/roots/<key>; this command is the only way that data dies — stop
// deliberately leaves it, and start's image-mismatch refusal names this
// command as the way out. The root's realm at the shared issuer goes with it,
// through Keycloak's admin API: the PostgreSQL that keeps every realm here is
// the machine's, and one root's clean leaves it. `--shared` removes that
// PostgreSQL's store instead (cleanissuer.go).
//
// An UNSCOPED clean also deletes every secret the launcher keeps for the root
// (custody.go), through the store that keeps them: the accounts the
// token-signing key's tokens name are in the realm going away, so keeping it
// would preserve nothing. A --store clean targets one store and leaves them.

import (
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

const cleanUsage = `Usage: semiont clean [options]

Remove the persistent local-stack state (Qdrant, Neo4j data, the job
queue, the Archivist's views and anchored text, and the supervisors' logs)
for one local semiont root, and the knowledge base's realm at the shared
issuer, its accounts and clients with it. The stack must be stopped first —
state is never removed while a recorded stack may be mounting it. The realm
is deleted through the shared Keycloak: the one running, or, with none
running, one this clean runs for the delete and stops again.

An unscoped clean also deletes every secret the launcher keeps for this
root, from whichever store keeps them (semiont settings secret-store): the token-
signing key, so every token issued against it stops verifying — which is
consistent, since the user accounts those tokens name lived in the realm
just deleted — and the passwords of the stores going with it. The store
setting itself stays. A --store clean keeps the secrets.

semiont clean --shared --store identity-store removes the shared issuer's
PostgreSQL store, and every knowledge base's realm with it, once no recorded
stack signs in at the shared issuer and its server is stopped (semiont stop
--group issuer). The issuer's passwords stay, so its next boot reuses them,
and each knowledge base's next start creates its realm afresh.

Options:
  --store <role>   Remove one store only: identity-store (the knowledge
                   base's realm at the shared issuer; the PostgreSQL that
                   keeps every realm here stays), vectors, graph,
                   anchored-text, messaging (the NATS daemon's JetStream
                   store: the job queue and the gateway's ledger claims —
                   pending work is dropped; jobs are re-submittable), state
                   (views; they rebuild from the event log on next start), or
                   gateway or librarian (that service's supervisor's events log)
  --root <value>   Another root: a path, a registered basename, or a state
                   key as listed by status --verbose (how orphaned state,
                   whose KB directory no longer exists, is named)
  --shared         The machine's shared state instead of a root's: the
                   shared issuer's, with --store identity-store. Not with
                   --root
  --dry-run        Show what would be removed and its size; remove nothing
  --help           Show this help
`

func Clean(args []string) int {
	u := NewUI(false)
	store := ""
	rootArg := ""
	shared := false
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
		case "--shared":
			shared = true
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

	if shared {
		if rootArg != "" {
			u.Fail("--shared names the machine's shared state, and --root one root's: name one of them.")
			return 1
		}
		return cleanShared(u, store, dryRun)
	}

	key, dir, kbDir, code := cleanTarget(u, rootArg)
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
	if st := localStack(ss, key); st != nil {
		u.Fail("A recorded stack is using this state (per %s).", statePath())
		fmt.Fprintln(os.Stderr, "  Stop it first: semiont stop --root "+st.KBRoot)
		return 1
	}

	// The knowledge base's realm at the shared issuer goes with its identity
	// store and with an unscoped clean, and before its secrets: a realm left
	// behind keeps the clients those secrets were for, and the next start,
	// finding it held, would not create it afresh. The realm is the root's key
	// (derivePlan names it so).
	var realm realmDelete
	if store == "" || store == "identity-store" {
		onShared, err := onSharedIssuer(kbDir)
		if err != nil {
			u.Fail("%v", err)
			return 1
		}
		if onShared {
			var ok bool
			if realm, ok = realmToDelete(u, ss, key); !ok {
				return 1
			}
		}
		switch {
		case !dryRun:
		case realm.base != "":
			u.Log("would delete realm %s %s", key, u.Dim("(the shared issuer, "+realm.base+")"))
		case realm.start:
			u.Log("would run the shared issuer, delete realm %s if it holds it, and stop the issuer again %s", key, u.Dim("(it is not running)"))
		}
	}

	type target struct {
		label, path string
		size        int64
	}
	// A store the machine keeps for every knowledge base is not this root's to
	// remove.
	scopedHere := store != "" && !sharedRole(stateStores[store].owner)
	var targets []target
	switch {
	case scopedHere:
		targets = append(targets, target{store, filepath.Join(dir, stateStores[store].dir), 0})
	case store == "":
		targets = append(targets, target{"all stores (" + key + ")", dir, 0})
	}

	// The secrets go with an unscoped clean, from the store that keeps them.
	var secrets []string
	var custody custodyStore
	if store == "" {
		var ok bool
		if custody, ok = configuredCustody(u, key); !ok {
			return 1
		}
		if secrets, ok = custody.names(u); !ok {
			return 1
		}
		if dryRun {
			for _, name := range secrets {
				u.Log("would delete %s %s", name, u.Dim("("+custody.where(name)+")"))
			}
		}
	}

	var kept []target
	for _, tg := range targets {
		sz, exists := diskUse(tg.path)
		if !exists {
			continue
		}
		tg.size = sz
		kept = append(kept, tg)
		if dryRun {
			u.Log("would remove %s — %s (%s)", tg.path, humanBytes(sz), tg.label)
		}
	}
	if len(kept) == 0 && len(secrets) == 0 && realm == (realmDelete{}) {
		switch {
		case scopedHere:
			u.Log("Nothing to remove: no %s state under %s", store, dir)
		case store != "":
			u.Log("Nothing to remove: no realm %s at the shared issuer", key)
		default:
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
	if realm != (realmDelete{}) && !cleanRealm(u, realm, key) {
		return 1
	}
	for _, name := range secrets {
		if !custody.remove(u, name) {
			return 1
		}
	}
	if len(secrets) > 0 {
		u.Ok("Deleted %d secrets from %s.", len(secrets), custody.describe())
	}
	// The stores' contents were written by containers, so a container empties
	// them (clearStoreContents); what is left — the store dirs, and for an
	// unscoped clean the root's own secrets and meta.json — is the invoker's.
	rt := ""
	for _, tg := range kept {
		for _, sd := range storeDirsUnder(tg.path, store) {
			if rt == "" {
				var ok bool
				if rt, ok = cleanRuntime(u); !ok {
					return 1
				}
			}
			if err := clearStoreContents(rt, sd); err != nil {
				u.Fail("cannot empty %s: %v", sd, err)
				return 1
			}
		}
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
	if scopedHere && len(kept) > 0 {
		meta := loadRootMeta(dir)
		delete(meta.Stores, store)
		saveRootMeta(dir, meta)
	}
	return 0
}

// onSharedIssuer: whether the knowledge base at kbDir names the shared issuer,
// as its document says. State whose knowledge base is gone (kbDir "") is
// taken to: the document is the one thing that could say otherwise.
func onSharedIssuer(kbDir string) (bool, error) {
	if kbDir == "" {
		return true, nil
	}
	kb, err := stack.Read[stack.KnowledgeBase](filepath.Join(kbDir, stack.Dir, stack.KnowledgeBaseFile), "KnowledgeBase")
	if err != nil {
		return false, err
	}
	return kb.Spec.Issuer.Shared != nil, nil
}

// realmDelete: how a clean deletes the knowledge base's realm at the shared
// issuer — at base, the server recorded as running, which holds it; or,
// start, at one the clean runs for the delete, since none is recorded and its
// store may hold the realm. Neither: there is no realm to delete.
type realmDelete struct {
	base  string
	start bool
}

// realmToDelete: how a clean deletes realm at the shared issuer, as the
// server recorded as running answers or, with none recorded, as its store may
// hold it; or a refusal when the recorded server does not answer as Keycloak
// does. A recorded server may be another knowledge base's issuer, so the
// clean never runs one in its place.
func realmToDelete(u *UI, ss *StackSet, realm string) (realmDelete, bool) {
	base := sharedKeycloakBase(ss)
	if base == "" {
		return realmDelete{start: !noRealmIsKept(realm)}, true
	}
	held, err := realmHeld(base, realm)
	if err != nil {
		u.Fail("The shared issuer at %s: %v", base, err)
		fmt.Fprintln(os.Stderr, "  It is recorded as running (semiont status shows it). Once it is stopped (semiont stop --group issuer), this clean runs it for the delete.")
		return realmDelete{}, false
	}
	if !held {
		return realmDelete{}, true
	}
	return realmDelete{base: base}, true
}

// cleanRealm deletes realm at the shared Keycloak as rd says: at the one
// running, or at one run for the delete (issuerForClean), asked first whether
// it holds the realm and stopped again whatever the answer.
func cleanRealm(u *UI, rd realmDelete, realm string) bool {
	if rd.start {
		stop, ok := issuerForClean(u)
		if !ok {
			return false
		}
		defer stop()
	}
	base, password, _, ok := sharedKeycloakAdmin(u, LoadStackSet())
	if !ok {
		return false
	}
	if rd.start {
		held, err := realmHeld(base, realm)
		if err != nil {
			u.Fail("The shared issuer at %s: %v", base, err)
			return false
		}
		if !held {
			u.Log("No realm %s at the shared issuer", realm)
			return true
		}
	}
	if err := deleteRealm(base, realm, password); err != nil {
		u.Fail("Realm %s: %v", realm, err)
		return false
	}
	u.Ok("Deleted realm %s from the shared issuer.", realm)
	return true
}

// noRealmIsKept: whether the shared issuer can hold no realm at all, with its
// server down: its database is the launcher's, and its store holds nothing.
func noRealmIsKept(key string) bool {
	doc, err := loadIssuerDocument(true)
	if err != nil || doc.spec.Database.External != nil {
		return false
	}
	_, exists := diskUse(stateStores["identity-store"].storeDir(key))
	return !exists
}

// storeDirsUnder: the existing store dirs a clean target holds — the one
// store for a scoped clean, every store under the root for an unscoped one.
func storeDirsUnder(path, store string) []string {
	if store != "" {
		return []string{path}
	}
	var out []string
	for _, role := range slices.Sorted(maps.Keys(stateStores)) {
		sd := filepath.Join(path, stateStores[role].dir)
		if fi, err := os.Stat(sd); err == nil && fi.IsDir() {
			out = append(out, sd)
		}
	}
	return out
}

// cleanRuntime: the runtime whose container empties the stores — the one the
// last explicit start recorded (roots.json), else whatever is installed. No
// stack is running here (clean refused that above), so there is no live
// record to rejoin.
func cleanRuntime(u *UI) (string, bool) {
	requested := loadRoots().Runtime
	if requested != "" && !onPath(requested) {
		requested = ""
	}
	return SelectRuntime(u, requested)
}

// cleanTarget resolves which root's state to clean, and the knowledge base
// it is, "" for state whose knowledge base is gone. No --root: the same cwd
// ladder start uses. --root: a path or registered basename first
// (resolveRootArg), else a literal key with a dir under roots/ — the form
// status prints for orphans, whose KB resolves no other way.
func cleanTarget(u *UI, rootArg string) (key, dir, kbDir string, code int) {
	d := dataDir()
	if d == "" {
		u.Fail("No home directory resolvable; nowhere for state to live.")
		return "", "", "", 1
	}
	switch {
	case rootArg == "":
		root, _, ident, err := resolveKBRoot()
		if err != nil {
			u.Fail("%v", err)
			if !projectFileRefused(err) {
				fmt.Fprintln(os.Stderr, "  Run inside a KB, or name one: semiont clean --root <path|name|key>")
			}
			return "", "", "", 1
		}
		key, kbDir = kbRoot{dir: root, ident: ident}.key(), root
	default:
		root, ident, err := resolveRootArg(rootArg)
		if err == nil {
			key, kbDir = kbRoot{dir: root, ident: ident}.key(), root
			break
		}
		if projectFileRefused(err) {
			u.Fail("%v", err)
			return "", "", "", 1
		}
		// A literal key must be a plain basename — anything else (".."; a
		// path) would let RemoveAll reach outside roots/.
		if rootArg == filepath.Base(rootArg) && rootArg != "." && rootArg != ".." {
			if fi, statErr := os.Stat(stateRootDir(rootArg)); statErr == nil && fi.IsDir() {
				key = rootArg
				break
			}
		}
		u.Fail("%v", err)
		fmt.Fprintf(os.Stderr, "  (and no state key %q under %s)\n", rootArg, filepath.Join(d, "roots"))
		return "", "", "", 1
	}
	return key, stateRootDir(key), kbDir, 0
}
