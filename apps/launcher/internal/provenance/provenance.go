// Package provenance decides whether an image is one a given workflow built:
// the image's digest, an attestation of that digest, and a signature over the
// attestation that a trusted root vouches for.
//
// It is the launcher's one boundary around Sigstore. The launcher names an
// image and who may have built it, and gets back the digest that is to run or
// a refusal saying why; no Sigstore type crosses into the launcher.
package provenance

import (
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// BuildProvenance: the predicate an attestation carries when it says how an
// image was built (SLSA provenance v1, as GitHub's attest-build-provenance
// writes it). An attestation of anything else, a bill of materials say, does
// not say who built the image.
const BuildProvenance = "https://slsa.dev/provenance/v1"

// Signer: who may have built an image — the OIDC issuer the signing
// certificate names, and a regular expression its subject alternative name
// must match (for GitHub Actions, the workflow and the ref it ran at).
type Signer struct {
	Issuer   string
	Identity string
}

// githubActions: the issuer of every certificate GitHub Actions signs with.
const githubActions = "https://token.actions.githubusercontent.com"

// SemiontRelease: a Semiont release, as the signer of an image — workflow, a
// workflow file of The-AI-Alliance/semiont, run by GitHub Actions at a
// release tag (refs/tags/v…). An image built from a branch, or by any other
// workflow or repository, is not one.
func SemiontRelease(workflow string) Signer {
	return Signer{
		Issuer:   githubActions,
		Identity: `^https://github\.com/The-AI-Alliance/semiont/\.github/workflows/` + regexp.QuoteMeta(workflow) + `@refs/tags/v[^/]+$`,
	}
}

// Source: where verification reads what it needs. Digest resolves an image to
// the digest of the bytes it names; Attestations are what was signed about a
// digest; TrustedMaterial is what the signatures are checked against, with
// how many of each kind of evidence a signature must carry.
type Source interface {
	Digest(image string) (string, error)
	Attestations(image, digest string) ([]verify.SignedEntity, error)
	TrustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error)
}

// ErrNoAttestation: the source holds nothing signed about the digest.
var ErrNoAttestation = errors.New("no attestation of it")

// Verify resolves image to its digest and returns the digest when one of its
// attestations is build provenance of exactly that digest, signed by signer
// and vouched for by the source's trusted material. Every refusal names the
// image, the digest when it is known, and why each attestation failed.
func Verify(src Source, image string, signer Signer) (string, error) {
	digest, err := src.Digest(image)
	if err != nil {
		return "", fmt.Errorf("%s: %w", image, err)
	}
	algorithm, hexDigest, ok := strings.Cut(digest, ":")
	raw, decodeErr := hex.DecodeString(hexDigest)
	if !ok || algorithm != "sha256" || decodeErr != nil || len(raw) != 32 {
		return "", fmt.Errorf("%s: %q is not a sha256 digest", image, digest)
	}
	entities, err := src.Attestations(image, digest)
	if err != nil {
		return "", fmt.Errorf("%s (%s): %w", image, digest, err)
	}
	if len(entities) == 0 {
		return "", fmt.Errorf("%s (%s): %w", image, digest, ErrNoAttestation)
	}
	trusted, options, err := src.TrustedMaterial()
	if err != nil {
		return "", fmt.Errorf("%s: the trusted root: %w", image, err)
	}
	verifier, err := verify.NewVerifier(trusted, options...)
	if err != nil {
		return "", fmt.Errorf("%s: a verifier: %w", image, err)
	}
	identity, err := verify.NewShortCertificateIdentity(signer.Issuer, "", "", signer.Identity)
	if err != nil {
		return "", fmt.Errorf("%s: the signer %q: %w", image, signer.Identity, err)
	}
	policy := verify.NewPolicy(verify.WithArtifactDigest("sha256", raw), verify.WithCertificateIdentity(identity))
	var reasons []string
	for i, entity := range entities {
		result, err := verifier.Verify(entity, policy)
		switch {
		case err != nil:
			reasons = append(reasons, fmt.Sprintf("attestation %d: %v", i+1, err))
		case result.Statement == nil || result.Statement.GetPredicateType() != BuildProvenance:
			reasons = append(reasons, fmt.Sprintf("attestation %d is not build provenance (%s)", i+1, predicateOf(result)))
		default:
			return digest, nil
		}
	}
	return "", fmt.Errorf("%s (%s): none of its %d attestations is build provenance signed by %s: %s",
		image, digest, len(entities), signer.Identity, strings.Join(reasons, "; "))
}

func predicateOf(result *verify.VerificationResult) string {
	if result.Statement == nil {
		return "no statement"
	}
	return result.Statement.GetPredicateType()
}
