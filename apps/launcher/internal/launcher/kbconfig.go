package launcher

// kbconfig.go — the read-side of a knowledge base's project file, its
// committed identity card: `.semiont/config.yaml` (ProjectConfig, in
// specs/src/kb-identity), or the TOML `.semiont/config` where a knowledge base
// still has that one. Its project name and version, git sync, and site —
// whose `domain` is the permanent did:web identity everything the KB mints is
// stamped with (a committed literal naming the repo, never a machine address;
// see the DID/site.domain history before treating it as one). The launcher
// consumes identity for DISPLAY and the roots registry best-effort: a KB
// without the file must never break a command. A start refuses a
// config.yaml that does not hold to its schema (checkProjectFile).

import (
	"os"
	"path/filepath"
	"strings"

	toml "github.com/pelletier/go-toml/v2"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// projectFileYAML and projectFileTOML: the project file, and the TOML one a
// knowledge base not yet converted still has. The first is read when it is
// there.
const (
	projectFileYAML = "config.yaml"
	projectFileTOML = "config"
)

type kbIdentity struct {
	Name     string // [project] name
	Version  string // [project] version
	SiteName string // [site] siteName
	Domain   string // [site] domain — did:web colon-path form
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
// config, "" when it declares no domain — the audience half of committedDomain.
func committedResource(root string) string {
	return kbResource(committedDomain(root))
}

// loadKBIdentity reads <root>'s project file. nil when it is absent, or does
// not read — identity is display metadata here, and a start refuses a
// config.yaml that does not hold (checkProjectFile).
func loadKBIdentity(root string) *kbIdentity {
	semiont := filepath.Join(root, ".semiont")
	if text, err := os.ReadFile(filepath.Join(semiont, projectFileYAML)); err == nil {
		return yamlKBIdentity(filepath.Join(semiont, projectFileYAML), text)
	}
	b, err := os.ReadFile(filepath.Join(semiont, projectFileTOML))
	if err != nil {
		return nil
	}
	return tomlKBIdentity(b)
}

// checkProjectFile refuses <root>'s .semiont/config.yaml when it is there and
// does not hold to ProjectConfig's schema, naming each place it does not.
func checkProjectFile(root string) error {
	path := filepath.Join(root, ".semiont", projectFileYAML)
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	_, err := stack.Read[stack.ProjectConfig](path, "ProjectConfig")
	return err
}

// yamlKBIdentity reads a config.yaml already in hand. nil when it does not
// hold to its schema.
func yamlKBIdentity(where string, text []byte) *kbIdentity {
	project, err := stack.Parse[stack.ProjectConfig](where, "ProjectConfig", text)
	if err != nil {
		return nil
	}
	identity := &kbIdentity{Name: project.Project.Name, SiteName: project.Site.SiteName, Domain: project.Site.Domain}
	if project.Project.Version != nil {
		identity.Version = *project.Project.Version
	}
	return identity
}

// effectiveKBName is the name the Archivist computes for this root: the
// committed [project] name when declared, else the directory basename
// (docs/protocol/ARCHIVIST.md). The launcher writes it into the gateway's
// document as `kb.name`.
func effectiveKBName(root string) string {
	if id := loadKBIdentity(root); id != nil && id.Name != "" {
		return id.Name
	}
	return filepath.Base(root)
}

// tomlKBIdentity reads the TOML project file already in hand — the
// codespace path gets these bytes over ssh rather than off this disk, and
// must interpret them identically.
func tomlKBIdentity(b []byte) *kbIdentity {
	var raw struct {
		Project struct {
			Name    string `toml:"name"`
			Version string `toml:"version"`
		} `toml:"project"`
		Site struct {
			Domain   string `toml:"domain"`
			SiteName string `toml:"siteName"`
		} `toml:"site"`
	}
	if toml.Unmarshal(b, &raw) != nil {
		return nil
	}
	return &kbIdentity{
		Name:     raw.Project.Name,
		Version:  raw.Project.Version,
		SiteName: raw.Site.SiteName,
		Domain:   raw.Site.Domain,
	}
}

// committedDomain is the KB's permanent did:web identity as its own config
// declares it, "" when it declares none. The launcher stages this into the
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
