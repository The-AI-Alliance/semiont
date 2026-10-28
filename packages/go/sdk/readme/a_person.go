package readme

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

func show(code semiont.DeviceCode) {
	fmt.Printf("Open %s and enter %s\n", code.VerificationURI, code.UserCode)
}

// AsMe is a session as the person signed in to kb, by `semiont login` or by
// the device grant here.
func AsMe(ctx context.Context, kb api.KbTarget, home string) error {
	directory, ok := semiont.StateDir(semiont.ThisSystem(), home, "", "")
	if !ok {
		return errors.New("this system keeps no sign-ins")
	}
	// The sign-in of the stack `semiont login` keys as the knowledge base's id.
	kept := semiont.NewSignInStore(filepath.Join(directory, semiont.SignInFile)).Entry(kb.Id)
	timing := semiont.DefaultTiming()
	if _, held, err := kept.Held(ctx); err != nil {
		return err
	} else if !held {
		endpoint, err := kb.Endpoint.AsHttpEndpoint()
		if err != nil {
			return err
		}
		gateway, err := semiont.GatewayURL(endpoint)
		if err != nil {
			return err
		}
		issuer := semiont.Issuer{HTTP: http.DefaultClient, Timing: timing}
		if _, err := semiont.SignInWithDevice(ctx, issuer, gateway, kept, show); err != nil {
			return err
		}
	}
	session, end, err := semiont.SessionFromKept(ctx, semiont.SessionFromKeptConfig{
		Kb: kb, Kept: kept, HTTP: http.DefaultClient, Timing: timing, AskWhoTokenIs: true, Channels: bus.BridgedChannels,
	})
	if err != nil {
		return err
	}
	defer end() // the session, then its client and its transport
	status, err := session.Client().System.Status(ctx)
	if err != nil {
		return err
	}
	if me := session.User().Value(); me != nil {
		fmt.Println(me.Email, status.Version)
	}
	return nil
}
