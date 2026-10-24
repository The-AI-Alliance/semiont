package provenance

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// The media types a registry serves an image and its attestations as.
const (
	ociIndex          = "application/vnd.oci.image.index.v1+json"
	ociManifest       = "application/vnd.oci.image.manifest.v1+json"
	dockerList        = "application/vnd.docker.distribution.manifest.list.v2+json"
	dockerManifest    = "application/vnd.docker.distribution.manifest.v2+json"
	sigstoreBundleV03 = "application/vnd.dev.sigstore.bundle.v0.3+json"
)

// manifestAccept: every manifest form an image's tag can name. The digest is
// of the multi-platform index when there is one, which is what an
// attestation of a pushed image is made of.
var manifestAccept = strings.Join([]string{ociIndex, dockerList, ociManifest, dockerManifest}, ", ")

// maxDocument bounds every manifest and bundle read: each is a few kilobytes,
// and nothing a registry sends is read without a bound.
const maxDocument = 4 << 20

// registry reads an image's digest and its attestations from the registry the
// image names, over the distribution API, anonymously. A registry on this
// machine (localhost, a *.localhost name, a loopback address) is spoken to
// over plain HTTP, as every runtime does; any other over HTTPS.
type registry struct {
	client *http.Client
}

// reference: an image as a registry is asked about it.
type reference struct {
	host, repository, tag, digest string
}

// parseReference splits an image into the registry that holds it, the
// repository, and its tag or digest. A name with no registry is Docker Hub's,
// and a one-part name is in Hub's library.
func parseReference(image string) (reference, error) {
	name, digest, _ := strings.Cut(image, "@")
	first, rest, hasSlash := strings.Cut(name, "/")
	ref := reference{digest: digest}
	if hasSlash && (strings.ContainsAny(first, ".:") || first == "localhost") {
		ref.host, name = first, rest
	} else {
		ref.host = "registry-1.docker.io"
		if !hasSlash {
			name = "library/" + name
		}
	}
	slash := strings.LastIndex(name, "/")
	if colon := strings.LastIndex(name, ":"); colon > slash {
		ref.repository, ref.tag = name[:colon], name[colon+1:]
	} else {
		ref.repository = name
	}
	if ref.repository == "" || (ref.tag == "" && ref.digest == "") {
		return reference{}, fmt.Errorf("%q names no tag and no digest", image)
	}
	return ref, nil
}

func (r reference) base() string {
	scheme := "https"
	host := r.host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || net.ParseIP(host).IsLoopback() {
		scheme = "http"
	}
	return scheme + "://" + r.host + "/v2/" + r.repository
}

// digest: the digest of the bytes image names. A digest in the image is
// itself the answer; a tag is resolved by reading the manifest it names and
// hashing what was read, so the answer is never only the registry's word.
func (r registry) digest(image string) (string, error) {
	ref, err := parseReference(image)
	if err != nil {
		return "", err
	}
	if ref.digest != "" {
		return ref.digest, nil
	}
	body, header, err := r.get(ref, "/manifests/"+ref.tag, manifestAccept)
	if err != nil {
		return "", err
	}
	digest := sha256Digest(body)
	if said := header.Get("Docker-Content-Digest"); said != "" && said != digest {
		return "", fmt.Errorf("the registry says %s is %s, and what it sent hashes to %s", ref.tag, said, digest)
	}
	return digest, nil
}

// attestations: the Sigstore bundles the registry holds about digest. A
// registry without the referrers API holds them under the tag
// sha256-<hex> (the OCI referrers tag schema), as an index of artifact
// manifests whose one layer is the bundle; each manifest names digest as its
// subject.
func (r registry) attestations(image, digest string) ([]verify.SignedEntity, error) {
	ref, err := parseReference(image)
	if err != nil {
		return nil, err
	}
	body, _, err := r.get(ref, "/manifests/"+strings.Replace(digest, ":", "-", 1), ociIndex)
	if errors.Is(err, errNotFound) {
		return nil, errNoAttestation
	}
	if err != nil {
		return nil, err
	}
	var index struct {
		Manifests []struct {
			Digest       string `json:"digest"`
			ArtifactType string `json:"artifactType"`
		} `json:"manifests"`
	}
	if err := json.Unmarshal(body, &index); err != nil {
		return nil, fmt.Errorf("its attestations' index: %w", err)
	}
	var entities []verify.SignedEntity
	for _, m := range index.Manifests {
		if m.ArtifactType != sigstoreBundleV03 {
			continue
		}
		b, err := r.bundle(ref, m.Digest, digest)
		if err != nil {
			return nil, err
		}
		entities = append(entities, b)
	}
	return entities, nil
}

// bundle reads one artifact manifest and the bundle it holds, holding each to
// the digest it was asked for by.
func (r registry) bundle(ref reference, manifestDigest, subject string) (*bundle.Bundle, error) {
	body, _, err := r.get(ref, "/manifests/"+manifestDigest, ociManifest)
	if err != nil {
		return nil, err
	}
	if got := sha256Digest(body); got != manifestDigest {
		return nil, fmt.Errorf("attestation manifest %s hashes to %s", manifestDigest, got)
	}
	var manifest struct {
		Subject struct {
			Digest string `json:"digest"`
		} `json:"subject"`
		Layers []struct {
			MediaType string `json:"mediaType"`
			Digest    string `json:"digest"`
		} `json:"layers"`
	}
	if err := json.Unmarshal(body, &manifest); err != nil {
		return nil, fmt.Errorf("attestation manifest %s: %w", manifestDigest, err)
	}
	if manifest.Subject.Digest != subject {
		return nil, fmt.Errorf("attestation manifest %s is about %s, not %s", manifestDigest, manifest.Subject.Digest, subject)
	}
	for _, layer := range manifest.Layers {
		if layer.MediaType != sigstoreBundleV03 {
			continue
		}
		blob, _, err := r.get(ref, "/blobs/"+layer.Digest, "")
		if err != nil {
			return nil, err
		}
		if got := sha256Digest(blob); got != layer.Digest {
			return nil, fmt.Errorf("attestation bundle %s hashes to %s", layer.Digest, got)
		}
		var b bundle.Bundle
		if err := b.UnmarshalJSON(blob); err != nil {
			return nil, fmt.Errorf("attestation bundle %s: %w", layer.Digest, err)
		}
		return &b, nil
	}
	return nil, fmt.Errorf("attestation manifest %s holds no bundle", manifestDigest)
}

var errNotFound = errors.New("not found")

// get reads one document of ref's repository, answering a registry's bearer
// challenge with an anonymous token for pulling that repository.
func (r registry) get(ref reference, path, accept string) ([]byte, http.Header, error) {
	address := ref.base() + path
	resp, err := r.do(address, accept, "")
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		challenge := resp.Header.Get("WWW-Authenticate")
		resp.Body.Close()
		token, err := r.token(challenge, ref.repository)
		if err != nil {
			return nil, nil, err
		}
		if resp, err = r.do(address, accept, token); err != nil {
			return nil, nil, err
		}
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, nil, fmt.Errorf("%s: %w", address, errNotFound)
	case resp.StatusCode != http.StatusOK:
		return nil, nil, fmt.Errorf("%s: HTTP %d", address, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDocument+1))
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", address, err)
	}
	if len(body) > maxDocument {
		return nil, nil, fmt.Errorf("%s: larger than %d bytes", address, maxDocument)
	}
	return body, resp.Header, nil
}

func (r registry) do(address, accept, token string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return r.client.Do(req)
}

// token answers a `Bearer realm="…",service="…"` challenge with an anonymous
// pull token for repository.
func (r registry) token(challenge, repository string) (string, error) {
	params, ok := bearerChallenge(challenge)
	if !ok || params["realm"] == "" {
		return "", fmt.Errorf("the registry asks for credentials it does not offer anonymously (%q)", challenge)
	}
	q := url.Values{"scope": {"repository:" + repository + ":pull"}}
	if s := params["service"]; s != "" {
		q.Set("service", s)
	}
	realm, err := url.Parse(params["realm"])
	if err != nil {
		return "", fmt.Errorf("the registry's token realm %q: %w", params["realm"], err)
	}
	realm.RawQuery = q.Encode()
	resp, err := r.client.Get(realm.String())
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: HTTP %d", realm.Redacted(), resp.StatusCode)
	}
	var answer struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxDocument)).Decode(&answer); err != nil {
		return "", fmt.Errorf("%s: %w", realm.Redacted(), err)
	}
	if answer.Token != "" {
		return answer.Token, nil
	}
	if answer.AccessToken != "" {
		return answer.AccessToken, nil
	}
	return "", fmt.Errorf("%s answered with no token", realm.Redacted())
}

// bearerChallenge reads the parameters of a WWW-Authenticate Bearer challenge.
func bearerChallenge(header string) (map[string]string, bool) {
	scheme, rest, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return nil, false
	}
	params := map[string]string{}
	for rest != "" {
		rest = strings.TrimLeft(rest, " ,")
		key, after, ok := strings.Cut(rest, "=")
		if !ok {
			break
		}
		var value string
		if strings.HasPrefix(after, `"`) {
			end := strings.Index(after[1:], `"`)
			if end < 0 {
				return nil, false
			}
			value, rest = after[1:end+1], after[end+2:]
		} else {
			value, rest, _ = strings.Cut(after, ",")
		}
		params[strings.ToLower(strings.TrimSpace(key))] = value
	}
	return params, true
}

func sha256Digest(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}
