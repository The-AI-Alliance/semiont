//go:build scenario

package provenance

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/testing/ca"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// fakeFile: the file, in the directory NewFake is given, that says what each
// image's attestation is in a launcher built for the scenario suite. An image
// it does not name is attested as a Semiont release built it.
const fakeFile = "fake-sigstore.json"

// fakeAttestation: what a scenario says one image's attestation is. Absent is
// an image with no attestation at all; Identity is the subject alternative
// name of the certificate that signed it; Subject, when set, is the digest
// the attestation is about in place of the image's own; Predicate, when set,
// replaces build provenance.
type fakeAttestation struct {
	Absent    bool   `json:"absent"`
	Identity  string `json:"identity"`
	Subject   string `json:"subject"`
	Predicate string `json:"predicate"`
}

// fake: Sigstore's own test authority, standing in for the registry and for
// the public trusted root. Each image's digest is the hash of its name; its
// attestation is signed on request by the authority, and checked against it.
type fake struct {
	dir   string
	once  sync.Once
	ca    *ca.VirtualSigstore
	caErr error
}

// NewFake: the Verifier a launcher built with `-tags scenario` runs —
// sigstore-go's checks, over what Sigstore's test authority signs as
// fake-sigstore.json in dir says. A released launcher has no such Verifier.
func NewFake(dir string) Verifier {
	return sigstoreVerifier{&fake{dir: dir}}
}

func (f *fake) authority() (*ca.VirtualSigstore, error) {
	f.once.Do(func() { f.ca, f.caErr = ca.NewVirtualSigstore() })
	return f.ca, f.caErr
}

func (f *fake) digest(image string) (string, error) {
	name, digest, _ := strings.Cut(image, "@")
	if digest != "" {
		return digest, nil
	}
	sum := sha256.Sum256([]byte(name))
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func (f *fake) attestations(image, digest string) ([]verify.SignedEntity, error) {
	said, err := f.said(image)
	if err != nil {
		return nil, err
	}
	if said.Absent {
		return nil, nil
	}
	subject := digest
	if said.Subject != "" {
		subject = said.Subject
	}
	predicate := buildProvenance
	if said.Predicate != "" {
		predicate = said.Predicate
	}
	_, hexDigest, _ := strings.Cut(subject, ":")
	statement, err := json.Marshal(map[string]any{
		"_type":         "https://in-toto.io/Statement/v1",
		"subject":       []map[string]any{{"name": image, "digest": map[string]string{"sha256": hexDigest}}},
		"predicateType": predicate,
		"predicate":     map[string]any{},
	})
	if err != nil {
		return nil, err
	}
	authority, err := f.authority()
	if err != nil {
		return nil, err
	}
	entity, err := authority.Attest(said.Identity, githubActions, statement)
	if err != nil {
		return nil, err
	}
	return []verify.SignedEntity{entity}, nil
}

func (f *fake) trustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
	authority, err := f.authority()
	if err != nil {
		return nil, nil, err
	}
	// The test authority logs every signature and times it, as the public
	// instance does; it runs no certificate transparency log.
	return authority, []verify.VerifierOption{verify.WithTransparencyLog(1), verify.WithObserverTimestamps(1)}, nil
}

// said: the scenario's word on image, else a Semiont release's attestation
// of it — the Browser's workflow for the Browser's image, the services'
// workflow for every other.
func (f *fake) said(image string) (fakeAttestation, error) {
	name, _, _ := strings.Cut(image, "@")
	b, err := os.ReadFile(filepath.Join(f.dir, fakeFile))
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return fakeAttestation{}, err
	default:
		var all map[string]fakeAttestation
		if err := json.Unmarshal(b, &all); err != nil {
			return fakeAttestation{}, fmt.Errorf("%s: %w", fakeFile, err)
		}
		if said, ok := all[name]; ok {
			return said, nil
		}
	}
	workflow := "publish-service-images.yml"
	if strings.Contains(name, "/semiont-browser:") {
		workflow = "publish-browser.yml"
	}
	return fakeAttestation{Identity: "https://github.com/The-AI-Alliance/semiont/.github/workflows/" + workflow + "@refs/tags/v0.7.0"}, nil
}
