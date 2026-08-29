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
