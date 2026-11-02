package launcher

// Granting a worker someone else runs, by its key, and revoking it — over the
// admin-API stub, for the reason the sync tests use it: what is asserted is
// the launcher's half, and a real Keycloak cannot be made to hold a given
// client on demand.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"slices"
	"strings"
	"testing"
)

// anotherWorkerKey: the key of a worker on somebody else's machine.
func anotherWorkerKey(t *testing.T) registeredKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, workerKeyBits)
	if err != nil {
		t.Fatal(err)
	}
	k, err := registeredKeyOf(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// grantedRep: a granted worker's client as Keycloak lists it, holding k.
func grantedRep(label string, k registeredKey) map[string]any {
	rep := serviceClientRep("worker", serviceRolesClaim("worker"))
	rep["clientId"] = workerClientID(label)
	rep["attributes"] = workerKeyAttributes(k)
	return rep
}

// A grant creates one client, the one the realm document would render for a
// worker under that label holding that key: no second shape for a granted
// worker, and nothing else in the realm touched.
func TestAGrantCreatesOneClientAsTheRealmRendersAWorker(t *testing.T) {
	k := anotherWorkerKey(t)
	s := newStubAdmin(t, "semiont", allServiceClientReps())

	rep, err := grantWorker(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", "alice", k)
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if !slices.Equal(rep.created, []string{"semiont-worker-alice"}) || len(s.created) != 1 {
		t.Fatalf("created = %v (POSTed %d), want semiont-worker-alice alone", rep.created, len(s.created))
	}
	got, _ := json.Marshal(s.created[0])
	want, _ := json.Marshal(workerClient("alice", k, "semiont-gateway"))
	if string(got) != string(want) {
		t.Errorf("the granted client is not the one the realm renders for a worker:\n got: %s\nwant: %s", got, want)
	}
	if len(s.updated) != 0 || len(s.mappers) != 0 || len(s.deleted) != 0 {
		t.Errorf("a grant changed more than its client: PUT %v, mappers %v, DELETE %v", s.updated, s.mappers, s.deleted)
	}
}

// Granting the same key again changes nothing, so a grant can be repeated to
// confirm it.
func TestAGrantOfTheSameKeyAgainChangesNothing(t *testing.T) {
	k := anotherWorkerKey(t)
	s := newStubAdmin(t, "semiont", append(allServiceClientReps(), grantedRep("alice", k)))

	rep, err := grantWorker(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", "alice", k)
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if !slices.Equal(rep.present, []string{"semiont-worker-alice"}) || len(rep.created)+len(rep.updated) != 0 {
		t.Errorf("report = %+v, want the grant present and nothing changed", rep)
	}
	if len(s.created)+len(s.updated)+len(s.mappers)+len(s.deleted) != 0 {
		t.Errorf("a repeated grant wrote to the realm: POST %v, PUT %v, mappers %v, DELETE %v", s.created, s.updated, s.mappers, s.deleted)
	}
}

// Another key under the same label replaces the old one on the same client,
// so the worker keeps its account, and with it its identity: the client is
// updated, never deleted and made again.
func TestAGrantOfANewKeyReplacesTheOldOnTheSameClient(t *testing.T) {
	old, k := anotherWorkerKey(t), anotherWorkerKey(t)
	s := newStubAdmin(t, "semiont", append(allServiceClientReps(), grantedRep("alice", old)))

	rep, err := grantWorker(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", "alice", k)
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	patch, ok := s.updated["semiont-worker-alice"]
	if !ok {
		t.Fatalf("the client kept the old key; PUTs: %v", s.updated)
	}
	attributes, _ := patch["attributes"].(map[string]any)
	if attributes["jwt.credential.public.key"] != k.public || attributes["jwt.credential.kid"] != k.thumbprint {
		t.Errorf("the client was not given the new key: %v", attributes)
	}
	if len(s.created) != 0 || len(s.deleted) != 0 {
		t.Errorf("the client was made again rather than updated: POST %v, DELETE %v", s.created, s.deleted)
	}
	if len(rep.updated) != 1 || !strings.Contains(rep.updated[0], k.thumbprint) || !strings.Contains(rep.updated[0], old.thumbprint) {
		t.Errorf("updated = %v, want one entry naming both keys", rep.updated)
	}
}

// A revoke deletes the client granted under that label, and no other: not
// another grant, not the shared worker, not a service's.
func TestARevokeDeletesThatClientAndNoOther(t *testing.T) {
	s := newStubAdmin(t, "semiont", append(allServiceClientReps(),
		grantedRep("alice", anotherWorkerKey(t)), grantedRep("bob", anotherWorkerKey(t))))

	revoked, _, err := revokeWorker(s.srv.URL, "semiont", "admin", "pw", "alice")
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if !revoked || !slices.Equal(s.deleted, []string{"semiont-worker-alice"}) {
		t.Fatalf("revoked=%v, deleted %v, want semiont-worker-alice alone", revoked, s.deleted)
	}
	if len(s.created)+len(s.updated)+len(s.mappers) != 0 {
		t.Errorf("a revoke wrote to the realm: POST %v, PUT %v, mappers %v", s.created, s.updated, s.mappers)
	}
}

// Revoking a label nothing was granted under deletes nothing, and answers the
// labels that are granted — the shared worker not among them — so a
// mistyped label says so rather than passing for a revocation.
func TestARevokeOfNoGrantDeletesNothing(t *testing.T) {
	s := newStubAdmin(t, "semiont", append(allServiceClientReps(), grantedRep("bob", anotherWorkerKey(t))))

	revoked, granted, err := revokeWorker(s.srv.URL, "semiont", "admin", "pw", "alice")
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if revoked || len(s.deleted) != 0 {
		t.Fatalf("revoked=%v, deleted %v, for a label nothing was granted under", revoked, s.deleted)
	}
	if !slices.Equal(granted, []string{"bob"}) {
		t.Errorf("granted = %v, want [bob]", granted)
	}
}

// Neither reaches an account: a grant makes a client, a revoke deletes one,
// and Keycloak keeps a client's own account with it.
func TestGrantAndRevokeTouchNoUsersEndpoint(t *testing.T) {
	s := newStubAdmin(t, "semiont", allServiceClientReps())
	if _, err := grantWorker(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", "alice", anotherWorkerKey(t)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := revokeWorker(s.srv.URL, "semiont", "admin", "pw", "alice"); err != nil {
		t.Fatal(err)
	}
	if s.touched("/users") {
		t.Error("a grant or a revoke reached a users endpoint")
	}
}

// A grant reads what `semiont worker key` prints on the worker's machine, in
// either form, and registers the same key from both.
func TestAGrantReadsWhatTheWorkerKeyVerbPrints(t *testing.T) {
	k := testWorkerKey()
	fromSet, err := readGrantedKey([]byte(workerKeySet(k)))
	if err != nil || fromSet != k.registeredKey {
		t.Errorf("from the JWK Set: %v, %+v; want %+v", err, fromSet, k.registeredKey)
	}
	der, err := x509.MarshalPKIXPublicKey(&k.signer.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	fromPEM, err := readGrantedKey(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	if err != nil || fromPEM != k.registeredKey {
		t.Errorf("from the PEM: %v, %+v; want %+v", err, fromPEM, k.registeredKey)
	}
}

// What a grant must not register: a private key, which has stopped being
// private by being handed over; a key the worker cannot sign RS256 with; a key
// set naming its key by another id than the one its assertions carry; and
// anything that is not a key.
func TestAGrantRefusesAKeyItMustNotRegister(t *testing.T) {
	k := testWorkerKey()
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecDER, err := x509.MarshalPKIXPublicKey(&ec.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	var set map[string][]map[string]string
	if err := json.Unmarshal([]byte(workerKeySet(k)), &set); err != nil {
		t.Fatal(err)
	}
	withMember := func(name, value string) string {
		jwk := map[string]string{}
		for m, v := range set["keys"][0] {
			jwk[m] = v
		}
		jwk[name] = value
		b, _ := json.Marshal(map[string]any{"keys": []map[string]string{jwk}})
		return string(b)
	}
	two, _ := json.Marshal(map[string]any{"keys": []map[string]string{set["keys"][0], set["keys"][0]}})
	without := func(name string) string {
		jwk := map[string]string{}
		for m, v := range set["keys"][0] {
			if m != name {
				jwk[m] = v
			}
		}
		b, _ := json.Marshal(map[string]any{"keys": []map[string]string{jwk}})
		return string(b)
	}

	for _, c := range []struct{ why, file, want string }{
		{"the private half, as the worker keeps it", k.private, "private key"},
		{"a private member in a key set", withMember("d", "AQAB"), "private key"},
		{"a key the worker cannot sign RS256 with", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: ecDER})), "not an RSA key"},
		{"a key set naming its key by another id", withMember("kid", "another-id"), "thumbprint"},
		{"a key set of two keys", string(two), "registers one"},
		{"a key set's key of no type", without("kty"), "not an RSA key"},
		{"a key set's key with no modulus", without("n"), `"n" is not base64url`},
		{"a key set's key whose exponent is not base64url", withMember("e", "not base64url!"), `"e" is not base64url`},
		{"a key set's key whose exponent no int holds", withMember("e", "AQAAAAAAAAAAAAE"), "exponent is out of range"},
		{"a certificate, not a public key", string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte("x")})), `not a PUBLIC KEY`},
		{"a PEM public key that is not one", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte("x")})), "a PUBLIC KEY that is not one"},
		{"no key at all", "hello", "neither a JWK Set nor a PEM"},
	} {
		if _, err := readGrantedKey([]byte(c.file)); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want one saying %q", c.why, err, c.want)
		}
	}
}

// A label names the worker's client, so it is plain; and it is never this
// machine's own worker's, whose key sync keeps and would put back.
func TestAGrantLabelIsChecked(t *testing.T) {
	for _, label := range []string{"alice", "a", "team-7", strings.Repeat("a", 40)} {
		if err := checkGrantLabel(label); err != nil {
			t.Errorf("%q refused: %v", label, err)
		}
	}
	for _, label := range []string{localWorkerLabel, "", "Alice", "-alice", "alice-", "a_b", "a.b", strings.Repeat("a", 41)} {
		if checkGrantLabel(label) == nil {
			t.Errorf("%q taken as a label", label)
		}
	}
}

// The bootstrap admin's login refused: a grant and a revoke each say so, and
// change nothing.
func TestGrantAndRevokeReportARefusedAdminLogin(t *testing.T) {
	s := newStubAdmin(t, "semiont", append(allServiceClientReps(), grantedRep("alice", anotherWorkerKey(t))))
	s.badLogin = true
	if _, err := grantWorker(s.srv.URL, "semiont", "admin", "wrong", "semiont-gateway", "bob", anotherWorkerKey(t)); err == nil || !strings.Contains(err.Error(), "admin") {
		t.Errorf("grant: err = %v, want the admin login named", err)
	}
	if revoked, _, err := revokeWorker(s.srv.URL, "semiont", "admin", "wrong", "alice"); revoked || err == nil || !strings.Contains(err.Error(), "admin") {
		t.Errorf("revoke: revoked=%v, err = %v, want the admin login named", revoked, err)
	}
	if len(s.created)+len(s.updated)+len(s.deleted) != 0 {
		t.Errorf("a refused login changed the realm: POST %v, PUT %v, DELETE %v", s.created, s.updated, s.deleted)
	}
}

// A realm that refuses the change: the grant and the revoke fail, naming the
// client and the answer, and never report it made. A revoke that reported a
// worker revoked when it still signs in would be the worst answer it has.
func TestGrantAndRevokeReportARefusedChange(t *testing.T) {
	s := newStubAdmin(t, "semiont", append(allServiceClientReps(), grantedRep("alice", anotherWorkerKey(t))))
	s.refuseWrites = true
	for _, c := range []struct {
		what string
		err  func() error
		want string
	}{
		{"a new grant", func() error {
			_, err := grantWorker(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", "bob", anotherWorkerKey(t))
			return err
		}, "creating semiont-worker-bob: HTTP 403"},
		{"a new key", func() error {
			_, err := grantWorker(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", "alice", anotherWorkerKey(t))
			return err
		}, "updating semiont-worker-alice: HTTP 403"},
		{"a revoke", func() error {
			revoked, _, err := revokeWorker(s.srv.URL, "semiont", "admin", "pw", "alice")
			if revoked {
				t.Error("a refused revoke reported the worker revoked")
			}
			return err
		}, "deleting semiont-worker-alice: HTTP 403"},
	} {
		if err := c.err(); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.what, err, c.want)
		}
	}
}
