//go:build fakesigstore

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

// FakeFile: the file, in the directory NewFake is given, that says what each
// image's attestation is in a launcher built for the scenario suite. An image
// it does not name is attested as a Semiont release built it.
const FakeFile = "fake-sigstore.json"

// FakeAttestation: what a scenario says one image's attestation is. Absent is
// an image with no attestation at all; Identity is the subject alternative
// name of the certificate that signed it; Subject, when set, is the digest
// the attestation is about in place of the image's own; Predicate, when set,
// replaces build provenance.
type FakeAttestation struct {
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

// NewFake: the source a launcher built with `-tags fakesigstore` verifies
// with, reading FakeFile in dir.
func NewFake(dir string) Source {
	return &fake{dir: dir}
}

func (f *fake) authority() (*ca.VirtualSigstore, error) {
	f.once.Do(func() { f.ca, f.caErr = ca.NewVirtualSigstore() })
	return f.ca, f.caErr
}

func (f *fake) Digest(image string) (string, error) {
	name, digest, _ := strings.Cut(image, "@")
	if digest != "" {
		return digest, nil
	}
	sum := sha256.Sum256([]byte(name))
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func (f *fake) Attestations(image, digest string) ([]verify.SignedEntity, error) {
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
	predicate := BuildProvenance
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

func (f *fake) TrustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
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
func (f *fake) said(image string) (FakeAttestation, error) {
	name, _, _ := strings.Cut(image, "@")
	b, err := os.ReadFile(filepath.Join(f.dir, FakeFile))
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return FakeAttestation{}, err
	default:
		var all map[string]FakeAttestation
		if err := json.Unmarshal(b, &all); err != nil {
			return FakeAttestation{}, fmt.Errorf("%s: %w", FakeFile, err)
		}
		if said, ok := all[name]; ok {
			return said, nil
		}
	}
	workflow := "publish-service-images.yml"
	if strings.Contains(name, "/semiont-browser:") {
		workflow = "publish-browser.yml"
	}
	return FakeAttestation{Identity: "https://github.com/The-AI-Alliance/semiont/.github/workflows/" + workflow + "@refs/tags/v0.7.0"}, nil
}
