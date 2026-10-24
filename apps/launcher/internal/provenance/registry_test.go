package provenance

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// registry: a registry serving the gateway's saved 0.7.0 files as ghcr does —
// a pull token asked for at its realm, the image's index under its tag and
// its digest, its attestations' index under the sha256-<hex> tag, and each
// attestation's manifest and bundle by digest. tamper, when set, changes
// what is served for a path.
func registry(t *testing.T, tamper func(path string, body []byte) []byte) (*httptest.Server, string) {
	t.Helper()
	dir := filepath.Join("testdata", "gateway-0.7.0")
	repo := "/v2/the-ai-alliance/semiont-gateway"
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			if r.URL.Query().Get("scope") != "repository:the-ai-alliance/semiont-gateway:pull" {
				http.Error(w, "wrong scope", http.StatusBadRequest)
				return
			}
			fmt.Fprint(w, `{"token":"pull-token"}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer pull-token" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="`+srv.URL+`/token",service="test"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, repo)
		file := ""
		switch {
		case path == "/manifests/latest" || path == "/manifests/"+gatewayDigest:
			file = "image.json"
			w.Header().Set("Docker-Content-Digest", gatewayDigest)
		case path == "/manifests/"+strings.Replace(gatewayDigest, ":", "-", 1):
			file = "referrers.json"
		case strings.HasPrefix(path, "/manifests/sha256:"), strings.HasPrefix(path, "/blobs/sha256:"):
			file = strings.Replace(strings.TrimPrefix(path, "/"), ":", "-", 1)
		}
		body, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(file)))
		if file == "" || err != nil {
			http.NotFound(w, r)
			return
		}
		if tamper != nil {
			body = tamper(path, body)
		}
		w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv, strings.TrimPrefix(srv.URL, "http://") + "/the-ai-alliance/semiont-gateway:latest"
}

// rooted: the registry, checked against the saved trusted root.
type rooted struct{ Registry }

func (rooted) TrustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
	return savedRoot()
}

func TestTheRegistryServesWhatVerifies(t *testing.T) {
	srv, image := registry(t, nil)
	digest, err := Verify(rooted{Registry{Client: srv.Client()}}, image, SemiontRelease("publish-service-images.yml"))
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	if digest != gatewayDigest {
		t.Errorf("verified %s, want %s", digest, gatewayDigest)
	}
}

func TestTheRegistryIsNotTakenAtItsWord(t *testing.T) {
	flip := func(b []byte) []byte {
		out := append([]byte{}, b...)
		out[len(out)/2] ^= 1
		return out
	}
	for _, c := range []struct {
		name, path string
		alter      func([]byte) []byte
		want       string
	}{
		{"a tampered bundle", "/blobs/sha256:2b81794cc31526b95d6869b5e667f64ab17f20ddd8b06dfd9005533c2ad2c688", flip, "hashes to"},
		{"a tampered attestation manifest", "/manifests/sha256:a3abb5bd5db29dd67a7904e38ae2a048a60ac34ac39f57ca7b24477ee70d5b6c", flip, "hashes to"},
		{"an index other than the one its digest names", "/manifests/latest", func(b []byte) []byte { return append(b, '\n') }, "hashes to"},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv, image := registry(t, func(path string, body []byte) []byte {
				if path == c.path {
					return c.alter(body)
				}
				return body
			})
			if digest, err := Verify(rooted{Registry{Client: srv.Client()}}, image, SemiontRelease("publish-service-images.yml")); err == nil {
				t.Fatalf("verified %s", digest)
			} else if !strings.Contains(err.Error(), c.want) {
				t.Errorf("want a refusal saying %q, got %v", c.want, err)
			}
		})
	}
}

func TestAnImageWithNoAttestationsTagHasNone(t *testing.T) {
	srv, image := registry(t, nil)
	r := Registry{Client: srv.Client()}
	if _, err := r.Attestations(image, "sha256:"+strings.Repeat("0", 64)); !errors.Is(err, ErrNoAttestation) {
		t.Fatalf("want ErrNoAttestation, got %v", err)
	}
}

func TestADigestInTheImageIsTheDigest(t *testing.T) {
	r := Registry{Client: &http.Client{Transport: refuseAll{}}}
	digest, err := r.Digest("ghcr.io/the-ai-alliance/semiont-gateway:latest@" + gatewayDigest)
	if err != nil || digest != gatewayDigest {
		t.Fatalf("got %q, %v: an image pinned by its digest needs no registry to name it", digest, err)
	}
}

type refuseAll struct{}

func (refuseAll) RoundTrip(r *http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("asked %s", r.URL)
}

func TestAReferenceNamesItsRegistry(t *testing.T) {
	for _, c := range []struct{ image, base, tag, digest string }{
		{"ghcr.io/the-ai-alliance/semiont-gateway:latest", "https://ghcr.io/v2/the-ai-alliance/semiont-gateway", "latest", ""},
		{"busybox:1.38.0", "https://registry-1.docker.io/v2/library/busybox", "1.38.0", ""},
		{"qdrant/qdrant:v1.19.1", "https://registry-1.docker.io/v2/qdrant/qdrant", "v1.19.1", ""},
		{"quay.io/keycloak/keycloak:26.7.4@sha256:" + strings.Repeat("1", 64), "https://quay.io/v2/keycloak/keycloak", "26.7.4", "sha256:" + strings.Repeat("1", 64)},
		{"localhost:5000/semiont-gateway:local", "http://localhost:5000/v2/semiont-gateway", "local", ""},
		{"registry.localhost/semiont-gateway:x", "http://registry.localhost/v2/semiont-gateway", "x", ""},
		{"127.0.0.1:5000/a/b:c", "http://127.0.0.1:5000/v2/a/b", "c", ""},
	} {
		ref, err := parseReference(c.image)
		if err != nil {
			t.Errorf("%s: %v", c.image, err)
			continue
		}
		if ref.base() != c.base || ref.tag != c.tag || ref.digest != c.digest {
			t.Errorf("%s: %s, tag %q, digest %q; want %s, %q, %q", c.image, ref.base(), ref.tag, ref.digest, c.base, c.tag, c.digest)
		}
	}
	if _, err := parseReference("ghcr.io/the-ai-alliance/semiont-gateway"); err == nil {
		t.Error("an image with neither tag nor digest was read as one")
	}
}
