package provenance

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/testing/ca"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// The gateway's image as 0.7.0 released it: its multi-platform index, and
// the build provenance GitHub signed for it, saved byte for byte from ghcr
// (testdata/gateway-0.7.0), with Sigstore's public trusted root as TUF served
// it (testdata/trusted_root.json). The saved index of its attestations lists
// only the provenance: the bill of materials beside it is half a megabyte,
// and says nothing about who built the image.
const (
	gatewayImage  = "ghcr.io/the-ai-alliance/semiont-gateway:latest"
	gatewayDigest = "sha256:853cf2b37c0df8065a405479f08451af84dd3a732194abebfeb6adced3d87cd3"
	gatewayBundle = "testdata/gateway-0.7.0/blobs/sha256-2b81794cc31526b95d6869b5e667f64ab17f20ddd8b06dfd9005533c2ad2c688"
)

// saved: a Source that is what the registry and TUF served, read from
// testdata, so the checks a released launcher makes run on a real
// attestation with no network.
type saved struct {
	digest  string
	bundles []string
}

func (s saved) Digest(string) (string, error) { return s.digest, nil }

func (s saved) Attestations(string, string) ([]verify.SignedEntity, error) {
	var entities []verify.SignedEntity
	for _, path := range s.bundles {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var parsed bundle.Bundle
		if err := parsed.UnmarshalJSON(b); err != nil {
			return nil, err
		}
		entities = append(entities, &parsed)
	}
	return entities, nil
}

func (s saved) TrustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
	return savedRoot()
}

func savedRoot() (root.TrustedMaterial, []verify.VerifierOption, error) {
	b, err := os.ReadFile(filepath.Join("testdata", "trusted_root.json"))
	if err != nil {
		return nil, nil, err
	}
	trusted, err := root.NewTrustedRootFromJSON(b)
	return trusted, publicGood, err
}

func TestTheReleasedGatewayIsASemiontRelease(t *testing.T) {
	digest, err := Verify(saved{gatewayDigest, []string{gatewayBundle}}, gatewayImage, SemiontRelease("publish-service-images.yml"))
	if err != nil {
		t.Fatalf("the gateway 0.7.0 released is refused: %v", err)
	}
	if digest != gatewayDigest {
		t.Errorf("verified %s, want the image's own digest %s", digest, gatewayDigest)
	}
}

// The same real attestation, held to what it does not say.
func TestTheReleasedGatewayIsRefusedForWhatItIsNot(t *testing.T) {
	for _, c := range []struct {
		name   string
		digest string
		signer Signer
	}{
		{"another workflow's release", gatewayDigest, SemiontRelease("publish-browser.yml")},
		{"another image's digest", "sha256:" + strings.Repeat("0", 64), SemiontRelease("publish-service-images.yml")},
		{"another issuer", gatewayDigest, Signer{Issuer: "https://accounts.google.com", Identity: SemiontRelease("publish-service-images.yml").Identity}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if digest, err := Verify(saved{c.digest, []string{gatewayBundle}}, gatewayImage, c.signer); err == nil {
				t.Fatalf("verified %s", digest)
			} else if !strings.Contains(err.Error(), gatewayImage) {
				t.Errorf("the refusal does not name the image: %v", err)
			}
		})
	}
}

// authority: an attestation made and checked by Sigstore's test authority,
// for what no real attestation of ours says — a build from a branch, from a
// fork, a predicate that is not provenance.
type authority struct {
	ca       *ca.VirtualSigstore
	digest   string
	entities []verify.SignedEntity
}

func newAuthority(t *testing.T) *authority {
	t.Helper()
	vs, err := ca.NewVirtualSigstore()
	if err != nil {
		t.Fatal(err)
	}
	return &authority{ca: vs, digest: "sha256:" + strings.Repeat("ab", 32)}
}

func (a *authority) attest(t *testing.T, identity, predicate, subject string) {
	t.Helper()
	statement, err := json.Marshal(map[string]any{
		"_type":         "https://in-toto.io/Statement/v1",
		"subject":       []map[string]any{{"name": gatewayImage, "digest": map[string]string{"sha256": strings.TrimPrefix(subject, "sha256:")}}},
		"predicateType": predicate,
		"predicate":     map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	entity, err := a.ca.Attest(identity, githubActions, statement)
	if err != nil {
		t.Fatal(err)
	}
	a.entities = append(a.entities, entity)
}

func (a *authority) Digest(string) (string, error) { return a.digest, nil }
func (a *authority) Attestations(string, string) ([]verify.SignedEntity, error) {
	return a.entities, nil
}
func (a *authority) TrustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
	return a.ca, []verify.VerifierOption{verify.WithTransparencyLog(1), verify.WithObserverTimestamps(1)}, nil
}

const servicesWorkflow = "https://github.com/The-AI-Alliance/semiont/.github/workflows/publish-service-images.yml"

func TestAReleaseIsSignedAtAReleaseTag(t *testing.T) {
	for _, c := range []struct {
		name, identity string
		accepted       bool
	}{
		{"at a release tag", servicesWorkflow + "@refs/tags/v0.7.0", true},
		{"from main", servicesWorkflow + "@refs/heads/main", false},
		{"from a branch named like a tag", servicesWorkflow + "@refs/heads/refs/tags/v0.7.0", false},
		{"at a tag that is not a release", servicesWorkflow + "@refs/tags/nightly", false},
		{"from a fork", "https://github.com/someone/semiont/.github/workflows/publish-service-images.yml@refs/tags/v0.7.0", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := newAuthority(t)
			a.attest(t, c.identity, BuildProvenance, a.digest)
			digest, err := Verify(a, gatewayImage, SemiontRelease("publish-service-images.yml"))
			if c.accepted && (err != nil || digest != a.digest) {
				t.Fatalf("refused: %v", err)
			}
			if !c.accepted && err == nil {
				t.Fatalf("an image signed by %s was verified", c.identity)
			}
		})
	}
}

func TestOnlyBuildProvenanceOfTheDigestVerifies(t *testing.T) {
	release := servicesWorkflow + "@refs/tags/v0.7.0"
	t.Run("a bill of materials is not provenance", func(t *testing.T) {
		a := newAuthority(t)
		a.attest(t, release, "https://spdx.dev/Document/v2.3", a.digest)
		if _, err := Verify(a, gatewayImage, SemiontRelease("publish-service-images.yml")); err == nil || !strings.Contains(err.Error(), "not build provenance") {
			t.Fatalf("want a refusal naming the predicate, got %v", err)
		}
	})
	t.Run("provenance of another digest", func(t *testing.T) {
		a := newAuthority(t)
		a.attest(t, release, BuildProvenance, "sha256:"+strings.Repeat("cd", 32))
		if _, err := Verify(a, gatewayImage, SemiontRelease("publish-service-images.yml")); err == nil {
			t.Fatal("provenance of another image verified this one")
		}
	})
	t.Run("one good attestation among others", func(t *testing.T) {
		a := newAuthority(t)
		a.attest(t, release, "https://spdx.dev/Document/v2.3", a.digest)
		a.attest(t, release, BuildProvenance, a.digest)
		if _, err := Verify(a, gatewayImage, SemiontRelease("publish-service-images.yml")); err != nil {
			t.Fatalf("refused: %v", err)
		}
	})
	t.Run("no attestation at all", func(t *testing.T) {
		if _, err := Verify(newAuthority(t), gatewayImage, SemiontRelease("publish-service-images.yml")); !errors.Is(err, ErrNoAttestation) {
			t.Fatalf("want ErrNoAttestation, got %v", err)
		}
	})
}
