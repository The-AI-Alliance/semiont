package semiont

// A service account's assertion of itself, signed with its own key (RFC 7523
// §2.2, OpenID Connect's private_key_jwt). The issuer holds the key's public
// half, registered on the account's client, and checks the signature with it:
// the private key never leaves the process, and no secret is sent. The
// assertion's shape is specs/src/session/client-assertion-cases.json's.

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
)

// JWTBearer is the grant's client_assertion_type for an assertion that is a
// JWT.
const JWTBearer = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

// AssertionLifetimeSeconds is how long after it is made an assertion is good
// for.
const AssertionLifetimeSeconds = 60

func base64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// JWKThumbprint is the key's JWK thumbprint (RFC 7638): the SHA-256 of its
// members e, kty and n, in that order, with no whitespace.
func JWKThumbprint(key *rsa.PublicKey) string {
	members := `{"e":"` + base64url(big.NewInt(int64(key.E)).Bytes()) + `","kty":"RSA","n":"` + base64url(key.N.Bytes()) + `"}`
	sum := sha256.Sum256([]byte(members))
	return base64url(sum[:])
}

// ParsePrivateKeyPEM is the RSA key a PKCS#8 PEM holds (-----BEGIN PRIVATE
// KEY-----), as the launcher hands a worker its key in
// SEMIONT_OIDC_CLIENT_KEY. A PEM of another kind, or a key that is not RSA,
// is refused.
func ParsePrivateKeyPEM(text string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(text))
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, errors.New("not a PKCS#8 PEM private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("a PKCS#8 PEM that holds no private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("not an RSA key: an assertion is signed with RS256")
	}
	return key, nil
}

// assertionHeader is an assertion's header: RS256, and the key it is signed
// with, by its thumbprint.
type assertionHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
}

func assertionHeaderOf(key *rsa.PublicKey) assertionHeader {
	return assertionHeader{Alg: "RS256", Kid: JWKThumbprint(key)}
}

// assertionClaims is an assertion's claims: the client is its issuer and its
// subject, and the token endpoint its audience.
type assertionClaims struct {
	Iss string `json:"iss"`
	Sub string `json:"sub"`
	Aud string `json:"aud"`
	Jti string `json:"jti"`
	Iat int64  `json:"iat"`
	Exp int64  `json:"exp"`
}

func assertionClaimsOf(clientID, tokenEndpoint string, issuedAt int64, jti string) assertionClaims {
	return assertionClaims{
		Iss: clientID,
		Sub: clientID,
		Aud: tokenEndpoint,
		Jti: jti,
		Iat: issuedAt,
		Exp: issuedAt + AssertionLifetimeSeconds,
	}
}

// clientAssertion is the assertion, signed: a compact JWT of its header and
// claims, RS256 with key.
func clientAssertion(key *rsa.PrivateKey, clientID, tokenEndpoint string, issuedAt int64, jti string) (string, error) {
	// Marshalling strings and integers cannot fail.
	header, _ := json.Marshal(assertionHeaderOf(&key.PublicKey))
	claims, _ := json.Marshal(assertionClaimsOf(clientID, tokenEndpoint, issuedAt, jti))
	signing := base64url(header) + "." + base64url(claims)
	digest := sha256.Sum256([]byte(signing))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signing + "." + base64url(signature), nil
}
