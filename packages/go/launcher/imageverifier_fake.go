//go:build scenario

package launcher

import "github.com/The-AI-Alliance/semiont/packages/go/launcher/provenance"

// imageVerifier, in a launcher built for the scenario suite (-tags
// scenario): sigstore-go's checks over what Sigstore's test authority
// signs, as fake-sigstore.json in the data directory says. A released
// launcher has no such verifier, so nothing can tell it to trust anything
// else.
func imageVerifier() provenance.Verifier {
	return provenance.NewFake(dataDir())
}
