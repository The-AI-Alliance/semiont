package semionttest

import (
	"context"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// TestSessionConfig is what a test session is built over.
type TestSessionConfig struct {
	// Client is the test client the session is over.
	Client TestClientConfig
	// Kb is the knowledge base the session is with: with none, test-kb at
	// http://localhost:4000.
	Kb *api.KbTarget
	// Kept is where the session's sign-in is kept: a sign-in held there is
	// the session's at its start. With none, a semiont.MemorySignIn that holds
	// nothing.
	Kept semiont.SignInKept
}

// TestSession is a session, and what it was built over.
type TestSession struct {
	Session   *semiont.Session
	Client    *semiont.Client
	Transport *FaultyTransport
	Content   *InMemoryContent
	// Kept is where the session's sign-in is kept.
	Kept semiont.SignInKept
	// Token is the token the session holds. A test that needs a signed-in
	// session sets one.
	Token *semiont.Variable[string]
}

// NewTestSession is a real semiont.Session over a test client. It renews
// nothing and asks nobody who it is, so it is ready as soon as it has read its
// sign-in, and holds a token only if one was kept. The caller ends the session
// and then the client, and then the transport: the session only uses them.
func NewTestSession(config TestSessionConfig) (TestSession, error) {
	client := NewTestClient(config.Client)
	kb := api.KbTarget{Id: "test-kb", Label: "Test KB"}
	if config.Kb != nil {
		kb = *config.Kb
	} else if err := kb.Endpoint.FromHttpEndpoint(api.HttpEndpoint{Kind: api.HttpEndpointKindHttp, Host: "localhost", Port: 4000, Protocol: api.HttpEndpointProtocolHttp}); err != nil {
		// An endpoint of a host, a port and two of the spec's own words always
		// encodes.
		panic(err)
	}
	kept := config.Kept
	if kept == nil {
		kept = &semiont.MemorySignIn{}
	}
	token := semiont.NewVariable("")
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb:     kb,
		Client: client.Client,
		Token:  token,
		Kept:   kept,
		Timing: semiont.DefaultTiming(),
	})
	if err != nil {
		client.Client.Close()
		client.Transport.Close()
		return TestSession{}, err
	}
	return TestSession{Session: session, Client: client.Client, Transport: client.Transport, Content: client.Content, Kept: kept, Token: token}, nil
}
