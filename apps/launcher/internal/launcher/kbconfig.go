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
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// projectFileYAML: the project file's name, below .semiont.
const projectFileYAML = "config.yaml"

type kbIdentity struct {
	Name     string // project.name
	SiteName string // site.siteName
	Domain   string // site.domain — did:web colon-path form
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

// didWeb renders the full did:web identifier, "" when no domain is declared.
func (k *kbIdentity) didWeb() string {
	if k == nil || k.Domain == "" {
		return ""
	}
	return "did:web:" + k.Domain
}

// domain is the KB's permanent did:web identity as its project file declares
// it, "" when there is none. The launcher stages this into the services that
// describe the KB without mounting it; staging "" is deliberate — a consumer
// that needs an identity must refuse, and a fabricated one ('localhost', the
// dial address) is how two knowledge bases end up sharing a did.
func (k *kbIdentity) domain() string {
	if k == nil {
		return ""
	}
	return k.Domain
}

// resource is the KB's resource identifier, "" when it declares no domain —
// the audience half of domain.
func (k *kbIdentity) resource() string {
	return kbResource(k.domain())
}

// name is the name the Archivist computes for the knowledge base at root: the
// committed project.name, else the directory basename when there is no project
// file (docs/protocol/ARCHIVIST.md). The launcher writes it into the gateway's
// document as `kb.name`.
func (k *kbIdentity) name(root string) string {
	if k == nil {
		return filepath.Base(root)
	}
	return k.Name
}

// kbResource renders the KB's RESOURCE identifier: the did:web resolved to
// the https URL it names, which is the single value a token's `aud` must
// carry — an audience derived from the KB's committed domain, never
// configured. did:web turns the colon path into a slash path, so
// `did:web:example.github.io:my-kb` identifies
// `https://example.github.io/my-kb`.
//
// An identifier, not an address — nothing dereferences it, and a KB reached
// over http in local development still names itself by the https form. The
// TypeScript twin is `kbResource` in packages/core/src/did-utils.ts and the
// two MUST agree byte-for-byte: this value goes into the realm's audience
// mapper and the gateway checks tokens against its own copy, so a divergence
// refuses every token with nothing to point at.
func kbResource(domain string) string {
	if domain == "" {
		return ""
	}
	return "https://" + strings.ReplaceAll(domain, ":", "/")
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
	return &kbIdentity{Name: project.Project.Name, SiteName: project.Site.SiteName, Domain: project.Site.Domain}, nil
}
