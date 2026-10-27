package registry

// A registry's sign-in through the issuer, by a page redirect: the pending
// sign-in is remembered in the registry's storage, and its completion lands
// on the entry for the knowledge base that answered.

import (
	"context"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// BeginSignIn begins a sign-in for a registry: it finds the issuer the target
// trusts, remembers the pending sign-in in the registry's storage, and gives
// the URL to send the person to.
func BeginSignIn(ctx context.Context, browser *SemiontBrowser, issuer semiont.Issuer, options semiont.BeginAuthorizationOptions) (string, error) {
	return semiont.BeginAuthorization(ctx, issuer, options, browser.Storage())
}

// CompleteSignIn finishes a sign-in from the URL the issuer sent the person
// back to: it exchanges the code, asks the knowledge base who it is, and has
// the registry land the sign-in on the entry for the knowledge base that
// answered (SemiontBrowser.SignedIn). The failure is a *semiont.SignInError
// when the grant failed, and a *semiont.IdentityUnverifiableError when it
// succeeded and the knowledge base could not say who it is; then nothing is
// registered, and nothing is stored.
func CompleteSignIn(ctx context.Context, browser *SemiontBrowser, issuer semiont.Issuer, callbackURL string) (SignInOutcome, error) {
	pending, tokens, err := semiont.CompleteAuthorization(ctx, issuer, callbackURL, browser.Storage())
	if err != nil {
		return SignInOutcome{}, err
	}
	identity, err := semiont.DescribeConnection(ctx, pending.Target, tokens.Access, issuer.HTTP, issuer.Timing)
	if err != nil {
		return SignInOutcome{}, err
	}
	var endpoint api.KbEndpoint
	if err := endpoint.FromHttpEndpoint(pending.Target); err != nil {
		// An endpoint read back from the pending record writes as it was read.
		panic(err)
	}
	return browser.SignedIn(SignedIn{
		Endpoint:    endpoint,
		Description: identity.Description,
		Session: StoredSession{
			Access:             tokens.Access,
			Refresh:            tokens.Refresh,
			ClientID:           semiont.BrowserClientID,
			TokenEndpoint:      pending.Issuer.Token,
			RevocationEndpoint: pending.Issuer.Revocation,
		},
		KbID:         pending.KbID,
		ExpectedDid:  pending.ExpectedDid,
		ExpectedName: pending.ExpectedName,
	})
}
