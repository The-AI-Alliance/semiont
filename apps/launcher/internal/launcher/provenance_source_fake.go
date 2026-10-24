//go:build fakesigstore

package launcher

import "github.com/The-AI-Alliance/semiont/apps/launcher/internal/provenance"

// imageProvenance, in a launcher built for the scenario suite (-tags
// fakesigstore): Sigstore's test authority, attesting each image as
// provenance.FakeFile in the data directory says. A released launcher has no
// such source, so nothing can tell it to trust anything else.
func imageProvenance() provenance.Source {
	return provenance.NewFake(dataDir())
}
