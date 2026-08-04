package launcher

// kbconfig.go — the read-side of `.semiont/config`, the KB's committed
// identity card: [project] name/version, [git] sync, and [site] — whose
// `domain` is the permanent did:web identity everything the KB mints is
// stamped with (a committed literal naming the repo, never a machine
// address; see the DID/site.domain history before treating it as one).
// The launcher consumes identity for DISPLAY, the roots registry, and — since
// PERSIST-ANCHORS P3 — for scoping the backend's state mounts, which is the
// one load-bearing use (see projectName). Best-effort otherwise: a KB without
// this file, or with a partial one, must never break a command.

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

// projectName is the KB's [project] name, "" when unknown. It scopes the
// backend's XDG state directories (`$XDG_STATE_HOME/semiont/{name}/…`), so
// unlike the rest of this file it IS load-bearing: a state mount built without
// it lands in the wrong directory. Callers must treat "" as "do not mount"
// rather than substituting a default.
func (k *kbIdentity) projectName() string {
	if k == nil {
		return ""
	}
	return k.Name
}
