package launcher

// kbconfig.go — the read-side of a knowledge base's project file, its
// committed identity card: `.semiont/config.yaml` (ProjectConfig, in
// specs/src/kb-identity). Its project name and version, git sync, and site —
// whose `domain` is the permanent did:web identity everything the KB mints is
// stamped with (a committed literal naming the repo, never a machine address;
// see the DID/site.domain history before treating it as one). A KB without
// the file must never break a command. A root whose config.yaml does not
// hold to its schema is no root: root resolution refuses it, every place
// named, so no command runs in one.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// projectFileYAML: the project file's name, below .semiont.
const projectFileYAML = "config.yaml"

type kbIdentity struct {
	Name     string // project.name
	SiteName string // site.siteName
	Domain   string // site.domain — did:web colon-path form
	// did is the DID Domain names (semiont.KbDid), read with it.
	did api.UserId
}

// kbRoot: a knowledge base's root as a command resolved it — its directory,
// and the identity its project file declared when the command read it, the
// once it does. The zero kbRoot is no knowledge base (a root-free service).
type kbRoot struct {
	dir   string
	ident *kbIdentity
}

// key names the root's state directory and custody (rootKey).
func (r kbRoot) key() string {
	if r.dir == "" {
		return ""
	}
	return rootKey(r.ident.didWeb(), r.dir)
}

// A nil *kbIdentity is a knowledge base that commits no project file: it has
// no identity, and its name is its directory's.

// didWeb renders the full did:web identifier, "" when there is no project
// file.
func (k *kbIdentity) didWeb() string {
	if k == nil {
		return ""
	}
	return k.did.String()
}

// domain is the KB's permanent did:web identity as its project file declares
// it, "" when there is none — never a fabricated one ('localhost', the dial
// address), which is how two knowledge bases end up sharing a did. Whatever
// needs an identity refuses its absence (served).
func (k *kbIdentity) domain() string {
	if k == nil {
		return ""
	}
	return k.Domain
}

// resource is the KB's resource identifier (semiont.KbResource), "" when
// there is no project file — the audience half of domain. It is the single value a
// token's `aud` must carry, derived from the KB's committed domain and never
// configured: it goes into the realm's audience mapper, and the gateway checks
// tokens against its own copy of the same rule.
func (k *kbIdentity) resource() string {
	if k == nil {
		return ""
	}
	return semiont.KbResource(k.Domain)
}

// name is the name the Archivist computes for the knowledge base at root: the
// committed project.name, else the directory basename when there is no project
// file (docs/protocol/ARCHIVIST.md). The launcher writes it as `kb.name` into
// each document that names the knowledge base (served).
func (k *kbIdentity) name(root string) string {
	if k == nil {
		return filepath.Base(root)
	}
	return k.Name
}

// served: the knowledge base as a service's document names the one it serves
// (KbIdentity): the one source of every document's `kb`. A knowledge base
// that declares no domain has no identity for a service to run under, and is
// refused.
func (r kbRoot) served() (api.KbIdentity, error) {
	domain := r.ident.domain()
	if domain == "" {
		return api.KbIdentity{}, fmt.Errorf("the knowledge base declares no site.domain in its .semiont/config.yaml: its services have no identity to run under")
	}
	return api.KbIdentity{Name: r.ident.name(r.dir), Domain: domain}, nil
}

// readKBIdentity reads <root>'s project file: nil when there is none. One
// that cannot be read, or does not hold to ProjectConfig's schema, is refused.
// It is the one reader of the file: a command reads it once, when it resolves
// its root, and carries what it read.
func readKBIdentity(root string) (*kbIdentity, error) {
	path := filepath.Join(root, ".semiont", projectFileYAML)
	text, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return yamlKBIdentity(path, text)
}

// refusedProjectFile: root resolution's refusal of a root whose project file
// cannot be read or does not hold to its schema, as against its finding no
// root.
type refusedProjectFile struct{ error }

func (r refusedProjectFile) Unwrap() error { return r.error }

// holdProjectFile reads root's identity, refusing root when its config.yaml
// cannot be read or does not hold to its schema, naming each place. Root
// resolution is where a command reads its identity, the once it does.
func holdProjectFile(root string) (*kbIdentity, error) {
	identity, err := readKBIdentity(root)
	if err != nil {
		return nil, refusedProjectFile{err}
	}
	return identity, nil
}

// projectFileRefused: whether err is holdProjectFile's refusal, which no
// caller reads as "not inside a knowledge base".
func projectFileRefused(err error) bool {
	var refused refusedProjectFile
	return errors.As(err, &refused)
}

// yamlKBIdentity reads a config.yaml already in hand — the codespace path gets
// these bytes over ssh rather than off this disk, and must read them
// identically — refusing one that does not hold to its schema.
func yamlKBIdentity(where string, text []byte) (*kbIdentity, error) {
	project, err := stack.Parse[stack.ProjectConfig](where, "ProjectConfig", text)
	if err != nil {
		return nil, err
	}
	did, err := semiont.KbDid(project.Site.Domain)
	if err != nil {
		return nil, fmt.Errorf("%s: site.domain %q names no DID: %w", where, project.Site.Domain, err)
	}
	return &kbIdentity{Name: project.Project.Name, SiteName: project.Site.SiteName, Domain: project.Site.Domain, did: did}, nil
}
