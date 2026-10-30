package launcher

// `semiont identity sync`, the whole verb in process: the root, the config,
// the plan, the admin password and the service secrets it resolves as start
// does, against stubAdmin's realm. The reconciler is identitysync_test.go's;
// these hold the verb around it.

import (
	"net/url"
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// syncFixture readies `identity sync` against admin for the fixture knowledge
// base, and returns its root. The issuer's port, the bootstrap admin password
// and every service client's secret come from the environment the launcher
// reads, so the verb reaches no custody store. The test is left in a
// directory of its own: the verb enters the root, and the package's other
// tests read the fixture by a relative path.
func syncFixture(t *testing.T, admin *stubAdmin) string {
	t.Helper()
	root, err := filepath.Abs(fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}
	harness.Home(t)
	origin, err := url.Parse(admin.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("KEYCLOAK_PORT", origin.Port())
	t.Setenv("KC_BOOTSTRAP_ADMIN_PASSWORD", "pw")
	for _, svc := range secretClients {
		t.Setenv(serviceClientSecretEnv(svc), secretForTest(svc))
	}
	// This machine's worker key, kept where the launcher keeps it.
	if !machineCustody().put(NewUI(true), custodyWorkerKey, testWorkerKey().private) {
		t.Fatal("keeping the test worker key")
	}
	t.Chdir(t.TempDir())
	return root
}

// syncOutput runs the verb and returns its exit code and what it printed.
func syncOutput(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var code int
	stdout, stderr := harness.CaptureOutput(t, func() {
		code = Identity(append([]string{"sync"}, args...))
	})
	return code, stdout, stderr
}

func TestIdentitySyncCreatesWhatTheRealmLacks(t *testing.T) {
	admin := newStubAdmin(t, "semiont", nil)
	root := syncFixture(t, admin)

	code, stdout, stderr := syncOutput(t, "--root", root, "--config", "anthropic")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	for _, svc := range accountServices() {
		harness.MustContainAll(t, "stdout", stdout, "created "+serviceClientID(svc))
	}
	harness.MustContainAll(t, "stdout", stdout, "Reconciling realm semiont", "created,")
	harness.MustContainAll(t, "stderr", stderr, "Run `semiont start` again")
	if len(admin.created) != len(stackServices) {
		t.Errorf("%d clients created, want one per service (%d)", len(admin.created), len(stackServices))
	}
}

func TestIdentitySyncSaysARealmThatMatchesMatches(t *testing.T) {
	admin := newStubAdmin(t, "semiont", correctRealm())
	admin.realmCfg = map[string]any{"accessTokenLifespan": float64(300)}
	root := syncFixture(t, admin)

	code, stdout, stderr := syncOutput(t, "--root", root, "--config", "anthropic")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	harness.MustContainAll(t, "stdout", stdout, "realm matches this knowledge base")
	if len(admin.created) != 0 || len(admin.updated) != 0 || len(admin.mappers) != 0 {
		t.Errorf("a matching realm was written to: created %v, updated %v, mappers %v", admin.created, admin.updated, admin.mappers)
	}
}

func TestIdentitySyncReportsARefusedAdminLogin(t *testing.T) {
	admin := newStubAdmin(t, "semiont", nil)
	admin.badLogin = true
	root := syncFixture(t, admin)

	code, _, stderr := syncOutput(t, "--root", root, "--config", "anthropic")
	if code != 1 {
		t.Fatalf("exit %d, want 1\nstderr:\n%s", code, stderr)
	}
	harness.MustContainAll(t, "stderr", stderr, "admin")
	if len(admin.created) != 0 {
		t.Errorf("clients created after a refused login: %v", admin.created)
	}
}

// With no --config, sync reconciles against the config the knowledge base
// runs: the running stack's, else the one a start last recorded for the root.
// Neither known, it refuses rather than guess.
func TestIdentitySyncNeedsAConfigWhenNoneIsKnown(t *testing.T) {
	admin := newStubAdmin(t, "semiont", nil)
	root := syncFixture(t, admin)

	code, _, stderr := syncOutput(t, "--root", root)
	if code != 1 {
		t.Fatalf("exit %d, want 1\nstderr:\n%s", code, stderr)
	}
	harness.MustContainAll(t, "stderr", stderr, "Cannot tell which config", "--config")
	if len(admin.paths) != 0 {
		t.Errorf("the realm was reached without a config: %v", admin.paths)
	}
}

func TestIdentitySyncUsesTheConfigAStartRecorded(t *testing.T) {
	admin := newStubAdmin(t, "semiont", nil)
	root := syncFixture(t, admin)
	registerRootUse(kbRoot{dir: root}, false, "anthropic")

	code, stdout, stderr := syncOutput(t, "--root", root)
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	harness.MustContainAll(t, "stdout", stdout, "Config: anthropic", "created "+serviceClientID(secretClients[0]))
}
