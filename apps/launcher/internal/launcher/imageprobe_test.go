package launcher

import (
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/images"
)

// FAKE-RUNTIME-FIDELITY P2. The launcher's health probe for one of Semiont's
// own services is a MIRROR of that service's image, which declares the same
// route twice — as the HEALTHCHECK the container runtime runs, and as the
// SUPERVISE_PROBE its entrypoint watches.
//
// Nothing checked it. Eight images, eight probes, agreeing by hand — and the
// suite could not have noticed them disagreeing, because the fake answered
// 200 to every path on every port.
//
// The image is what actually runs, so the image wins any disagreement. That
// is the whole of what this test says.
func TestLauncherProbesWhatTheImageDeclares(t *testing.T) {
	// internal/launcher → internal → apps/launcher → apps → the repo.
	const root = "../../../.."
	check := func(role, want string) {
		t.Helper()
		if got := healthEndpoint(role, driverSemiont, nil); got != want {
			t.Errorf("%s: the launcher probes %s, the image declares %s — one of them is wrong and only the image is running",
				role, got, want)
		}
	}
	for _, role := range stackServices {
		u, err := images.HealthURL(root, role)
		if err != nil {
			t.Errorf("%v", err)
			continue
		}
		check(role, u)
	}
	// The Browser is not a stack service, so it is not in stackServices. Its
	// image declares a bare root path; the launcher probes the same origin.
	u, err := images.HealthURL(root, "browser")
	if err != nil {
		t.Fatalf("%v", err)
	}
	check("browser", strings.TrimSuffix(u, "/"))
}
