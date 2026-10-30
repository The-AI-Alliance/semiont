package launcher

// identitygrant.go — `semiont identity grant` and `revoke`: admitting a worker
// someone else runs to a realm the launcher runs, by the public half of its
// key, and taking it back.
//
// Admitting a participant is one act, whoever it is: `semiont useradd` admits
// a person by an account; a grant gives a principal named by its key the
// worker's roles. The client is named at admission, by the operator's label,
// and the key is registered on it. A new key for the same label replaces the
// old on the same client, so the principal — the client's own account, whose
// subject the gateway names it by — stays the same.
//
// What a grant registers is public. Nothing secret passes between the
// operator and the worker's owner either way.

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// localWorkerLabel: the label of this machine's own worker, whose client the
// realm import and `semiont identity sync` keep at this machine's key.
const localWorkerLabel = "local"

// workerClientPrefix: what every worker's client id begins with; the label
// follows.
const workerClientPrefix = "semiont-worker-"

// workerClientID: the realm client of the worker admitted under label.
func workerClientID(label string) string { return workerClientPrefix + label }

// grantLabel: what a label may be — one to forty lowercase letters, digits and
// inner hyphens, so the client id it makes is plain wherever it is shown.
var grantLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$`)

// checkGrantLabel: whether label may name a granted worker. Not this machine's
// own: its key is the one sync keeps, and a grant under its label would be
// undone by the next sync.
func checkGrantLabel(label string) error {
	if label == localWorkerLabel {
		return fmt.Errorf("%q is this machine's own worker, whose key `semiont identity sync` keeps; grant another worker under a label of its own", label)
	}
	if !grantLabel.MatchString(label) {
		return fmt.Errorf("%q is not a label: one to forty lowercase letters, digits and inner hyphens", label)
	}
	return nil
}

// readGrantedKey: the key a grant registers, from what `semiont worker key`
// prints on the worker's machine — its JWK Set, or with --pem its PEM. RSA
// only, since the worker signs RS256. A private key is refused before
// anything is sent: what is registered is public, and a private key handed
// over has stopped being private. A JWK Set naming its key by another id than
// its thumbprint is refused too: the worker names its key by its thumbprint,
// and the realm refuses an assertion naming a key the client does not hold.
func readGrantedKey(b []byte) (registeredKey, error) {
	if block, _ := pem.Decode(b); block != nil {
		if strings.Contains(block.Type, "PRIVATE") {
			return registeredKey{}, fmt.Errorf("this is a private key; give the public half, which `semiont worker key` prints")
		}
		if block.Type != "PUBLIC KEY" {
			return registeredKey{}, fmt.Errorf("a PEM %q, not a PUBLIC KEY", block.Type)
		}
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return registeredKey{}, err
		}
		pub, ok := parsed.(*rsa.PublicKey)
		if !ok {
			return registeredKey{}, fmt.Errorf("not an RSA key: the worker signs its assertions with RS256")
		}
		return registeredKeyOf(pub)
	}
	var set struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.Unmarshal(b, &set); err != nil {
		return registeredKey{}, fmt.Errorf("neither a JWK Set nor a PEM public key")
	}
	if len(set.Keys) != 1 {
		return registeredKey{}, fmt.Errorf("a JWK Set of %d keys; a grant registers one", len(set.Keys))
	}
	jwk := set.Keys[0]
	if _, private := jwk["d"]; private {
		return registeredKey{}, fmt.Errorf("this is a private key; give the public half, which `semiont worker key` prints")
	}
	if jwk["kty"] != "RSA" {
		return registeredKey{}, fmt.Errorf("not an RSA key: the worker signs its assertions with RS256")
	}
	member := func(name string) (*big.Int, error) {
		s, _ := jwk[name].(string)
		raw, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil || len(raw) == 0 {
			return nil, fmt.Errorf("the key's %q is not base64url", name)
		}
		return new(big.Int).SetBytes(raw), nil
	}
	n, err := member("n")
	if err != nil {
		return registeredKey{}, err
	}
	e, err := member("e")
	if err != nil {
		return registeredKey{}, err
	}
	if !e.IsInt64() {
		return registeredKey{}, fmt.Errorf("the key's exponent is out of range")
	}
	k, err := registeredKeyOf(&rsa.PublicKey{N: n, E: int(e.Int64())})
	if err != nil {
		return registeredKey{}, err
	}
	if kid, named := jwk["kid"]; named && kid != k.thumbprint {
		return registeredKey{}, fmt.Errorf("the key set names its key %v, but its thumbprint is %s, which the worker's assertions name", kid, k.thumbprint)
	}
	return k, nil
}

// grantWorker gives the worker whose key is k the worker's roles at realm,
// under label: the client workerClient renders, created when absent, else
// brought to k and to the roles the realm document states. A second grant of
// the same key changes nothing.
func grantWorker(adminBase, realm, adminUser, adminPass, audience, label string, k registeredKey) (syncReport, error) {
	base := strings.TrimSuffix(adminBase, "/")
	token, err := adminToken(base, adminUser, adminPass)
	if err != nil {
		return syncReport{}, err
	}
	have, err := existingClients(base, realm, token)
	if err != nil {
		return syncReport{}, err
	}
	var rep syncReport
	err = reconcileAccount(base, realm, token, have, "worker", workerClient(label, k, audience), &k, &rep)
	return rep, err
}

// revokeWorker deletes the client granted under label, and no other. Keycloak
// deletes the client's own account with it, so the worker's next sign-in is
// refused. Without such a grant it deletes nothing, and answers the labels
// granted.
func revokeWorker(adminBase, realm, adminUser, adminPass, label string) (revoked bool, granted []string, err error) {
	base := strings.TrimSuffix(adminBase, "/")
	token, err := adminToken(base, adminUser, adminPass)
	if err != nil {
		return false, nil, err
	}
	have, err := existingClients(base, realm, token)
	if err != nil {
		return false, nil, err
	}
	c, ok := have[workerClientID(label)]
	if !ok {
		for id := range have {
			if l, worker := strings.CutPrefix(id, workerClientPrefix); worker && l != localWorkerLabel {
				granted = append(granted, l)
			}
		}
		sort.Strings(granted)
		return false, granted, nil
	}
	if err := deleteClient(base, realm, token, c.uuid); err != nil {
		return false, nil, fmt.Errorf("deleting %s: %w", workerClientID(label), err)
	}
	return true, nil, nil
}

func deleteClient(base, realm, token, uuid string) error {
	req, _ := http.NewRequest(http.MethodDelete, base+"/admin/realms/"+realm+"/clients/"+uuid, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
