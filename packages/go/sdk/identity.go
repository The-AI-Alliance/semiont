package semiont

// How a knowledge base is named, and the principals who act in it. Every
// function here is held to a case table every implementation runs: the
// knowledge base's own names to specs/src/kb-identity/cases.json, the rest to
// specs/src/principals/cases.json.

import (
	"fmt"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// EncodeUriComponent is value as ECMAScript's encodeURIComponent writes it:
// each UTF-8 byte of every character other than A–Z a–z 0–9 and -_.!~*'() as
// %XX, in uppercase hex.
func EncodeUriComponent(value string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// KbDid is the knowledge base's DID: did:web: and its domain as it is, which
// is already a colon path. A domain no DID can hold is refused, as
// api.ParseUserId refuses it.
func KbDid(domain string) (api.UserId, error) {
	return api.ParseUserId("did:web:" + domain)
}

// KbResource is the knowledge base's resource identifier, the audience its
// tokens carry: its DID as an https URL, the colon path a slash path.
func KbResource(domain string) string {
	return "https://" + strings.ReplaceAll(domain, ":", "/")
}

// PersonDid is a person, named by the subject the issuer asserted.
func PersonDid(domain, subject string) (api.UserId, error) {
	return api.ParseUserId("did:web:" + domain + ":users:" + EncodeUriComponent(subject))
}

// AgentDid is a software agent: one per provider and model, under the
// knowledge base's domain.
func AgentDid(domain, provider, model string) (api.UserId, error) {
	return api.ParseUserId("did:web:" + domain + ":agents:" + EncodeUriComponent(provider) + ":" + EncodeUriComponent(model))
}

// AgentAddress is an agent's address: provider:model, with every run of
// characters outside [A-Za-z0-9-] one hyphen and none at either end, at
// agents. and the domain up to its first colon.
func AgentAddress(domain, provider, model string) string {
	var slug strings.Builder
	for _, c := range provider + ":" + model {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			c = '-'
		}
		if c == '-' && strings.HasSuffix(slug.String(), "-") {
			continue
		}
		slug.WriteRune(c)
	}
	host, _, _ := strings.Cut(domain, ":")
	return strings.Trim(slug.String(), "-") + "@agents." + host
}

// AgentName is an agent's name.
func AgentName(provider, model string) string {
	return provider + " " + model
}
