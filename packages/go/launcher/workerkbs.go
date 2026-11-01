package launcher

// workerkbs.go — the knowledge bases the one shared worker serves. A
// local knowledge base's start puts its entry on the list when one of its
// jobs has an engine, as that start places it, and takes it off when none
// does (flowWorker). A knowledge base someone else runs is added by `semiont
// worker kb add`, from what its operator printed on granting this machine's
// key (`semiont identity grant`), and is offered the engines of the local
// knowledge base it was added from. The list is kept shared, beside
// the key. Nothing in it is secret: the worker proves itself at each with the
// worker key (workerkey.go), and an engine names the variable holding its
// provider's key, never the key.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// workerListFile: where the list is kept, under sharedStateDir.
const workerListFile = "worker-knowledge-bases.json"

// workerList: the knowledge bases on the shared worker's list, each kind
// in the order of its domains.
type workerList struct {
	// Local: each local knowledge base's entry in the worker's document, as
	// its last start placed it.
	Local []api.WorkerKnowledgeBaseConfig `json:"local"`
	// Added: each knowledge base someone else runs.
	Added []addedKB `json:"added"`
}

// addedKB: a knowledge base someone else runs, on the shared worker's
// list — its entry in the worker's document but for its engines, which are
// those of the local knowledge base it names (EnginesOf). A record of its
// own, since the generated entry requires engines;
// TestAnAddedKnowledgeBaseIsAWorkerEntryButItsEngines holds the two to one
// shape.
type addedKB struct {
	Domain     string `json:"domain"`
	GatewayUrl string `json:"gatewayUrl"`
	Identity   struct {
		ClientId string `json:"clientId"`
		Issuer   string `json:"issuer"`
	} `json:"identity"`
	EnginesOf string `json:"enginesOf"`
}

// entry: k's entry in the worker's document, offered engines.
func (k addedKB) entry(engines []api.WorkerEngineConfig) api.WorkerKnowledgeBaseConfig {
	return api.WorkerKnowledgeBaseConfig{Domain: k.Domain, GatewayUrl: k.GatewayUrl, Identity: k.Identity, Engines: engines}
}

// errNowhereToKeepTheList: there is no home, so no list can be kept.
var errNowhereToKeepTheList = errors.New("no home directory resolvable, so there is nowhere to keep the knowledge bases the shared worker serves")

// workerListPath: where the list is kept; "" when homeless.
func workerListPath() string {
	d := sharedStateDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, workerListFile)
}

// loadWorkerList: the list; empty when nothing was ever put on it, and
// without a home, where nothing can have been. A file that cannot be read,
// or holds anything but the list, is refused, naming it: never read as
// empty, which would start a worker serving less than its list.
func loadWorkerList() (workerList, error) {
	var list workerList
	p := workerListPath()
	if p == "" {
		return list, nil
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return list, nil
	}
	if err != nil {
		return list, err
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&list); err != nil {
		return workerList{}, fmt.Errorf("%s does not hold the knowledge bases the shared worker serves: %v", p, err)
	}
	return list, nil
}

// saveWorkerList keeps list, each kind in the order of its domains,
// atomically and to its owner (writeOwnerOnly), as the shared worker key
// is kept. An empty list is no file, as before anything was put on it.
func saveWorkerList(list workerList) error {
	p := workerListPath()
	if p == "" {
		return errNowhereToKeepTheList
	}
	if len(list.Local) == 0 && len(list.Added) == 0 {
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	sort.Slice(list.Local, func(i, j int) bool { return list.Local[i].Domain < list.Local[j].Domain })
	sort.Slice(list.Added, func(i, j int) bool { return list.Added[i].Domain < list.Added[j].Domain })
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	return writeOwnerOnly(p, append(b, '\n'))
}

// local: the local knowledge base of domain's entry, and whether it is on
// the list.
func (l workerList) local(domain string) (api.WorkerKnowledgeBaseConfig, bool) {
	at := slices.IndexFunc(l.Local, func(e api.WorkerKnowledgeBaseConfig) bool { return e.Domain == domain })
	if at < 0 {
		return api.WorkerKnowledgeBaseConfig{}, false
	}
	return l.Local[at], true
}

// put puts the local knowledge base's entry on the list, in place of the one
// its domain had.
func (l *workerList) put(entry api.WorkerKnowledgeBaseConfig) {
	l.take(entry.Domain)
	l.Local = append(l.Local, entry)
	sort.Slice(l.Local, func(i, j int) bool { return l.Local[i].Domain < l.Local[j].Domain })
}

// take takes the local knowledge base of domain off the list.
func (l *workerList) take(domain string) {
	l.Local = slices.DeleteFunc(l.Local, func(e api.WorkerKnowledgeBaseConfig) bool { return e.Domain == domain })
}

// displace takes off the list every local knowledge base but domain's whose
// gateway is on gatewayPort, and says which: one port holds one gateway, and
// a start placing its own there holds it, so none of theirs answers there
// now. Its worker would ask whichever knowledge base does, and the worker
// refuses for good a knowledge base that answers as another.
func (l *workerList) displace(domain string, gatewayPort int) []string {
	var displaced []string
	l.Local = slices.DeleteFunc(l.Local, func(e api.WorkerKnowledgeBaseConfig) bool {
		_, port := parseHostPort(e.GatewayUrl)
		if e.Domain != domain && port == gatewayPort {
			displaced = append(displaced, e.Domain)
			return true
		}
		return false
	})
	return displaced
}

// borrowers: the domains of the added knowledge bases offered domain's
// engines.
func (l workerList) borrowers(domain string) []string {
	var out []string
	for _, a := range l.Added {
		if a.EnginesOf == domain {
			out = append(out, a.Domain)
		}
	}
	return out
}

// served: the entries of the worker's document — each local knowledge base's,
// then each added one's, offered the engines of the local one it names — and
// the added ones it leaves out, whose local one is not on the list.
func (l workerList) served() (entries []api.WorkerKnowledgeBaseConfig, unserved []addedKB) {
	entries = append(entries, l.Local...)
	for _, a := range l.Added {
		lender, listed := l.local(a.EnginesOf)
		if !listed {
			unserved = append(unserved, a)
			continue
		}
		entries = append(entries, a.entry(lender.Engines))
	}
	return entries, unserved
}

// refuseOwnKB: the refusal of a start of the knowledge base at domain when it
// is added to the shared worker as one someone else runs. The worker
// refuses a document naming one domain twice, and a start puts its own
// knowledge base on the list as local.
func refuseOwnKB(domain string, added []addedKB) error {
	for _, kb := range added {
		if kb.Domain == domain {
			return fmt.Errorf("%s is added to the shared worker as a knowledge base someone else runs, and it is the knowledge base this start runs: remove it (semiont worker kb remove %s)", domain, domain)
		}
	}
	return nil
}

// workerServing: what a start that reconciles the worker does with its list
// (planWorkerServing). Others is the list as the start leaves it but for its
// own knowledge base's entry, which the start places where it places the
// stack (flowWorker); displaced, the local knowledge bases whose gateway port
// the start takes.
type workerServing struct {
	others    workerList
	displaced []string
}

// planWorkerServing: what a start of the knowledge base at domain, placing
// its gateway where containers dial gatewayPort, does with the worker's list.
// Planned before anything runs, so the provider keys a start resolves are
// those of the list it leaves (workerSecrets).
func planWorkerServing(domain string, gatewayPort int) (workerServing, error) {
	list, err := loadWorkerList()
	if err != nil {
		return workerServing{}, err
	}
	if err := refuseOwnKB(domain, list.Added); err != nil {
		return workerServing{}, err
	}
	list.take(domain)
	displaced := list.displace(domain, gatewayPort)
	return workerServing{others: list, displaced: displaced}, nil
}

// keyNamer: the knowledge base among the others on the list whose engines
// name the variable name, and whether there is one.
func (s workerServing) keyNamer(name string) (string, bool) {
	for _, kb := range s.others.Local {
		for _, e := range kb.Engines {
			if e.ApiKeyEnv != nil && *e.ApiKeyEnv == name {
				return kb.Domain, true
			}
		}
	}
	return "", false
}
