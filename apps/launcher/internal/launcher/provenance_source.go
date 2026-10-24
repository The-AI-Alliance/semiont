//go:build !fakesigstore

package launcher

import (
	"net/http"
	"path/filepath"
	"time"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/provenance"
)

// imageProvenance: where a start reads what verifies an image of Semiont's —
// the image's own registry, and Sigstore's public trusted root, kept under
// the launcher's data directory until its metadata expires.
func imageProvenance() provenance.Source {
	return provenance.Remote{
		Registry: provenance.Registry{Client: &http.Client{Transport: launcherTransport, Timeout: 30 * time.Second}},
		CacheDir: filepath.Join(dataDir(), "sigstore"),
	}
}
