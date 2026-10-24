package provenance

import (
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

// Remote: the source a released launcher verifies with — the image's own
// registry, and Sigstore's public trusted root, read through TUF and kept in
// cacheDir until its metadata expires.
type Remote struct {
	Registry
	CacheDir string
}

func (r Remote) TrustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
	trusted, err := root.FetchTrustedRootWithOptions(tuf.DefaultOptions().WithCachePath(r.CacheDir).WithForceCache())
	if err != nil {
		return nil, nil, err
	}
	return trusted, publicGood, nil
}
