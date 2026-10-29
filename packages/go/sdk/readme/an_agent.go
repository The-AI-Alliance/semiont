package readme

import (
	"context"
	"fmt"
	"net/http"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// Work signs the agent in, and opens a stream as it.
func Work(ctx context.Context, gateway, issuer, secret string) error {
	timing := semiont.DefaultTiming()
	service := semiont.NewServiceToken(
		semiont.Credential{Issuer: issuer, ClientID: "semiont-smelter", ClientSecret: secret},
		semiont.Issuer{HTTP: http.DefaultClient, Timing: timing},
	)
	agent, err := semiont.SignInAgent(ctx, semiont.AgentConfig{
		Gateway: gateway, Provider: "ollama", Model: "gemma2:27b", Service: service, HTTP: http.DefaultClient, Timing: timing,
	})
	if err != nil {
		return err
	}
	defer agent.Close()
	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{
		BaseURL: gateway, Token: agent.Token(), Refresher: agent, Channels: semiont.JobClaimChannels,
		HTTP: http.DefaultClient, Timing: timing,
	})
	defer transport.Close()
	fmt.Println("working as", agent.DID()) // who its work is attributed to, as the gateway named it
	for state := range transport.State().Changes(ctx) {
		if state == semiont.ConnectionStateOpen {
			fmt.Println("its stream is open, as the agent")
			return nil
		}
	}
	return ctx.Err()
}
