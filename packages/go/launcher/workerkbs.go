package launcher

// workerkbs.go — the knowledge bases someone else runs that this machine's
// worker serves beside the one each start runs. Each is added by `semiont
// worker kb add`, from what its operator printed on granting this machine's
// key (`semiont identity grant`), and kept for the machine beside the key.
// Nothing in one is secret: the worker proves itself at each with the
// machine's key (workerkey.go).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// addedKBsFile: where the added knowledge bases are kept, under
// machineStateDir.
const addedKBsFile = "worker-knowledge-bases.json"

// addedKB: a knowledge base added to this machine's worker — its entry in the
// worker's document but for its engines, which each start offers it
// (workerDocument). A record of its own, since the generated entry requires
// engines; TestAnAddedKnowledgeBaseIsAWorkerEntryButItsEngines holds the two
// to one shape.
type addedKB struct {
	Domain     string `json:"domain"`
	GatewayUrl string `json:"gatewayUrl"`
	Identity   struct {
		ClientId string `json:"clientId"`
		Issuer   string `json:"issuer"`
	} `json:"identity"`
}

// entry: k's entry in the worker's document, offered engines.
func (k addedKB) entry(engines []api.WorkerEngineConfig) api.WorkerKnowledgeBaseConfig {
	return api.WorkerKnowledgeBaseConfig{Domain: k.Domain, GatewayUrl: k.GatewayUrl, Identity: k.Identity, Engines: engines}
}

// errNowhereToKeepKBs: there is no home, so no knowledge base can be added.
var errNowhereToKeepKBs = errors.New("no home directory resolvable, so there is nowhere to keep the knowledge bases added to this machine's worker")

// addedKBsPath: where the added knowledge bases are kept; "" when homeless.
func addedKBsPath() string {
	d := machineStateDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, addedKBsFile)
}

// loadAddedKBs: the knowledge bases added to this machine's worker, in the
// order of their domains; none when none was ever added, and none without a
// home, where none can have been. A file that cannot be read, or holds
// anything but added knowledge bases, is refused, naming it: never read as
// none, which would start a worker serving less than was added.
func loadAddedKBs() ([]addedKB, error) {
	p := addedKBsPath()
	if p == "" {
		return nil, nil
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var added []addedKB
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&added); err != nil {
		return nil, fmt.Errorf("%s does not hold the knowledge bases added to this machine's worker: %v", p, err)
	}
	return added, nil
}

// saveAddedKBs keeps added in the order of their domains, atomically and to
// its owner (writeOwnerOnly), as the machine's worker key is kept. With none
// left the file goes: none added is no file, as before the first was.
func saveAddedKBs(added []addedKB) error {
	p := addedKBsPath()
	if p == "" {
		return errNowhereToKeepKBs
	}
	if len(added) == 0 {
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	sort.Slice(added, func(i, j int) bool { return added[i].Domain < added[j].Domain })
	b, err := json.MarshalIndent(added, "", "  ")
	if err != nil {
		return err
	}
	return writeOwnerOnly(p, append(b, '\n'))
}

// refuseOwnKB: the refusal of a start of the knowledge base at domain when it
// is among the knowledge bases added to this machine's worker. The worker
// serves the knowledge base it is started with as its own, and refuses a
// document naming one domain twice.
func refuseOwnKB(domain string, added []addedKB) error {
	for _, kb := range added {
		if kb.Domain == domain {
			return fmt.Errorf("%s is added to this machine's worker, and it is the knowledge base this start runs, which the worker serves as its own: remove it (semiont worker kb remove %s)", domain, domain)
		}
	}
	return nil
}
