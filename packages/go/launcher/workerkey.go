package launcher

// workerkey.go — the key the worker this machine runs proves itself with.
//
// One RSA key for the machine, not for a root: the worker serves every
// knowledge base the launcher runs here, and each one's realm registers the
// key's public half on one client, serviceClientID("worker"). The private half never
// leaves the machine: it reaches the worker's container as
// SEMIONT_OIDC_CLIENT_KEY, and the worker signs each sign-in with it (RFC 7523,
// clientassertion.go). No secret is sent, and none is kept for the worker in a
// root.

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"path/filepath"
)

// custodyWorkerKey: the custody name of the machine's worker key, an RSA
// private key, PKCS#8 PEM.
const custodyWorkerKey = "worker-key"

// workerKeyBits: the worker key's size. RS256 signs with it.
const workerKeyBits = 2048

// machineStateDir: what the launcher keeps for this machine rather than for
// one root, beside the roots' state (stateRootDir). "" when homeless.
func machineStateDir() string {
	d := dataDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, "machine")
}

// registeredKey: what a realm holds of a worker's key — its public half, and
// the thumbprint it is named by.
type registeredKey struct {
	public     string // base64 DER SubjectPublicKeyInfo: jwt.credential.public.key
	thumbprint string // RFC 7638: jwt.credential.kid, and the kid each assertion names
}

// registeredKeyOf: what a realm holds of pub.
func registeredKeyOf(pub *rsa.PublicKey) (registeredKey, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return registeredKey{}, err
	}
	return registeredKey{public: base64.StdEncoding.EncodeToString(der), thumbprint: jwkThumbprint(pub)}, nil
}

// workerKey: the machine's worker key as the launcher hands it on — what the
// realm's client holds of it, its private half for the worker's container, and
// the key itself for the preflight to sign with. A plan holds placeholders and
// no key.
type workerKey struct {
	registeredKey
	private string          // PKCS#8 PEM: SEMIONT_OIDC_CLIENT_KEY
	signer  *rsa.PrivateKey // nil in a plan
}

// workerKeyOf: what the launcher hands on of key.
func workerKeyOf(key *rsa.PrivateKey) (workerKey, error) {
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return workerKey{}, err
	}
	registered, err := registeredKeyOf(&key.PublicKey)
	if err != nil {
		return workerKey{}, err
	}
	return workerKey{
		registeredKey: registered,
		private:       string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})),
		signer:        key,
	}, nil
}

// readWorkerKey: the key a kept PKCS#8 PEM holds, which must be RSA.
func readWorkerKey(kept string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(kept))
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("not a PKCS#8 PEM private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("not an RSA key")
	}
	return key, nil
}

// loadOrCreateWorkerKey: the machine's worker key, from the machine's store
// (machineCustody), generated and kept there on its first use.
func loadOrCreateWorkerKey(u *UI) (workerKey, bool) {
	if machineStateDir() == "" {
		u.Fail("No home directory resolvable, so there is nowhere to keep the worker's key.")
		return workerKey{}, false
	}
	store := machineCustody()
	kept, ok := store.get(u, custodyWorkerKey)
	if !ok {
		return workerKey{}, false
	}
	if kept != "" {
		key, err := readWorkerKey(kept)
		if err != nil {
			u.Fail("The worker's key at %s cannot be read: %v", store.where(custodyWorkerKey), err)
			return workerKey{}, false
		}
		k, err := workerKeyOf(key)
		if err != nil {
			u.Fail("The worker's key at %s: %v", store.where(custodyWorkerKey), err)
			return workerKey{}, false
		}
		return k, true
	}
	key, err := rsa.GenerateKey(rand.Reader, workerKeyBits)
	if err != nil {
		u.Fail("Generating the worker's key: %v", err)
		return workerKey{}, false
	}
	k, err := workerKeyOf(key)
	if err != nil {
		u.Fail("Generating the worker's key: %v", err)
		return workerKey{}, false
	}
	if !store.put(u, custodyWorkerKey, k.private) {
		return workerKey{}, false
	}
	u.Log("Worker key: %s", u.Dim("generated and kept ("+k.thumbprint+")"))
	return k, true
}

// workerClient: the realm client of the worker admitted under label — this
// machine's own (localWorkerLabel), or one a grant admitted. It proves itself
// with a signed assertion (client-jwt) the realm checks with the key's public
// half: no secret. The realm names the key by its thumbprint, which each
// assertion's header names too: Keycloak refuses an assertion naming a key the
// client does not.
func workerClient(label string, k registeredKey, audience string) map[string]any {
	return accountClient(workerClientID(label), "Semiont worker "+label, map[string]any{
		"clientAuthenticatorType": clientJWT,
		"attributes":              workerKeyAttributes(k),
	}, audience, serviceRolesClaim("worker"))
}

// clientJWT: Keycloak's authenticator for a client that proves itself with an
// assertion it signs.
const clientJWT = "client-jwt"

// workerKeyAttributes: the attributes by which a client-jwt client holds the
// key it checks assertions with: the key itself, not a JWKS URL to fetch it
// from, and the thumbprint each assertion names it by.
func workerKeyAttributes(k registeredKey) map[string]string {
	return map[string]string{
		"use.jwks.url":              "false",
		"jwt.credential.public.key": k.public,
		"jwt.credential.kid":        k.thumbprint,
	}
}
