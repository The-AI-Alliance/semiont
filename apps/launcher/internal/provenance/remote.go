package provenance

import (
	"net/http"

	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/tuf"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// publicGood: the evidence a signature from Sigstore's public instance
// carries, each at least once — the certificate's timestamp from a
// certificate transparency log, the attestation's entry in Rekor, and a time
// observed by the log, at which the short-lived certificate was valid. GitHub
// signs a public repository's attestations there.
var publicGood = []verify.VerifierOption{
	verify.WithSignedCertificateTimestamps(1),
	verify.WithTransparencyLog(1),
	verify.WithObserverTimestamps(1),
}

// NewRemote: the Verifier a released launcher runs — each image's own
// registry, asked through client, and Sigstore's public trusted root, read
// through TUF and kept in cacheDir until its metadata expires.
func NewRemote(client *http.Client, cacheDir string) Verifier {
	return sigstoreVerifier{remote{registry: registry{client: client}, cacheDir: cacheDir}}
}

type remote struct {
	registry
	cacheDir string
}

func (r remote) trustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
	trusted, err := root.FetchTrustedRootWithOptions(tuf.DefaultOptions().WithCachePath(r.cacheDir).WithForceCache())
	if err != nil {
		return nil, nil, err
	}
	return trusted, publicGood, nil
}
