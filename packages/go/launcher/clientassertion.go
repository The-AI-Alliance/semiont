package launcher

// clientassertion.go — a service account's assertion of itself, signed with
// its own key (RFC 7523 §2.2, OpenID Connect's private_key_jwt): what the
// preflight signs to sign in as the worker, whose key is this machine's.
// Its shape is specs/src/session/client-assertion-cases.json's, which
// clientassertion_test.go runs.

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
)

// jwtBearer: the grant's client_assertion_type for an assertion that is a JWT.
const jwtBearer = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

// assertionLifetimeSeconds: how long after it is made an assertion is good for.
const assertionLifetimeSeconds = 60

func base64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// jwkThumbprint: the key's JWK thumbprint (RFC 7638): the SHA-256 of its
// members e, kty and n, in that order, with no whitespace.
func jwkThumbprint(pub *rsa.PublicKey) string {
	// Marshalling a struct keeps its fields' order, which is the RFC's.
	members, _ := json.Marshal(struct {
		E   string `json:"e"`
		Kty string `json:"kty"`
		N   string `json:"n"`
	}{base64url(big.NewInt(int64(pub.E)).Bytes()), "RSA", base64url(pub.N.Bytes())})
	sum := sha256.Sum256(members)
	return base64url(sum[:])
}

// assertionHeader: RS256, and the key the assertion is signed with, by its thumbprint.
func assertionHeader(pub *rsa.PublicKey) map[string]any {
	return map[string]any{"alg": "RS256", "kid": jwkThumbprint(pub)}
}

// assertionClaims: the client is its issuer and its subject, and the token
// endpoint its audience.
func assertionClaims(clientID, tokenEndpoint string, issuedAt int64, jti string) map[string]any {
	return map[string]any{
		"iss": clientID,
		"sub": clientID,
		"aud": tokenEndpoint,
		"jti": jti,
		"iat": issuedAt,
		"exp": issuedAt + assertionLifetimeSeconds,
	}
}

// clientAssertion: the assertion, signed — a compact JWT of assertionHeader
// and assertionClaims, RS256 with key.
func clientAssertion(key *rsa.PrivateKey, clientID, tokenEndpoint string, issuedAt int64, jti string) (string, error) {
	header, err := json.Marshal(assertionHeader(&key.PublicKey))
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(assertionClaims(clientID, tokenEndpoint, issuedAt, jti))
	if err != nil {
		return "", err
	}
	signing := base64url(header) + "." + base64url(claims)
	digest := sha256.Sum256([]byte(signing))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signing + "." + base64url(signature), nil
}
