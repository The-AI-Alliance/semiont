package launcher

// `semiont identity sync`, the whole verb in process: the root, the config,
// the plan, the admin password and the service secrets it resolves as start
// does, against stubAdmin's realm. The reconciler is identitysync_test.go's;
// these hold the verb around it.

import (
	"crypto/rand"
	"crypto/rsa"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
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

// identityOutput runs the verb and returns its exit code and what it printed.
func identityOutput(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var code int
	stdout, stderr := harness.CaptureOutput(t, func() {
		code = Identity(args)
	})
	return code, stdout, stderr
}

func TestIdentitySyncCreatesWhatTheRealmLacks(t *testing.T) {
	admin := newStubAdmin(t, "semiont", nil)
	root := syncFixture(t, admin)

	code, stdout, stderr := identityOutput(t, "sync", "--root", root, "--config", "anthropic")
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

	code, stdout, stderr := identityOutput(t, "sync", "--root", root, "--config", "anthropic")
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

	code, _, stderr := identityOutput(t, "sync", "--root", root, "--config", "anthropic")
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

	code, _, stderr := identityOutput(t, "sync", "--root", root)
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

	code, stdout, stderr := identityOutput(t, "sync", "--root", root)
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	harness.MustContainAll(t, "stdout", stdout, "Config: anthropic", "created "+serviceClientID(secretClients[0]))
}

// keyFile: what `semiont worker key` printed on the worker's machine, saved
// where the operator keeps it.
func keyFile(t *testing.T, k workerKey) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "alice.jwks")
	if err := os.WriteFile(p, []byte(workerKeySet(k)), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// A grant prints what the worker's owner needs to sign in and serve this
// knowledge base: the client id, and where the gateway is, as the knowledge
// base's documents state it — the gateway names its issuer itself. Neither is
// secret. The fixture's gateway is on loopback, which no other machine
// reaches, and the grant says so.
func TestIdentityGrantPrintsWhatTheWorkersOwnerNeeds(t *testing.T) {
	admin := newStubAdmin(t, "semiont", correctRealm())
	root := syncFixture(t, admin)
	st, err := stack.Load(root, "anthropic")
	if err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, workerKeyBits)
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := workerKeyOf(key)
	if err != nil {
		t.Fatal(err)
	}

	code, stdout, stderr := identityOutput(t, "grant", "alice", "--key", keyFile(t, theirs), "--root", root, "--config", "anthropic")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	harness.MustContainAll(t, "stdout", stdout,
		"granted alice",
		"Client id:  semiont-worker-alice",
		"Gateway:    "+st.KnowledgeBase.Spec.Gateway.PublicURL+"\n")
	if strings.Contains(stdout, "Issuer") {
		t.Errorf("the grant states an issuer; the gateway names the one it trusts:\n%s", stdout)
	}
	harness.MustContainAll(t, "stderr", stderr, "Neither is secret")
	harness.MustContainAll(t, "stdout", stdout, "a worker on another machine cannot reach")
	if len(admin.created) != 1 || admin.created[0]["clientId"] != "semiont-worker-alice" {
		t.Errorf("created %v, want semiont-worker-alice alone", admin.created)
	}
}

// What a grant must not do is refused before the realm is reached: a label
// that is this machine's own worker's, a key file holding a private key, or no
// key at all.
func TestIdentityGrantRefusesBeforeReachingTheRealm(t *testing.T) {
	admin := newStubAdmin(t, "semiont", correctRealm())
	root := syncFixture(t, admin)
	private := filepath.Join(t.TempDir(), "private.pem")
	if err := os.WriteFile(private, []byte(testWorkerKey().private), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"grant", localWorkerLabel, "--key", keyFile(t, testWorkerKey()), "--root", root, "--config", "anthropic"},
		{"grant", "alice", "--key", private, "--root", root, "--config", "anthropic"},
		{"grant", "alice", "--root", root, "--config", "anthropic"},
		{"grant", "--key", keyFile(t, testWorkerKey()), "--root", root, "--config", "anthropic"},
		{"revoke", localWorkerLabel, "--root", root, "--config", "anthropic"},
	} {
		if code, _, _ := identityOutput(t, args...); code != 1 {
			t.Errorf("%v: exit %d, want 1", args, code)
		}
	}
	if len(admin.paths) != 0 {
		t.Errorf("a refused grant reached the realm: %v", admin.paths)
	}
}

func TestIdentityRevokeDeletesTheGrant(t *testing.T) {
	admin := newStubAdmin(t, "semiont", append(correctRealm(), grantedRep("alice", anotherWorkerKey(t))))
	root := syncFixture(t, admin)

	code, stdout, stderr := identityOutput(t, "revoke", "alice", "--root", root, "--config", "anthropic")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	harness.MustContainAll(t, "stdout", stdout, "revoked alice", "semiont-worker-alice")
	harness.MustContainAll(t, "stderr", stderr, "stays good until it expires", "within 300s")
	if len(admin.deleted) != 1 || admin.deleted[0] != "semiont-worker-alice" {
		t.Errorf("deleted %v, want semiont-worker-alice alone", admin.deleted)
	}
}

func TestIdentityRevokeOfAnUnknownLabelFails(t *testing.T) {
	admin := newStubAdmin(t, "semiont", append(correctRealm(), grantedRep("bob", anotherWorkerKey(t))))
	root := syncFixture(t, admin)

	code, _, stderr := identityOutput(t, "revoke", "alice", "--root", root, "--config", "anthropic")
	if code != 1 {
		t.Fatalf("exit %d, want 1\nstderr:\n%s", code, stderr)
	}
	harness.MustContainAll(t, "stderr", stderr, "No worker is granted as alice", "Granted: bob")
	if len(admin.deleted) != 0 {
		t.Errorf("deleted %v for a label nothing was granted under", admin.deleted)
	}
}

// fixtureCopy: the knowledge base at src, copied where a test may change its
// documents, changed by edit.
func fixtureCopy(t *testing.T, src string, edit func(stackDir string)) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "kb")
	if err := os.CopyFS(root, os.DirFS(src)); err != nil {
		t.Fatal(err)
	}
	edit(filepath.Join(root, ".semiont", "stack"))
	return root
}

// replaceIn: one document of the copy, with old replaced by new.
func replaceIn(t *testing.T, path, old, new string) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), old) {
		t.Fatalf("%s holds no %q", path, old)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(b), old, new, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
}

// At an issuer the launcher does not run, the realm is somebody else's: grant
// and revoke refuse, and say what to do there instead.
func TestIdentityGrantAndRevokeSayWhatToDoAtAnIssuerTheLauncherDoesNotRun(t *testing.T) {
	admin := newStubAdmin(t, "semiont", nil)
	root := fixtureCopy(t, syncFixture(t, admin), func(dir string) {
		replaceIn(t, filepath.Join(dir, "knowledge-base.yaml"), "    ref: issuer\n",
			"    external: { type: keycloak, url: https://login.example.com/realms/kb }\n")
		if err := os.Remove(filepath.Join(dir, "issuer.yaml")); err != nil {
			t.Fatal(err)
		}
	})
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"grant", "alice", "--key", keyFile(t, testWorkerKey())}, "a client that authenticates with a signed JWT"},
		{[]string{"revoke", "alice"}, "Delete the worker's client at your own issuer"},
	} {
		code, _, stderr := identityOutput(t, append(c.args, "--root", root, "--config", "anthropic")...)
		if code != 1 {
			t.Errorf("%v: exit %d, want 1", c.args, code)
		}
		harness.MustContainAll(t, "stderr", stderr, "not launcher-run", c.want)
	}
	if len(admin.paths) != 0 {
		t.Errorf("an issuer the launcher does not run was reached: %v", admin.paths)
	}
}

// A grant says what it did: granted, already granted this key, or the key
// replaced.
func TestIdentityGrantSaysWhatItDid(t *testing.T) {
	k := testWorkerKey()
	for _, c := range []struct {
		name string
		held []map[string]any
		want string
	}{
		{"the same key", []map[string]any{grantedRep("alice", k.registeredKey)}, "alice is already granted this key (" + k.thumbprint + ")"},
		{"another key", []map[string]any{grantedRep("alice", anotherWorkerKey(t))}, "updated semiont-worker-alice: key now " + k.thumbprint},
	} {
		t.Run(c.name, func(t *testing.T) {
			admin := newStubAdmin(t, "semiont", append(correctRealm(), c.held...))
			root := syncFixture(t, admin)
			code, stdout, stderr := identityOutput(t, "grant", "alice", "--key", keyFile(t, k), "--root", root, "--config", "anthropic")
			if code != 0 {
				t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
			}
			harness.MustContainAll(t, "stdout", stdout, c.want, "Client id:  semiont-worker-alice")
		})
	}
}

func TestIdentityGrantAndRevokeReportARefusedAdminLogin(t *testing.T) {
	admin := newStubAdmin(t, "semiont", append(correctRealm(), grantedRep("alice", anotherWorkerKey(t))))
	admin.badLogin = true
	root := syncFixture(t, admin)
	for _, args := range [][]string{
		{"grant", "bob", "--key", keyFile(t, testWorkerKey())},
		{"revoke", "alice"},
	} {
		code, _, stderr := identityOutput(t, append(args, "--root", root, "--config", "anthropic")...)
		if code != 1 {
			t.Errorf("%v: exit %d, want 1", args, code)
		}
		harness.MustContainAll(t, "stderr", stderr, "admin login was refused")
	}
	if len(admin.created)+len(admin.deleted) != 0 {
		t.Errorf("a refused login changed the realm: created %v, deleted %v", admin.created, admin.deleted)
	}
}

// What a subcommand does not take is refused, before the realm is reached.
func TestIdentitySubcommandsRefuseWhatTheyDoNotTake(t *testing.T) {
	admin := newStubAdmin(t, "semiont", correctRealm())
	root := syncFixture(t, admin)
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"sync", "alice"}, "sync takes no argument"},
		{[]string{"revoke"}, "revoke takes one label"},
		{[]string{"revoke", "alice", "bob"}, "revoke takes one label"},
		{[]string{"grant", "alice", "--key", filepath.Join(t.TempDir(), "absent.jwks")}, "Reading"},
	} {
		code, _, stderr := identityOutput(t, append(c.args, "--root", root, "--config", "anthropic")...)
		if code != 1 {
			t.Errorf("%v: exit %d, want 1", c.args, code)
		}
		harness.MustContainAll(t, "stderr", stderr, c.want)
	}
	if len(admin.paths) != 0 {
		t.Errorf("a refused subcommand reached the realm: %v", admin.paths)
	}
}
