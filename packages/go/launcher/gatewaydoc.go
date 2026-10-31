package launcher

// gatewaydoc.go — the gateway's configuration document: GatewayConfig in
// specs/, the Go type generated from it (packages/go/sdk). The launcher
// writes it for the gateway it starts, every address a literal (placement), so
// the gateway neither reads a knowledge base's documents nor resolves or
// defaults anything. Secrets are never values in it: a credential is a
// variable a document names (`fromEnv`), and the gateway's document names it.

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// connectionAllowance: the memory a gateway's capacity sets aside for each open
// connection — about twice what an idle stream measured (images/gateway/bench).
const connectionAllowance = 20 << 10

// gatewaySecrets: the variables the gateway's document names, and so the ones
// it is handed — the pair of a broker somebody else runs, when the signal
// plane is that broker. The pair of the broker the launcher runs is the
// launcher's own (withDaemonCredentialVars).
func gatewaySecrets(p placement) []string {
	m := p.st.KnowledgeBase.Spec.Messaging
	if m.Signal.Type != "nats" || m.External == nil {
		return nil
	}
	return []string{m.External.User.FromEnv, m.External.Password.FromEnv}
}

// gatewayDocument renders the document from the start's placement and the
// knowledge base it serves.
func gatewayDocument(p placement, served api.KbIdentity) ([]byte, error) {
	kb := p.st.KnowledgeBase.Spec
	var doc api.GatewayConfig
	doc.Kb = served
	doc.Port = p.plan.GatewayPort
	doc.PublicUrl = kb.Gateway.PublicURL
	doc.Identity.Issuer = p.issuer()
	doc.Identity.SubjectClaim = kb.Issuer.SubjectClaim
	doc.Archivist.Host, doc.Archivist.Port = p.archivist()

	doc.Signal.Type = api.GatewayConfigSignalType(kb.Messaging.Signal.Type)
	if kb.Messaging.Signal.Type == "nats" {
		servers := p.brokerServers()
		doc.Signal.Servers = &servers
		if p.placed("messaging") {
			// The broker the launcher runs has the pair the launcher generates
			// and keeps; the gateway is handed both.
			user, password := "NATS_USER", daemonPasswords["messaging"].env
			doc.Signal.UserEnv, doc.Signal.PasswordEnv = &user, &password
		} else {
			external := kb.Messaging.External
			doc.Signal.UserEnv, doc.Signal.PasswordEnv = &external.User.FromEnv, &external.Password.FromEnv
		}
	}

	doc.LogLevel = kb.LogLevel
	doc.LogFormat = api.LogFormatJson

	// Its capacity follows from the memory its container is given: half for
	// the bytes queued to its streams, and the other half at a connection
	// allowance each.
	memory := int(memCeilingGB(p.plan.Memory["gateway"]) * (1 << 30))
	doc.Capacity.QueuedBytes = memory / 2
	doc.Capacity.Connections = memory / 2 / connectionAllowance
	return json.MarshalIndent(doc, "", "  ")
}

// userEnvValue: a variable's value as a start resolved it into its --env
// list — where the launcher itself needs a credential an external daemon's
// document names. A variable the start did not resolve refuses, naming it.
func userEnvValue(field, name string, userEnv []string) (string, error) {
	for i := 0; i+1 < len(userEnv); i += 2 {
		if userEnv[i] != "--env" {
			continue
		}
		if n, value, ok := strings.Cut(userEnv[i+1], "="); ok && n == name {
			return value, nil
		}
	}
	return "", fmt.Errorf("%s names the variable %s, which is not set", field, name)
}
