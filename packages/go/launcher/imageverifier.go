//go:build !scenario

package launcher

import (
	"net/http"
	"path/filepath"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/provenance"
)

// imageVerifier: what decides whether an image of Semiont's is a release's —
// the image's own registry, and Sigstore's public trusted root, kept under
// the launcher's data directory until its metadata expires.
func imageVerifier() provenance.Verifier {
	return provenance.NewRemote(&http.Client{Transport: launcherTransport, Timeout: 30 * time.Second}, filepath.Join(dataDir(), "sigstore"))
}
