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
	"strings"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// projectFileYAML: the project file's name, below .semiont.
const projectFileYAML = "config.yaml"

type kbIdentity struct {
	Name     string // project.name
	Version  string // project.version
	SiteName string // site.siteName
	Domain   string // site.domain — did:web colon-path form
}

// didWeb renders the full did:web identifier, "" when no domain is declared.
func (k *kbIdentity) didWeb() string {
	if k == nil || k.Domain == "" {
		return ""
	}
	return "did:web:" + k.Domain
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

// committedResource is the KB's resource identifier from its own committed
// project file, "" when it declares no domain — the audience half of
// committedDomain.
func committedResource(root string) string {
	return kbResource(committedDomain(root))
}

// readKBIdentity reads <root>'s project file: nil when there is none. One
// that cannot be read, or does not hold to ProjectConfig's schema, is refused.
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

// loadKBIdentity is readKBIdentity of a root already resolved, which root
// resolution has refused if its config.yaml does not hold, or of a root a
// listing names; there, a refused file reads as none. A command reads its
// identity by root many times over; P2's wiring reads it once.
func loadKBIdentity(root string) *kbIdentity {
	identity, err := readKBIdentity(root)
	if err != nil {
		return nil
	}
	return identity
}

// refusedProjectFile: root resolution's refusal of a root whose project file
// cannot be read or does not hold to its schema, or that still keeps a file
// its documents replaced, as against its finding no root.
type refusedProjectFile struct{ error }

func (r refusedProjectFile) Unwrap() error { return r.error }

// replacedFiles: what a knowledge base kept before its documents, and what
// keeps it now. A root still holding one is refused by name (D15): a launcher
// that read both would be two readers of one fact, and one that ignored the
// old file would leave its owner believing it is read.
var replacedFiles = []struct{ old, now string }{
	{".semiont/config", ".semiont/" + projectFileYAML},
	{".semiont/semiontconfig", stack.Dir + "/"},
}

// holdProjectFile refuses root when it keeps a file its documents replaced,
// or when its config.yaml cannot be read or does not hold to its schema,
// naming each place.
func holdProjectFile(root string) error {
	for _, replaced := range replacedFiles {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(replaced.old))); err == nil {
			return refusedProjectFile{fmt.Errorf("%s keeps %s, which no launcher reads any more: %s holds what it held (docs/operator/administration/CONFIGURATION.md). Write that, then delete %s",
				root, replaced.old, replaced.now, replaced.old)}
		}
	}
	if _, err := readKBIdentity(root); err != nil {
		return refusedProjectFile{err}
	}
	return nil
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
	identity := &kbIdentity{Name: project.Project.Name, SiteName: project.Site.SiteName, Domain: project.Site.Domain}
	if project.Project.Version != nil {
		identity.Version = *project.Project.Version
	}
	return identity, nil
}

// effectiveKBName is the name the Archivist computes for this root: the
// committed project.name, else the directory basename when there is no project
// file (docs/protocol/ARCHIVIST.md). The launcher writes it into the
// gateway's document as `kb.name`.
func effectiveKBName(root string) string {
	if id := loadKBIdentity(root); id != nil {
		return id.Name
	}
	return filepath.Base(root)
}

// committedDomain is the KB's permanent did:web identity as its own project
// file declares it, "" when there is none. The launcher stages this into the
// services that describe the KB without mounting it; staging "" is
// deliberate — a consumer that needs an identity must refuse, and a
// fabricated one ('localhost', the dial address) is how two knowledge bases
// end up sharing a did.
func committedDomain(root string) string {
	if id := loadKBIdentity(root); id != nil {
		return id.Domain
	}
	return ""
}
