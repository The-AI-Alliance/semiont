package stack

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Dir: where a knowledge base commits its stack's documents, below its root.
const Dir = ".semiont/stack"

// The documents' fixed names (D17), and the directory of the Inference
// documents a machine chooses one of.
const (
	KnowledgeBaseFile  = "knowledge-base.yaml"
	KnowledgeIndexFile = "index.yaml"
	IssuerFile         = "issuer.yaml"
	InferenceDir       = "inference"
)

// The documents that belong to no knowledge base are kept in the launcher's
// state home, in StateHomeDir: the Browser's, as BrowserFile, and the
// worker's, as WorkerPoolFile.
const (
	StateHomeDir   = "stack"
	BrowserFile    = "browser.yaml"
	WorkerPoolFile = "workers.yaml"
)

// Stack: a knowledge base's documents, each held to its schema, and the names
// by which they refer to one another held to one another.
type Stack struct {
	KnowledgeBase  KnowledgeBase
	KnowledgeIndex KnowledgeIndex
	// Issuer: the document the KnowledgeBase's issuer.ref names; nil when the
	// knowledge base trusts an issuer somebody else runs.
	Issuer    *Issuer
	Inference Inference
	// Files: where each document was read, relative to the root, for the
	// refusals that name one.
	Files Files
}

// Files: each document's path below the root.
type Files struct {
	KnowledgeBase, KnowledgeIndex, Issuer, Inference string
}

// InferencePath: the Inference document named name, below the root.
func InferencePath(name string) string {
	return filepath.Join(Dir, InferenceDir, name+".yaml")
}

// InferenceNames: the Inference documents the knowledge base at root holds,
// by name, sorted.
func InferenceNames(root string) []string {
	matches, _ := filepath.Glob(filepath.Join(root, Dir, InferenceDir, "*.yaml"))
	names := make([]string, 0, len(matches))
	for _, m := range matches {
		names = append(names, strings.TrimSuffix(filepath.Base(m), ".yaml"))
	}
	sort.Strings(names)
	return names
}

// Load reads the knowledge base at root: its three documents and the Inference
// document named inference. A document that does not hold to its schema is
// refused with every place it does not; a document missing, or naming another
// that is not there, is refused by name.
func Load(root, inference string) (*Stack, error) {
	files := Files{
		KnowledgeBase:  filepath.Join(Dir, KnowledgeBaseFile),
		KnowledgeIndex: filepath.Join(Dir, KnowledgeIndexFile),
		Issuer:         filepath.Join(Dir, IssuerFile),
		Inference:      InferencePath(inference),
	}
	at := func(path string) string { return filepath.Join(root, path) }
	st := &Stack{Files: files}
	var err error
	if st.KnowledgeBase, err = Read[KnowledgeBase](at(files.KnowledgeBase), "KnowledgeBase"); err != nil {
		return nil, err
	}
	if st.KnowledgeIndex, err = Read[KnowledgeIndex](at(files.KnowledgeIndex), "KnowledgeIndex"); err != nil {
		return nil, err
	}
	if st.Inference, err = Read[Inference](at(files.Inference), "Inference"); err != nil {
		return nil, err
	}
	if ref := st.KnowledgeBase.Spec.Issuer.Ref; ref != nil {
		issuer, err := Read[Issuer](at(files.Issuer), "Issuer")
		if err != nil {
			return nil, err
		}
		st.Issuer = &issuer
	} else if _, err := os.Stat(at(files.Issuer)); err == nil {
		return nil, fmt.Errorf("%s: the knowledge base trusts the issuer at spec.issuer.external, and %s describes one the launcher would run — delete one of the two", files.KnowledgeBase, files.Issuer)
	}
	if err := st.namesHold(); err != nil {
		return nil, err
	}
	return st, nil
}

// namesHold: each name a document gives another names the document there.
func (st *Stack) namesHold() error {
	kb := st.KnowledgeBase.Metadata.Name
	if got := st.KnowledgeIndex.Spec.KnowledgeBase; got != kb {
		return fmt.Errorf("%s: spec.knowledgeBase names %q, and %s is %q", st.Files.KnowledgeIndex, got, st.Files.KnowledgeBase, kb)
	}
	if ref := st.KnowledgeBase.Spec.Issuer.Ref; ref != nil && *ref != st.Issuer.Metadata.Name {
		return fmt.Errorf("%s: spec.issuer.ref names %q, and %s is %q", st.Files.KnowledgeBase, *ref, st.Files.Issuer, st.Issuer.Metadata.Name)
	}
	if want := strings.TrimSuffix(filepath.Base(st.Files.Inference), ".yaml"); st.Inference.Metadata.Name != want {
		return fmt.Errorf("%s: metadata.name is %q, and an Inference document is named by its file, %q", st.Files.Inference, st.Inference.Metadata.Name, want)
	}
	return nil
}
