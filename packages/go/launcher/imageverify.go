package launcher

import (
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/provenance"
)

// semiontWorkflow: the workflow of The-AI-Alliance/semiont that builds and
// attests a service's image — the Browser's own, and one for every other.
func semiontWorkflow(svc string) string {
	if svc == "browser" {
		return "publish-browser.yml"
	}
	return "publish-service-images.yml"
}

// semiontRelease: the release that builds a service's image.
func semiontRelease(svc string) provenance.Release {
	return provenance.Release{Repository: "The-AI-Alliance/semiont", Workflow: semiontWorkflow(svc)}
}

// pinnedImage: img as it runs once verified, by the digest its attestation is
// of, the tag kept for a reader. An image its document already pins is run
// as it is.
func pinnedImage(img, digest string) string {
	if strings.Contains(img, "@") {
		return img
	}
	return img + "@" + digest
}

// verifyStackImages verifies the image of each of svcs before anything of the
// stack is touched, and pins each in the plan to the digest that runs, so
// every later pull, run and record reads the verified one. An image built on
// this machine runs as it is, and is named in the start's warning. false: an
// image was refused, and nothing has been torn down.
func verifyStackImages(x executor, fc flowCtx, svcs []string) bool {
	var local []string
	verified := 0
	for _, svc := range svcs {
		img := fc.plan.Images[svc]
		if locallyBuilt(img) {
			local = append(local, img)
			continue
		}
		pinned, ok := x.verifyImage(svc, img)
		if !ok {
			return false
		}
		fc.plan.Images[svc] = pinned
		verified++
	}
	if verified > 0 {
		x.say(sayOK, "Images verified %s", x.dim("(each built and signed by a Semiont release; each runs by its digest)"))
	}
	warnUnverified(x, local)
	return true
}

// warnUnverified: every start that runs an image built on this machine says
// so. No release built it, so nothing vouches for it.
func warnUnverified(x executor, images []string) {
	if len(images) == 0 {
		return
	}
	x.say(sayWarn, "Unverified: %s — built on this machine (:local), not by a Semiont release. For development only.", strings.Join(images, ", "))
	x.note("unverified: %s — built on this machine (:local) and never pulled; for development only", strings.Join(images, ", "))
}
