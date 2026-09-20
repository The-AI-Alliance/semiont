package launcher

// kbconfig.go — the read-side of `.semiont/config`, the KB's committed
// identity card: [project] name/version, [git] sync, and [site] — whose
// `domain` is the permanent did:web identity everything the KB mints is
// stamped with (a committed literal naming the repo, never a machine
// address; see the DID/site.domain history before treating it as one).
// The launcher consumes identity for DISPLAY and the roots registry only —
// best-effort throughout: a KB without this file (or with a partial one)
// must never break a command.

import (
	"os"
	"path/filepath"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
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
// carry (EXTERNAL-IDENTITY). did:web turns the colon path into a slash path,
// so `did:web:example.github.io:my-kb` identifies
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

// loadKBIdentity reads <root>/.semiont/config. nil when absent or unreadable
// — identity is display metadata, not launch instructions.
func loadKBIdentity(root string) *kbIdentity {
	b, err := os.ReadFile(filepath.Join(root, ".semiont", "config"))
	if err != nil {
		return nil
	}
	return parseKBIdentity(b)
}

// effectiveKBName is the name a container's own reader would compute for
// this root: the committed [project] name when declared, else the directory
// basename — the same fallback SemiontProject.readName (packages/core/src/
// project.ts) applies. The staged [kb] name (SINGLE-KB-MOUNT D4) MUST agree
// with the name the Archivist derives from its /kb mount, or the Librarian
// composes a state path nobody writes to and reads an empty view store.
func effectiveKBName(root string) string {
	if id := loadKBIdentity(root); id != nil && id.Name != "" {
		return id.Name
	}
	return filepath.Base(root)
}

// parseKBIdentity is the same read with the file already in hand — the
// codespace path gets these bytes over ssh rather than off this disk, and
// must interpret them identically.
func parseKBIdentity(b []byte) *kbIdentity {
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
// services that describe the KB without mounting it (SINGLE-KB-MOUNT P5);
// staging "" is deliberate — a consumer that needs an identity must refuse,
// and a fabricated one ('localhost', the dial address) is how two knowledge
// bases end up sharing a did.
func committedDomain(root string) string {
	if id := loadKBIdentity(root); id != nil {
		return id.Domain
	}
	return ""
}
