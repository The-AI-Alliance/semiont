package launcher

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Per-runtime capture bounds: docker rotates, podman caps size only, Apple
// container takes no log options at all.
func TestLogOptArgsPerRuntime(t *testing.T) {
	if got := logOptArgs("docker"); !reflect.DeepEqual(got, []string{"--log-opt", "max-size=10m", "--log-opt", "max-file=3"}) {
		t.Fatalf("docker log opts = %v", got)
	}
	if got := logOptArgs("podman"); !reflect.DeepEqual(got, []string{"--log-opt", "max-size=10m"}) {
		t.Fatalf("podman log opts = %v", got)
	}
	if got := logOptArgs("container"); got != nil {
		t.Fatalf("Apple container must get no log opts, got %v", got)
	}
}

// The injection touches only `run` argvs, right after the subcommand, and
// leaves runtimes without log options untouched — the same argv a builder
// produced is the argv Apple container receives.
func TestWithLogOpts(t *testing.T) {
	run := []string{"run", "-d", "--name", "semiont-gateway", "img"}

	got := withLogOpts("docker", run)
	want := []string{"run", "--log-opt", "max-size=10m", "--log-opt", "max-file=3", "-d", "--name", "semiont-gateway", "img"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("docker injection = %v, want %v", got, want)
	}

	if got := withLogOpts("container", run); !reflect.DeepEqual(got, run) {
		t.Fatalf("container argv must pass through untouched, got %v", got)
	}
	notRun := []string{"logs", "--follow", "semiont-gateway"}
	if got := withLogOpts("docker", notRun); !reflect.DeepEqual(got, notRun) {
		t.Fatalf("non-run argv must pass through untouched, got %v", got)
	}
}

// Retention: newest snapshotKeep dirs survive, oldest go, files are ignored.
func TestPruneSnapshotsKeepsNewest(t *testing.T) {
	dir := t.TempDir()
	names := []string{
		"20260801-000000Z", "20260802-000000Z", "20260803-000000Z",
		"20260804-000000Z", "20260805-000000Z", "20260806-000000Z",
		"20260807-000000Z",
	}
	for _, n := range names {
		if err := os.Mkdir(filepath.Join(dir, n), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "not-a-dir.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	pruneSnapshots(dir, 5)

	for _, gone := range names[:2] {
		if _, err := os.Stat(filepath.Join(dir, gone)); !os.IsNotExist(err) {
			t.Fatalf("%s should have been pruned", gone)
		}
	}
	for _, kept := range names[2:] {
		if _, err := os.Stat(filepath.Join(dir, kept)); err != nil {
			t.Fatalf("%s should have been kept: %v", kept, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "not-a-dir.txt")); err != nil {
		t.Fatalf("plain files must be left alone: %v", err)
	}
}

// A rootless call must be a silent no-op — evidence capture never blocks a
// teardown, and never writes outside a known root's state area.
func TestWriteLogSnapshotHomelessRootIsNoop(t *testing.T) {
	dir, n := writeLogSnapshot("docker", "", []string{"semiont-gateway"})
	if dir != "" || n != 0 {
		t.Fatalf("empty root must write nothing, got dir=%q n=%d", dir, n)
	}
}
