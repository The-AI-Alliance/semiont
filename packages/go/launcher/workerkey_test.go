package launcher

// The shared worker key: kept once, registered on the
// worker's realm client by its thumbprint, handed to the worker off the
// command line, and printed — its public half only — for an issuer the
// launcher does not run.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// A second start, of this knowledge base or another, gets the FIRST key: every
// realm this launcher runs registers it, and a fresh one would be refused by
// all of them. Kept once, shared, not under a root, and to its owner.
func TestTheWorkerKeyIsKeptForEveryKnowledgeBase(t *testing.T) {
	harness.Home(t)
	u := NewUI(true)

	first, ok := loadOrCreateWorkerKey(u)
	if !ok {
		t.Fatal("no worker key made")
	}
	second, ok := loadOrCreateWorkerKey(u)
	if !ok || second.thumbprint != first.thumbprint || second.private != first.private {
		t.Fatalf("a second use made another key (%s → %s): every realm holds the first", first.thumbprint, second.thumbprint)
	}

	kept := filepath.Join(sharedStateDir(), custodyWorkerKey)
	if filepath.Dir(kept) != filepath.Join(dataDir(), "shared") {
		t.Errorf("the worker key is kept at %s, not shared", kept)
	}
	if fi, err := os.Stat(kept); err != nil {
		t.Fatalf("the worker key is not kept: %v", err)
	} else if fi.Mode().Perm()&0o077 != 0 {
		t.Errorf("the worker key is readable beyond its owner: %v", fi.Mode().Perm())
	}

	// The halves agree: the public half and the thumbprint the realm holds are
	// the private half's.
	public, err := base64.StdEncoding.DecodeString(first.public)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParsePKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	if !first.signer.PublicKey.Equal(parsed) {
		t.Error("the public half the realm is given is not the key's")
	}
	if first.thumbprint != semiont.JWKThumbprint(&first.signer.PublicKey) {
		t.Error("the key is not named by its thumbprint")
	}
}

// Assertions are RS256: a kept key of another kind is refused by name, not
// handed to a worker that cannot sign with it.
func TestAKeptWorkerKeyThatIsNotRSAIsRefused(t *testing.T) {
	harness.Home(t)
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(ec)
	if err != nil {
		t.Fatal(err)
	}
	u := NewUI(true)
	if !sharedCustody().put(u, custodyWorkerKey, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))) {
		t.Fatal("keeping the EC key")
	}
	var ok bool
	_, stderr := harness.CaptureOutput(t, func() { _, ok = loadOrCreateWorkerKey(u) })
	if ok {
		t.Fatal("an EC key was taken for the worker's RS256 assertions")
	}
	if !strings.Contains(stderr, "not an RSA key") {
		t.Errorf("the refusal does not say why: %s", stderr)
	}
}

// The realm's worker client proves itself with the key, never a secret: a
// client-jwt client holding the key itself (no JWKS URL to fetch it from), the
// thumbprint every assertion names, and the worker's roles.
func TestTheRealmRegistersTheWorkerByItsKey(t *testing.T) {
	k := testWorkerKey()
	var doc struct {
		Clients []map[string]any `json:"clients"`
	}
	if err := json.Unmarshal(keycloakRealmJSON("semiont", "aud", 3000, keycloakAccessTokenLifespan, realmAccounts{worker: k}), &doc); err != nil {
		t.Fatal(err)
	}
	var worker map[string]any
	for _, c := range doc.Clients {
		if c["clientId"] == serviceClientID("worker") {
			worker = c
		}
		if c["clientId"] == "semiont-worker" {
			t.Error("the realm still renders the worker's secret client")
		}
	}
	if worker == nil {
		t.Fatalf("the realm has no %s client", serviceClientID("worker"))
	}
	if _, ok := worker["secret"]; ok {
		t.Error("the worker's client carries a secret")
	}
	if worker["clientAuthenticatorType"] != clientJWT || worker["serviceAccountsEnabled"] != true {
		t.Errorf("the worker's client does not take a signed assertion for its own token: %v", worker)
	}
	attributes, _ := worker["attributes"].(map[string]any)
	for name, want := range map[string]string{
		"use.jwks.url":              "false",
		"jwt.credential.public.key": k.public,
		"jwt.credential.kid":        k.thumbprint,
	} {
		if attributes[name] != want {
			t.Errorf("attribute %s = %v, want %s", name, attributes[name], want)
		}
	}
	rendered, _ := json.Marshal(worker)
	if !strings.Contains(string(rendered), strings.ReplaceAll(serviceRolesClaim("worker"), `"`, `\"`)) {
		t.Errorf("the worker's client does not stamp the worker's roles: %s", rendered)
	}
}

// What `semiont worker key` prints for an issuer to register: one key, named
// by the thumbprint each assertion names, whose modulus and exponent are the
// key's — and no private member.
func TestTheWorkerKeySetNamesTheKeyByItsThumbprint(t *testing.T) {
	k := testWorkerKey()
	var set struct {
		Keys []map[string]string `json:"keys"`
	}
	if err := json.Unmarshal([]byte(workerKeySet(k)), &set); err != nil {
		t.Fatal(err)
	}
	if len(set.Keys) != 1 {
		t.Fatalf("a key set of %d keys", len(set.Keys))
	}
	jwk := set.Keys[0]
	if jwk["kid"] != k.thumbprint || jwk["alg"] != "RS256" || jwk["use"] != "sig" || jwk["kty"] != "RSA" {
		t.Errorf("the key is not named for its use: %v", jwk)
	}
	n, err := base64.RawURLEncoding.DecodeString(jwk["n"])
	if err != nil {
		t.Fatal(err)
	}
	e, err := base64.RawURLEncoding.DecodeString(jwk["e"])
	if err != nil {
		t.Fatal(err)
	}
	if new(big.Int).SetBytes(n).Cmp(k.signer.N) != 0 || int(new(big.Int).SetBytes(e).Int64()) != k.signer.E {
		t.Error("the key set's key is not the worker's")
	}
	for _, private := range []string{"d", "p", "q", "dp", "dq", "qi"} {
		if _, ok := jwk[private]; ok {
			t.Errorf("the key set carries the private member %q", private)
		}
	}
}

// The worker's container is handed the key as SEMIONT_OIDC_CLIENT_KEY, and
// its value never rides the command line: the runtime copies it from the
// launcher's own environment.
func TestTheWorkerIsHandedItsKeyOffTheCommandLine(t *testing.T) {
	k := testWorkerKey()
	argv, env := offCommandLine(workerArgs("/state/shared/worker.json", exposure{rt: "container", addr: "1.2.3.4"}, k.private, "v", semiontDescriptor("worker").mem, nil, nil))
	if line := strings.Join(argv, " "); strings.Contains(line, "PRIVATE KEY") || !strings.Contains(line, "--env SEMIONT_OIDC_CLIENT_KEY ") {
		t.Errorf("the key's value rides the command line, or its name is missing:\n%s", line)
	}
	if !strings.Contains(strings.Join(env, "\n"), "SEMIONT_OIDC_CLIENT_KEY="+k.private) {
		t.Error("the runtime's environment does not carry the worker's key whole")
	}
}

// `semiont worker key` prints the worker key — the one the realm holds — as
// a key set, or with --pem as a PEM with its key id beside it, and never the
// private half.
func TestTheWorkerVerbPrintsThePublicKey(t *testing.T) {
	harness.Home(t)
	if !sharedCustody().put(NewUI(true), custodyWorkerKey, testWorkerKey().private) {
		t.Fatal("keeping the test worker key")
	}
	var code int
	stdout, stderr := harness.CaptureOutput(t, func() { code = Worker([]string{"key"}) })
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if strings.TrimSpace(stdout) != workerKeySet(testWorkerKey()) {
		t.Errorf("printed another key set than the worker's:\n%s", stdout)
	}

	stdout, stderr = harness.CaptureOutput(t, func() { code = Worker([]string{"key", "--pem"}) })
	if code != 0 {
		t.Fatalf("--pem: exit %d\n%s", code, stderr)
	}
	block, _ := pem.Decode([]byte(stdout))
	if block == nil || block.Type != "PUBLIC KEY" {
		t.Fatalf("--pem printed no public key:\n%s", stdout)
	}
	if base64.StdEncoding.EncodeToString(block.Bytes) != testWorkerKey().public {
		t.Error("--pem printed another key than the one the realm holds")
	}
	if !strings.Contains(stderr, "key id: "+testWorkerKey().thumbprint) {
		t.Errorf("--pem does not give the key id:\n%s", stderr)
	}
	for _, printed := range []string{stdout, stderr} {
		if strings.Contains(printed, "PRIVATE KEY") {
			t.Fatal("the worker verb printed the private half")
		}
	}
}

func TestTheWorkerVerbRejectsWhatItDoesNotKnow(t *testing.T) {
	for _, args := range [][]string{nil, {"rotate"}, {"key", "--jwks"}} {
		var code int
		harness.CaptureOutput(t, func() { code = Worker(args) })
		if code != 1 {
			t.Errorf("%v: exit %d, want 1", args, code)
		}
	}
}
