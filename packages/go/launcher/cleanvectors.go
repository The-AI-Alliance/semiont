package launcher

// cleanvectors.go — a knowledge base's index at the shared Qdrant, for
// `semiont clean`: its collections deleted through Qdrant's API, every other
// knowledge base's left, and the shared Qdrant run for the delete when none
// is recorded as running.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// indexCollectionWords: the words of a knowledge base's collections, as
// protocol/specs/src/vectors/payload-cases.json's `collections` names them.
var indexCollectionWords = []string{"resources", "annotations", "declined"}

// indexCollections: the collections a knowledge base's index is kept in on a
// Qdrant it shares, by word: the SHA-256 of its DID's UTF-8 bytes in lower-case
// hexadecimal, a hyphen, and the word.
func indexCollections(did string) map[string]string {
	sum := sha256.Sum256([]byte(did))
	names := make(map[string]string, len(indexCollectionWords))
	for _, word := range indexCollectionWords {
		names[word] = hex.EncodeToString(sum[:]) + "-" + word
	}
	return names
}

// onSharedVectors: whether the knowledge base at kbDir keeps its index at the
// shared Qdrant, as its index document says. State whose knowledge base is
// gone (kbDir "") is taken to: the document is the one thing that could say
// otherwise.
func onSharedVectors(kbDir string) (bool, error) {
	if kbDir == "" {
		return true, nil
	}
	index, err := stack.Read[stack.KnowledgeIndex](filepath.Join(kbDir, stack.Dir, stack.KnowledgeIndexFile), "KnowledgeIndex")
	if err != nil {
		return false, err
	}
	return index.Spec.Vectors.Shared != nil, nil
}

// indexDelete: how a clean deletes a knowledge base's collections at the
// shared Qdrant — at base, the one recorded as running, which holds held and
// is asked with key, the machine's; or, start, at one the clean runs for the
// delete, since none is recorded and its store may hold them. Neither: there
// is nothing to delete.
type indexDelete struct {
	base  string
	key   string
	held  []string
	start bool
}

func (d indexDelete) none() bool { return len(d.held) == 0 && !d.start }

// sharedVectorsBase: the shared Qdrant's origin, as its record says it is
// reached; "" when none is recorded as running.
func sharedVectorsBase(ss *StackSet) string {
	rec := ss.Shared[sharedContainer("vectors")]
	if rec == nil {
		return ""
	}
	return qdrantBase(rec.Endpoint)
}

// indexToDelete: how a clean deletes the collections of the knowledge base
// whose DID is did, as the shared Qdrant recorded as running answers or, with
// none recorded, as its store may hold them; or a refusal when the recorded
// one does not answer the machine's key as Qdrant does, or the launcher keeps
// no key for it. A recorded Qdrant keeps every other knowledge base's index,
// so the clean never runs one in its place.
func indexToDelete(u *UI, ss *StackSet, did string) (indexDelete, bool) {
	base := sharedVectorsBase(ss)
	if base == "" {
		_, kept := diskUse(machineStore("vectors").storeDir(""))
		return indexDelete{start: kept}, true
	}
	d := daemonCredentials["vectors"]
	key, ok := sharedCustody().get(u, d.custody)
	if !ok {
		return indexDelete{}, false
	}
	var held []string
	var err error
	if key == "" {
		err = fmt.Errorf("the launcher keeps no %s for it", d.credential)
	} else {
		held, err = collectionsHeld(base, key, did)
	}
	if err != nil {
		u.Fail("The shared Qdrant at %s: %v", base, err)
		fmt.Fprintln(os.Stderr, "  It is recorded as running (semiont status shows it). Once it is stopped (semiont stop --service vectors), this clean runs it for the delete.")
		return indexDelete{}, false
	}
	return indexDelete{base: base, key: key, held: held}, true
}

// cleanIndex deletes the collections of the knowledge base whose DID is did
// at the shared Qdrant, as d says: at the one running, or at one run for the
// delete (vectorsForClean), asked first which it holds and stopped again
// whatever the answer.
func cleanIndex(u *UI, d indexDelete, did string) bool {
	if d.start {
		stop, key, ok := vectorsForClean(u)
		if !ok {
			return false
		}
		defer stop()
		d.base, d.key = sharedVectorsBase(LoadStackSet()), key
		held, err := collectionsHeld(d.base, d.key, did)
		if err != nil {
			u.Fail("The shared Qdrant at %s: %v", d.base, err)
			return false
		}
		if len(held) == 0 {
			u.Log("No index of %s at the shared Qdrant", did)
			return true
		}
		d.held = held
	}
	for _, name := range d.held {
		if err := deleteCollection(d.base, d.key, name); err != nil {
			u.Fail("Collection %s: %v", name, err)
			return false
		}
	}
	u.Ok("Deleted the index of %s from the shared Qdrant (%d collections).", did, len(d.held))
	return true
}

// vectorsForClean runs the shared Qdrant for a clean that deletes a
// knowledge base's collections and finds none recorded as running, as a
// start runs it from the vector store's document, with the machine's key,
// which it answers. No knowledge base's stack is recorded. stop stops it, and
// so does a run that fails.
func vectorsForClean(u *UI) (stop func(), key string, ok bool) {
	doc, ok := readVectorStoreDocument(u, false)
	if !ok {
		return nil, "", false
	}
	rt, ok := cleanRuntime(u)
	if !ok {
		return nil, "", false
	}
	plan := &launchPlan{Roles: map[string]rolePlan{"vectors": sharedVectorsRole(&doc)}}
	x := &liveExec{u: u, rt: rt, plan: plan}
	addr, ok := x.resolveAddr()
	if !ok {
		return nil, "", false
	}
	fc, ok := withDaemonCredentials(x, flowCtx{plan: plan})
	if !ok {
		return nil, "", false
	}
	u.Log("The shared Qdrant is not running: running it for the delete %s", u.Dim("(this clean stops it again)"))
	name := sharedContainer("vectors")
	stop = func() {
		if stopSharedService(u, []string{rt}, name, LoadStackSet()) {
			u.Ok("Stopped %s, which this clean ran for the delete.", name)
		}
	}
	if _, code := runSharedVectors(x, fc, addr, false); code != 0 {
		stop()
		return nil, "", false
	}
	return stop, userEnvVars(fc.userEnv)[daemonCredentials["vectors"].env], true
}

// collectionsHeld: which of the collections of the knowledge base whose DID
// is did the Qdrant at base, asked with key, holds, in their words' order.
func collectionsHeld(base, key, did string) ([]string, error) {
	names, err := qdrantCollections(base, key)
	if err != nil {
		return nil, err
	}
	ours := indexCollections(did)
	var held []string
	for _, word := range indexCollectionWords {
		if slices.Contains(names, ours[word]) {
			held = append(held, ours[word])
		}
	}
	return held, nil
}

// deleteCollection deletes a collection the Qdrant at base, asked with key,
// holds, and all that is in it. Qdrant answers true for a collection it
// deleted.
func deleteCollection(base, key, name string) error {
	resp, err := qdrantRequest(http.MethodDelete, base, key, "/collections/"+name)
	if err != nil {
		return fmt.Errorf("deleting it: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Qdrant refused to delete it: %s", qdrantRefusal(resp))
	}
	var deleted qdrantAnswer[bool]
	if err := json.NewDecoder(resp.Body).Decode(&deleted); err != nil || !deleted.Result {
		return fmt.Errorf("Qdrant did not say it deleted it")
	}
	return nil
}
