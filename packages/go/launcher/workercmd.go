package launcher

// workercmd.go — `semiont worker key`: the public half of the key this
// machine's worker proves itself with, for an issuer the launcher does not run
// to register. A realm the launcher runs is given it by the import, or by
// `semiont identity sync`. And `semiont worker kb`: the knowledge bases
// someone else runs that the worker serves beside the one each start runs
// (workerkbs.go).

import (
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"slices"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

const workerUsage = `Usage: semiont worker key [--pem]
       semiont worker kb add <domain> --gateway <url> --client-id <id>
       semiont worker kb remove <domain>
       semiont worker kb list

key
  Print the public half of the key this machine's worker signs its sign-ins
  with — generated on first use and kept under the launcher's data directory,
  one for the machine, whichever knowledge bases it serves. The private half
  is never printed.

  An issuer the launcher runs holds it already: the realm import registers it,
  and ` + "`semiont identity sync`" + ` brings an older realm to it. For an
  issuer you run yourself, create a confidential client for the worker that
  authenticates with a signed JWT, enable its client-credentials grant, and
  register this key on it. For a knowledge base someone else runs, send it to
  its operator, who grants it (` + "`semiont identity grant`" + `).

  Printed as a JWK Set by default, which carries the key id each of the
  worker's assertions names (the key's RFC 7638 thumbprint). With --pem, the
  key as a PEM SubjectPublicKeyInfo, and the key id on stderr: an issuer given
  the PEM must be given the key id as well.

kb add
  Add a knowledge base someone else runs to this machine's worker: its
  did:web domain, where its gateway is, and the client its operator granted
  this machine's key on. Its operator's ` + "`semiont identity grant`" + ` prints
  this line, ready to run. The gateway names the issuer to sign in at, and add
  asks it now: a gateway that cannot be reached, or names no issuer, adds
  nothing. Adding a domain already added replaces it.

  The next ` + "`semiont start`" + ` runs one worker for the knowledge base it
  starts and every one added, and offers each the engines that start's
  Inference document gives jobs, on this machine's providers' keys. A
  knowledge base that refuses the worker — its operator revoked the grant —
  stops that knowledge base's work alone. A start of a knowledge base that is
  itself added is refused: its worker serves it as its own already.

kb remove
  Remove a knowledge base added, and no other. The worker stops serving it at
  the next start; the grant stays until its operator revokes it.

kb list
  Each knowledge base added: its domain, its gateway, the issuer the gateway
  named, and the client the worker signs in as there.

The knowledge bases added are kept for the machine beside the worker's key.
None of what is kept is secret.
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
	switch args[0] {
	case "key":
		return workerKeyVerb(u, args[1:])
	case "kb":
		return workerKB(u, args[1:])
	}
	u.Fail("Unknown worker subcommand: %s", args[0])
	fmt.Fprint(os.Stderr, workerUsage)
	return 1
}

func workerKeyVerb(u *UI, args []string) int {
	asPEM := false
	for _, a := range args {
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
		"n":   base64url(pub.N.Bytes()),
		"e":   base64url(big.NewInt(int64(pub.E)).Bytes()),
		"kid": k.thumbprint,
		"alg": "RS256",
		"use": "sig",
	}}}, "", "  ")
	return string(b)
}

func workerKB(u *UI, args []string) int {
	if len(args) == 0 {
		u.Fail("worker kb takes add, remove or list")
		fmt.Fprint(os.Stderr, workerUsage)
		return 1
	}
	switch args[0] {
	case "add":
		return workerKBAdd(u, args[1:])
	case "remove":
		return workerKBRemove(u, args[1:])
	case "list":
		return workerKBList(u, args[1:])
	}
	u.Fail("Unknown worker kb subcommand: %s", args[0])
	fmt.Fprint(os.Stderr, workerUsage)
	return 1
}

func workerKBAdd(u *UI, args []string) int {
	flags, positional, ok := subcommandArgs(u, args, "--gateway", "--client-id")
	if !ok {
		return 1
	}
	if len(positional) != 1 {
		u.Fail("add takes one domain, the knowledge base's: semiont worker kb add <domain> --gateway <url> --client-id <id>")
		return 1
	}
	domain := positional[0]
	if _, err := semiont.KbDid(domain); err != nil {
		u.Fail("%q is not a knowledge base's domain: %v", domain, err)
		return 1
	}
	gateway, clientID := flags["--gateway"], flags["--client-id"]
	if gateway == "" || clientID == "" {
		u.Fail("add needs --gateway <url> and --client-id <id>: what `semiont identity grant` printed at the knowledge base.")
		return 1
	}
	added, err := loadAddedKBs()
	if err != nil {
		u.Fail("%v", err)
		return 1
	}
	issuer, err := advertisedIssuer(gateway)
	if err != nil {
		u.Fail("%v", err)
		fmt.Fprintln(os.Stderr, "  Nothing is added: the worker signs in at the issuer the gateway names.")
		return 1
	}
	kb := addedKB{Domain: domain, GatewayUrl: gateway}
	kb.Identity.Issuer, kb.Identity.ClientId = issuer, clientID
	at := slices.IndexFunc(added, func(a addedKB) bool { return a.Domain == domain })
	if at >= 0 {
		added[at] = kb
	} else {
		added = append(added, kb)
	}
	if err := saveAddedKBs(added); err != nil {
		u.Fail("Keeping the knowledge bases added to this machine's worker: %v", err)
		return 1
	}
	if at >= 0 {
		u.Ok("worker — replaced %s, which was added already", u.Bold(domain))
	} else {
		u.Ok("worker — added %s", u.Bold(domain))
	}
	printAddedKB(kb)
	fmt.Fprintln(os.Stderr, "  The next `semiont start` serves it.")
	return 0
}

func workerKBRemove(u *UI, args []string) int {
	_, positional, ok := subcommandArgs(u, args)
	if !ok {
		return 1
	}
	if len(positional) != 1 {
		u.Fail("remove takes one domain, the knowledge base's: semiont worker kb remove <domain>")
		return 1
	}
	domain := positional[0]
	added, err := loadAddedKBs()
	if err != nil {
		u.Fail("%v", err)
		return 1
	}
	at := slices.IndexFunc(added, func(a addedKB) bool { return a.Domain == domain })
	if at < 0 {
		u.Fail("%s is not added to this machine's worker.", domain)
		if len(added) == 0 {
			fmt.Fprintln(os.Stderr, "  None is added.")
		} else {
			var domains []string
			for _, kb := range added {
				domains = append(domains, kb.Domain)
			}
			fmt.Fprintf(os.Stderr, "  Added: %s\n", strings.Join(domains, ", "))
		}
		return 1
	}
	if err := saveAddedKBs(slices.Delete(added, at, at+1)); err != nil {
		u.Fail("Keeping the knowledge bases added to this machine's worker: %v", err)
		return 1
	}
	u.Ok("worker — removed %s", u.Bold(domain))
	fmt.Fprintln(os.Stderr, "  The worker stops serving it at the next `semiont start`; its grant there stays until its operator revokes it.")
	return 0
}

func workerKBList(u *UI, args []string) int {
	if len(args) > 0 {
		u.Fail("list takes no argument: %s", args[0])
		return 1
	}
	added, err := loadAddedKBs()
	if err != nil {
		u.Fail("%v", err)
		return 1
	}
	if len(added) == 0 {
		fmt.Fprintln(os.Stderr, "No knowledge base is added to this machine's worker: it serves the one each start runs.")
		return 0
	}
	for _, kb := range added {
		fmt.Println(kb.Domain)
		printAddedKB(kb)
	}
	return 0
}

// printAddedKB: what is kept of an added knowledge base, under its domain.
func printAddedKB(kb addedKB) {
	fmt.Printf("  Gateway:    %s\n", kb.GatewayUrl)
	fmt.Printf("  Issuer:     %s\n", kb.Identity.Issuer)
	fmt.Printf("  Client id:  %s\n", kb.Identity.ClientId)
}
