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

// semiont: a release of Semiont's, by workflow.
func semiont(workflow string) Release {
	return Release{Repository: "The-AI-Alliance/semiont", Workflow: workflow}
}

// saved: a source that is what the registry and TUF served, read from
// testdata, so the checks a released launcher makes run on a real
// attestation with no network.
type saved struct {
	digestOf string
	bundles  []string
}

func (s saved) digest(string) (string, error) { return s.digestOf, nil }

func (s saved) attestations(string, string) ([]verify.SignedEntity, error) {
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

func (s saved) trustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
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

func released() Verifier { return sigstoreVerifier{saved{gatewayDigest, []string{gatewayBundle}}} }

func TestTheReleasedGatewayIsASemiontRelease(t *testing.T) {
	digest, err := released().Verify(gatewayImage, semiont("publish-service-images.yml"))
	if err != nil {
		t.Fatalf("the gateway 0.7.0 released is refused: %v", err)
	}
	if digest != gatewayDigest {
		t.Errorf("verified %s, want the image's own digest %s", digest, gatewayDigest)
	}
}

// The same real attestation, held to what it does not say.
func TestTheReleasedGatewayIsRefusedForWhatItIsNot(t *testing.T) {
	release := signerOf(semiont("publish-service-images.yml"))
	for _, c := range []struct {
		name   string
		digest string
		signer signer
	}{
		{"another workflow's release", gatewayDigest, signerOf(semiont("publish-browser.yml"))},
		{"another repository's release", gatewayDigest, signerOf(Release{Repository: "someone/semiont", Workflow: "publish-service-images.yml"})},
		{"another image's digest", "sha256:" + strings.Repeat("0", 64), release},
		{"another issuer", gatewayDigest, signer{issuer: "https://accounts.google.com", identity: release.identity, what: "Google's"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if digest, err := verifyWith(saved{c.digest, []string{gatewayBundle}}, gatewayImage, c.signer); err == nil {
				t.Fatalf("verified %s", digest)
			} else if !strings.Contains(err.Error(), gatewayImage) {
				t.Errorf("the refusal does not name the image: %v", err)
			}
		})
	}
}

// Every Verifier the interface keeps in view refuses an image no release
// built; the Refuser refuses a release's too.
func TestNoVerifierAcceptsWhatNoReleaseBuilt(t *testing.T) {
	for name, v := range map[string]Verifier{"sigstore": released(), "refuser": Refuser{}} {
		if digest, err := v.Verify(gatewayImage, semiont("publish-browser.yml")); err == nil {
			t.Errorf("%s verified the services' image as the Browser's release: %s", name, digest)
		}
	}
	if _, err := (Refuser{}).Verify(gatewayImage, semiont("publish-service-images.yml")); !errors.Is(err, ErrUnverifiable) {
		t.Errorf("the Refuser said %v of a release's image, want ErrUnverifiable", err)
	}
}

// authority: an attestation made and checked by Sigstore's test authority,
// for what no real attestation of ours says — a build from a branch, from a
// fork, a predicate that is not provenance.
type authority struct {
	ca       *ca.VirtualSigstore
	digestOf string
	entities []verify.SignedEntity
}

func newAuthority(t *testing.T) *authority {
	t.Helper()
	vs, err := ca.NewVirtualSigstore()
	if err != nil {
		t.Fatal(err)
	}
	return &authority{ca: vs, digestOf: "sha256:" + strings.Repeat("ab", 32)}
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

func (a *authority) digest(string) (string, error) { return a.digestOf, nil }
func (a *authority) attestations(string, string) ([]verify.SignedEntity, error) {
	return a.entities, nil
}
func (a *authority) trustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
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
			a.attest(t, c.identity, buildProvenance, a.digestOf)
			digest, err := sigstoreVerifier{a}.Verify(gatewayImage, semiont("publish-service-images.yml"))
			if c.accepted && (err != nil || digest != a.digestOf) {
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
	check := func(a *authority) error {
		_, err := sigstoreVerifier{a}.Verify(gatewayImage, semiont("publish-service-images.yml"))
		return err
	}
	t.Run("a bill of materials is not provenance", func(t *testing.T) {
		a := newAuthority(t)
		a.attest(t, release, "https://spdx.dev/Document/v2.3", a.digestOf)
		if err := check(a); err == nil || !strings.Contains(err.Error(), "not build provenance") {
			t.Fatalf("want a refusal naming the predicate, got %v", err)
		}
	})
	t.Run("provenance of another digest", func(t *testing.T) {
		a := newAuthority(t)
		a.attest(t, release, buildProvenance, "sha256:"+strings.Repeat("cd", 32))
		if err := check(a); err == nil {
			t.Fatal("provenance of another image verified this one")
		}
	})
	t.Run("one good attestation among others", func(t *testing.T) {
		a := newAuthority(t)
		a.attest(t, release, "https://spdx.dev/Document/v2.3", a.digestOf)
		a.attest(t, release, buildProvenance, a.digestOf)
		if err := check(a); err != nil {
			t.Fatalf("refused: %v", err)
		}
	})
	t.Run("no attestation at all", func(t *testing.T) {
		if err := check(newAuthority(t)); !errors.Is(err, errNoAttestation) {
			t.Fatalf("want errNoAttestation, got %v", err)
		}
	})
}
