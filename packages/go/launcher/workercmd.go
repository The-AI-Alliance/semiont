package launcher

// workercmd.go — `semiont worker key`: the public half of the key this
// machine's worker proves itself with, for an issuer the launcher does not run
// to register. A realm the launcher runs is given it by the import, or by
// `semiont identity sync`.

import (
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
)

const workerUsage = `Usage: semiont worker key [--pem]

Print the public half of the key this machine's worker signs its sign-ins
with — generated on first use and kept under the launcher's data directory, one
for the machine, whichever knowledge bases it serves. The private half is never
printed.

An issuer the launcher runs holds it already: the realm import registers it,
and ` + "`semiont identity sync`" + ` brings an older realm to it. For an issuer
you run yourself, create a confidential client for the worker that
authenticates with a signed JWT, enable its client-credentials grant, and
register this key on it.

Printed as a JWK Set by default, which carries the key id each of the worker's
assertions names (the key's RFC 7638 thumbprint). With --pem, the key as a
PEM SubjectPublicKeyInfo, and the key id on stderr: an issuer given the PEM
must be given the key id as well.
`

func Worker(args []string) int {
	u := NewUI(false)
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Print(workerUsage)
		if len(args) == 0 {
			return 1
		}
		return 0
	}
	if args[0] != "key" {
		u.Fail("Unknown worker subcommand: %s", args[0])
		fmt.Fprint(os.Stderr, workerUsage)
		return 1
	}
	asPEM := false
	for _, a := range args[1:] {
		switch a {
		case "--pem":
			asPEM = true
		default:
			u.Fail("Unknown option for worker key: %s", a)
			fmt.Fprint(os.Stderr, workerUsage)
			return 1
		}
	}
	k, ok := loadOrCreateWorkerKey(u)
	if !ok {
		return 1
	}
	if asPEM {
		public, err := x509.MarshalPKIXPublicKey(&k.signer.PublicKey)
		if err != nil {
			u.Fail("%v", err)
			return 1
		}
		fmt.Print(string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: public})))
		fmt.Fprintf(os.Stderr, "key id: %s\n", k.thumbprint)
		return 0
	}
	fmt.Println(workerKeySet(k))
	return 0
}

// workerKeySet: the key's public half as a JWK Set of one key, named by its
// thumbprint and for RS256 signatures only.
func workerKeySet(k workerKey) string {
	pub := k.signer.PublicKey
	b, _ := json.MarshalIndent(map[string]any{"keys": []map[string]string{{
		"kty": "RSA",
		"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		"kid": k.thumbprint,
		"alg": "RS256",
		"use": "sig",
	}}}, "", "  ")
	return string(b)
}
