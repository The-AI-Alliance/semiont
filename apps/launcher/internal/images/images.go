// Package images reads what a Semiont service IMAGE declares about itself.
//
// The image is the thing that actually runs, so it owns these facts. Two
// readers take them from here rather than restating them:
//
//   - the launcher's probe table, gated against this (FAKE-RUNTIME-FIDELITY P2);
//   - the fake runtime, which serves exactly the route the image declares and
//     404s everything else (P1).
//
// The second reader is why this package may NOT read the launcher. A fake
// taught by the code under test agrees with it about a wrong route as
// happily as a right one — which is precisely how a suite stays green while
// every probe is aimed at nothing.
package images

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// probeURL matches the health URL a Dockerfile carries. It appears twice in
// each image, and must agree with itself: once as the HEALTHCHECK the
// container runtime runs, once as the SUPERVISE_PROBE the entrypoint watches.
var probeURL = regexp.MustCompile(`http://localhost:\d+[^"' )]*`)

// HealthURL returns the URL <root>/apps/<service>/Dockerfile declares, and
// fails when the image declares none or declares two that differ — an image
// telling the runtime and its own entrypoint different things is a defect
// before anybody reads it from here.
func HealthURL(root, service string) (string, error) {
	p := filepath.Join(root, "apps", service, "Dockerfile")
	b, err := os.ReadFile(p)
	if err != nil {
		return "", fmt.Errorf("%s declares no health route: %w", service, err)
	}
	seen := map[string]bool{}
	var found []string
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.Contains(line, "HEALTHCHECK") && !strings.Contains(line, "SUPERVISE_PROBE") &&
			!strings.Contains(line, "localhost:") {
			continue
		}
		for _, u := range probeURL.FindAllString(line, -1) {
			if !seen[u] {
				seen[u] = true
				found = append(found, u)
			}
		}
	}
	switch len(found) {
	case 0:
		return "", fmt.Errorf("%s/Dockerfile declares no health URL — the image tells the runtime nothing about whether it is up", service)
	case 1:
		return found[0], nil
	default:
		return "", fmt.Errorf("%s/Dockerfile declares %v — its HEALTHCHECK and its entrypoint probe disagree", service, found)
	}
}

// HealthPath is HealthURL's path, which is what a server matches on. "/" for
// an image whose probe names no path (the Browser's).
func HealthPath(root, service string) (string, error) {
	u, err := HealthURL(root, service)
	if err != nil {
		return "", err
	}
	_, rest, ok := strings.Cut(strings.TrimPrefix(u, "http://"), "/")
	if !ok || rest == "" {
		return "/", nil
	}
	return "/" + rest, nil
}
