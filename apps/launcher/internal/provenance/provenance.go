// Package provenance decides whether an image is one a release built: the
// image's digest, an attestation of that digest, and a signature over the
// attestation that a trusted root vouches for.
//
// It is the launcher's one boundary around Sigstore. The launcher names an
// image and the release that should have built it, in its own terms
// (Release), and gets back the digest that is to run or a refusal saying
// why. Every Sigstore type stays inside this package.
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

// Release: who should have built an image — Workflow, a workflow file of
// Repository (owner/name on GitHub), run at a release tag (refs/tags/v…). An
// image built from a branch, or by any other workflow or repository, is not
// a release's.
type Release struct {
	Repository string
	Workflow   string
}

// Verifier decides whether image is one r built. It returns the digest of the
// bytes it verified, which is what is to run, or a refusal that names the
// image and why.
type Verifier interface {
	Verify(image string, r Release) (digest string, err error)
}

// Refuser: a Verifier that verifies nothing, and so refuses every image. The
// second implementation the interface keeps in view beside Sigstore's.
type Refuser struct{}

// ErrUnverifiable: what a Refuser says of every image.
var ErrUnverifiable = errors.New("this launcher verifies no image")

func (Refuser) Verify(image string, r Release) (string, error) {
	return "", fmt.Errorf("%s: %w", image, ErrUnverifiable)
}

// buildProvenance: the predicate an attestation carries when it says how an
// image was built (SLSA provenance v1, as GitHub's attest-build-provenance
// writes it). An attestation of anything else, a bill of materials say, does
// not say who built the image.
const buildProvenance = "https://slsa.dev/provenance/v1"

// githubActions: the issuer of every certificate GitHub Actions signs with.
const githubActions = "https://token.actions.githubusercontent.com"

// signer: a Release as Sigstore names who signed — the OIDC issuer the
// signing certificate names, and a regular expression its subject
// alternative name must match.
type signer struct {
	issuer, identity string
	// what: the release, as a refusal says it.
	what string
}

// signerOf: the certificate GitHub Actions issues to r's workflow run at a
// release tag.
func signerOf(r Release) signer {
	return signer{
		issuer: githubActions,
		identity: `^https://github\.com/` + regexp.QuoteMeta(r.Repository) + `/\.github/workflows/` +
			regexp.QuoteMeta(r.Workflow) + `@refs/tags/v[^/]+$`,
		what: r.Repository + "'s " + r.Workflow + " at a release tag",
	}
}

// source: where verification reads what it needs. digest resolves an image to
// the digest of the bytes it names; attestations are what was signed about a
// digest; trustedMaterial is what the signatures are checked against, with
// how many of each kind of evidence a signature must carry.
type source interface {
	digest(image string) (string, error)
	attestations(image, digest string) ([]verify.SignedEntity, error)
	trustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error)
}

// sigstoreVerifier: the Verifier that checks an image's attestations with
// sigstore-go, reading them from its source.
type sigstoreVerifier struct{ src source }

func (v sigstoreVerifier) Verify(image string, r Release) (string, error) {
	return verifyWith(v.src, image, signerOf(r))
}

// errNoAttestation: the source holds nothing signed about the digest.
var errNoAttestation = errors.New("no attestation of it")

// verifyWith resolves image to its digest and returns the digest when one of
// its attestations is build provenance of exactly that digest, signed by s
// and vouched for by the source's trusted material. Every refusal names the
// image, the digest when it is known, and why each attestation failed.
func verifyWith(src source, image string, s signer) (string, error) {
	digest, err := src.digest(image)
	if err != nil {
		return "", fmt.Errorf("%s: %w", image, err)
	}
	algorithm, hexDigest, ok := strings.Cut(digest, ":")
	raw, decodeErr := hex.DecodeString(hexDigest)
	if !ok || algorithm != "sha256" || decodeErr != nil || len(raw) != 32 {
		return "", fmt.Errorf("%s: %q is not a sha256 digest", image, digest)
	}
	entities, err := src.attestations(image, digest)
	if err != nil {
		return "", fmt.Errorf("%s (%s): %w", image, digest, err)
	}
	if len(entities) == 0 {
		return "", fmt.Errorf("%s (%s): %w", image, digest, errNoAttestation)
	}
	trusted, options, err := src.trustedMaterial()
	if err != nil {
		return "", fmt.Errorf("%s: the trusted root: %w", image, err)
	}
	verifier, err := verify.NewVerifier(trusted, options...)
	if err != nil {
		return "", fmt.Errorf("%s: a verifier: %w", image, err)
	}
	identity, err := verify.NewShortCertificateIdentity(s.issuer, "", "", s.identity)
	if err != nil {
		return "", fmt.Errorf("%s: the signer %q: %w", image, s.identity, err)
	}
	policy := verify.NewPolicy(verify.WithArtifactDigest("sha256", raw), verify.WithCertificateIdentity(identity))
	var reasons []string
	for i, entity := range entities {
		result, err := verifier.Verify(entity, policy)
		switch {
		case err != nil:
			reasons = append(reasons, fmt.Sprintf("attestation %d: %v", i+1, err))
		case result.Statement == nil || result.Statement.GetPredicateType() != buildProvenance:
			reasons = append(reasons, fmt.Sprintf("attestation %d is not build provenance (%s)", i+1, predicateOf(result)))
		default:
			return digest, nil
		}
	}
	return "", fmt.Errorf("%s (%s): none of its %d attestations is build provenance signed by %s: %s",
		image, digest, len(entities), s.what, strings.Join(reasons, "; "))
}

func predicateOf(result *verify.VerificationResult) string {
	if result.Statement == nil {
		return "no statement"
	}
	return result.Statement.GetPredicateType()
}
