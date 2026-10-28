package semiont

// A knowledge base's gateway as its HTTP endpoint names it. Its origin is what
// a session sends its requests to and opens its stream at, and every SDK makes
// it alike (specs/src/session/gateway-url-cases.json).

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

var hostLabel = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

// IsValidHostname reports whether host is a host's name: labels of ASCII letters,
// digits and hyphens with a dot between each two, every label 1 to 63
// characters long and none beginning or ending with a hyphen. localhost and a
// dotted address are such names; a host with a slash, a colon or a query is
// not.
func IsValidHostname(host string) bool {
	for _, label := range strings.Split(host, ".") {
		if !hostLabel.MatchString(label) {
			return false
		}
	}
	return true
}

// GatewayURL is the origin of the gateway endpoint names: the protocol, the
// host in lowercase and nothing else done to it, and the port, written even
// when it is the protocol's own. A host that is not a host's name is refused:
// a name a person typed is never put into a URL unread.
func GatewayURL(endpoint api.HttpEndpoint) (string, error) {
	if !IsValidHostname(endpoint.Host) {
		return "", fmt.Errorf("invalid knowledge base host name: %q", endpoint.Host)
	}
	return fmt.Sprintf("%s://%s:%d", endpoint.Protocol, strings.ToLower(endpoint.Host), endpoint.Port), nil
}
