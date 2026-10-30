package readme

import (
	"fmt"
	"os"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// WorkerCredential is a worker's account at issuer, which proves itself with
// the key the launcher handed it.
func WorkerCredential(issuer, clientID string) (semiont.KeyCredential, error) {
	key, err := semiont.ParsePrivateKeyPEM(os.Getenv("SEMIONT_OIDC_CLIENT_KEY"))
	if err != nil {
		return semiont.KeyCredential{}, fmt.Errorf("SEMIONT_OIDC_CLIENT_KEY: %w", err)
	}
	return semiont.KeyCredential{Issuer: issuer, ClientID: clientID, PrivateKey: key}, nil
}
