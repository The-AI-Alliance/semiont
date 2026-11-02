package launcher

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// workflowsDir: the repository's GitHub Actions workflows, from this
// package's directory.
var workflowsDir = filepath.Join("..", "..", "..", ".github", "workflows")

// actionsWorkflow: what a workflow file says about what its jobs attest.
type actionsWorkflow struct {
	Jobs map[string]struct {
		Strategy struct {
			Matrix yaml.Node `yaml:"matrix"`
		} `yaml:"strategy"`
		Steps []actionsStep `yaml:"steps"`
	} `yaml:"jobs"`
}

type actionsStep struct {
	ID   string            `yaml:"id"`
	Uses string            `yaml:"uses"`
	Run  string            `yaml:"run"`
	With map[string]string `yaml:"with"`
}

// serviceMatrix: the services a job's matrix runs it for, as a list or as
// the rows of an include.
type serviceMatrix struct {
	Service []string `yaml:"service"`
	Include []struct {
		Service string `yaml:"service"`
	} `yaml:"include"`
}

var (
	// stepImageOutput: a subject named by the image output of an earlier step.
	stepImageOutput = regexp.MustCompile(`^\$\{\{ steps\.([A-Za-z0-9_-]+)\.outputs\.image \}\}$`)
	// imageTagsPerService: a step that asks image-tags.sh for the image of
	// the job's matrix service.
	imageTagsPerService = regexp.MustCompile(`images/scripts/image-tags\.sh "\$\{\{ matrix\.service \}\}"`)
)

// imageTagsImage: the image image-tags.sh names for a service, $SERVICE
// standing for the service.
func imageTagsImage(t *testing.T) string {
	t.Helper()
	script, err := os.ReadFile(filepath.Join("..", "..", "..", "images", "scripts", "image-tags.sh"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^IMAGE="([^"]+)"$`).FindSubmatch(script)
	if m == nil || !strings.Contains(string(m[1]), "$SERVICE") {
		t.Fatal(`image-tags.sh states no IMAGE="…$SERVICE…": the census cannot tell which image a service publishes to`)
	}
	return string(m[1])
}

// attestedImages: each container image whose build provenance a workflow
// attests, with the workflow files that attest it. A subject this cannot
// resolve fails the test: what it cannot read, it cannot vouch for.
func attestedImages(t *testing.T) map[string][]string {
	t.Helper()
	serviceImage := imageTagsImage(t)
	files, err := os.ReadDir(workflowsDir)
	if err != nil {
		t.Fatal(err)
	}
	attested := map[string][]string{}
	for _, f := range files {
		if ext := filepath.Ext(f.Name()); ext != ".yml" && ext != ".yaml" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(workflowsDir, f.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var wf actionsWorkflow
		if err := yaml.Unmarshal(b, &wf); err != nil {
			t.Fatalf("%s: %v", f.Name(), err)
		}
		for jobName, job := range wf.Jobs {
			for _, step := range job.Steps {
				subject := step.With["subject-name"]
				// subject-path attests files, not an image.
				if !strings.HasPrefix(step.Uses, "actions/attest-build-provenance@") || subject == "" {
					continue
				}
				var images []string
				if !strings.Contains(subject, "${{") {
					images = []string{subject}
				} else if m := stepImageOutput.FindStringSubmatch(subject); m != nil {
					i := slices.IndexFunc(job.Steps, func(s actionsStep) bool { return s.ID == m[1] })
					if i < 0 || !imageTagsPerService.MatchString(job.Steps[i].Run) {
						t.Fatalf("%s, job %s: the subject %q is no image-tags.sh output for the matrix service", f.Name(), jobName, subject)
					}
					var matrix serviceMatrix
					if err := job.Strategy.Matrix.Decode(&matrix); err != nil {
						t.Fatalf("%s, job %s: the matrix: %v", f.Name(), jobName, err)
					}
					for _, row := range matrix.Include {
						matrix.Service = append(matrix.Service, row.Service)
					}
					if len(matrix.Service) == 0 {
						t.Fatalf("%s, job %s: the matrix names no service", f.Name(), jobName)
					}
					for _, service := range matrix.Service {
						images = append(images, strings.ReplaceAll(serviceImage, "$SERVICE", service))
					}
				} else {
					t.Fatalf("%s, job %s: cannot tell which image the subject %q names", f.Name(), jobName, subject)
				}
				for _, image := range images {
					if !slices.Contains(attested[image], f.Name()) {
						attested[image] = append(attested[image], f.Name())
					}
				}
			}
		}
	}
	if len(attested) == 0 {
		t.Fatal("no workflow attests an image: the census read nothing")
	}
	return attested
}

// THE GATE ON THE SIGNER THE LAUNCHER TRUSTS: the launcher runs an image of
// Semiont's only when the workflow semiontWorkflow names signed its build
// provenance, and a compiled launcher cannot read the workflows to ask. So
// they are asked here: each of Semiont's images is attested by exactly one
// workflow, the one the launcher names. A publish workflow renamed, an image
// moved to another workflow, or a second workflow attesting it fails here,
// not as a launcher that refuses the release's images.
func TestEachImageIsAttestedByTheWorkflowTheLauncherTrusts(t *testing.T) {
	attested := attestedImages(t)
	images := 0
	for _, d := range serviceDescriptors {
		if d.driver != driverSemiont {
			continue
		}
		images++
		image := strings.TrimSuffix(semiontImage(d.role, "latest"), ":latest")
		want := semiontWorkflow(d.role)
		if got := attested[image]; !slices.Equal(got, []string{want}) {
			t.Errorf("the launcher runs %s only when %s signed it, and the workflows attesting it are %v", image, want, got)
		}
	}
	if images == 0 {
		t.Fatal("the table names none of Semiont's images: the census read nothing")
	}
}
