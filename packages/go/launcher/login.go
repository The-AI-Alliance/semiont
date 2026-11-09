package launcher

// login.go — `semiont login`: sign in to a running stack's knowledge base
// through the issuer it trusts (the Go SDK's Issuer: resource metadata →
// discovery → device grant) and keep the session in the sign-in store
// (signins.go). The launcher never sees a password: the user approves the
// sign-in in a browser they trust, and only the tokens reach this process.

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"golang.org/x/term"
)

const loginUsage = `Usage: semiont login [--repo <owner/name> | --root <path> | --runtime <rt>]

Sign in to a running stack's knowledge base through the issuer it trusts,
and store the session (launcher state home, mode 0600). The launcher asks
the knowledge base which issuer it trusts, then runs the OAuth device grant:
it prints a URL and a code, you approve the sign-in in a browser, and the
tokens come back here. No password ever reaches this process.

Sessions renew themselves from the stored refresh token; sign in again only
when the issuer says so.

Options:
  --repo <owner/name>  Target a codespace stack
  --root <path>        Target the stack of the knowledge base at path
  --runtime <rt>       Target a stack here
  --help               Show this help
`

func Login(args []string) int {
	u := NewUI(false)
	repo, wantLocal := "", false
	rootFlag := ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--repo":
			if i+1 >= len(args) {
				u.Fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
			i++
		case "--root":
			if i+1 >= len(args) {
				u.Fail("Missing value for --root")
				return 1
			}
			rootFlag = args[i+1]
			i++
		case "--runtime":
			if i+1 >= len(args) {
				u.Fail("Missing value for --runtime")
				return 1
			}
			wantLocal = true
			i++
		case "--help", "-h":
			fmt.Print(loginUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", args[i])
			return 1
		}
	}

	target, ok := SelectVerbStack(u, "login", LoadStackSet(), repo, rootFlag, wantLocal)
	if !ok {
		return 1
	}
	if _, ok := signIn(context.Background(), u, target, func(code semiont.DeviceCode) {
		promptToOpen(u, code)
		u.Log("Waiting for approval at the issuer...")
	}); !ok {
		return 1
	}
	return 0
}

// signIn signs in to the knowledge base of target, the stack SelectVerbStack
// chose, through the issuer it trusts, and keeps the session. shown is given
// the one-time code the person approves the sign-in with. ok=false: refused,
// and said.
func signIn(ctx context.Context, u *UI, target *StackState, shown func(semiont.DeviceCode)) (ControlAuthLoginResult, bool) {
	base, ok := StackBase(u, target, "login")
	if !ok {
		return ControlAuthLoginResult{}, false
	}
	key := StackKey(target)

	issuer := semiont.Issuer{HTTP: &http.Client{Transport: launcherTransport}, Timing: semiont.DefaultTiming()}
	endpoints, err := issuer.Discover(ctx, base)
	if err != nil {
		u.Refuse(controlCodeUnreachable, "%v", err)
		fmt.Fprintln(os.Stderr, "  Is the stack up?  semiont status")
		return ControlAuthLoginResult{}, false
	}
	u.Log("Issuer: %s %s", endpoints.Issuer, u.Dim("(named by the knowledge base's resource metadata)"))

	tokens, err := issuer.SignInWithDeviceGrant(ctx, endpoints, shown)
	if err != nil {
		u.Refuse(controlCodeSignInFailed, "Sign-in failed: %v", err)
		return ControlAuthLoginResult{}, false
	}
	noteSecret(tokens.Access)
	noteSecret(tokens.Refresh)

	// The gateway is the judge of the token, not the issuer: a refusal here
	// means the realm's audience mapper and the knowledge base's own resource
	// identifier disagree, and keeping the token would only defer that error
	// to the first verb.
	asker := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{
		BaseURL: base, Token: semiont.NewVariable(tokens.Access),
		HTTP: &http.Client{Transport: launcherTransport}, Timing: semiont.DefaultTiming(),
	})
	me, err := asker.GetCurrentUser(ctx)
	asker.Close()
	if unauthorized(err) {
		u.Refuse(controlCodeSignInFailed, "The issuer signed you in, but the gateway rejected the token — the realm's audience mapper and this knowledge base's resource identifier disagree.")
		return ControlAuthLoginResult{}, false
	}
	if err != nil {
		u.Refuse(controlCodeUnreachable, "Gateway unreachable at %s: %v", base, err)
		return ControlAuthLoginResult{}, false
	}

	if err := keepSignIn(ctx, key, semiont.HeldSignIn{
		Access:             tokens.Access,
		Refresh:            tokens.Refresh,
		ClientID:           semiont.ScriptClientID,
		TokenEndpoint:      endpoints.Token,
		RevocationEndpoint: endpoints.Revocation,
	}); err != nil {
		u.Refuse(controlCodeSignInFailed, "Token could not be stored (%v) — NOT logged in.", err)
		return ControlAuthLoginResult{}, false
	}
	who := me.Did.String()
	if me.Email != nil {
		who = *me.Email
	}
	u.Ok("Logged in to %s as %s %s", key, who, u.Dim("(token in "+tokensPath()+")"))
	return ControlAuthLoginResult{Key: key, Who: who, Issuer: endpoints.Issuer}, true
}

// NoGatewayRecorded: a local stack's record names no gateway endpoint, so
// there is no address to reach its KB at. None is made up: a start records
// the endpoint, on whatever port the config gave it.
type NoGatewayRecorded struct{}

func (*NoGatewayRecorded) Error() string { return "the stack's record names no gateway" }

// GatewayBase is the API base URL of the local stack's gateway, from its
// recorded health endpoint — the record knows the real port even when the
// config moved it. A record that names none is a *NoGatewayRecorded.
func GatewayBase(st *StackState) (string, error) {
	if e, ok := st.Services["gateway"]; ok {
		if b, found := strings.CutSuffix(e.Endpoint, "/api/health"); found && b != "" {
			return b, nil
		}
	}
	return "", &NoGatewayRecorded{}
}

// localBase is GatewayBase for verb. ok=false: the record names no gateway,
// which was said with the command that records one.
func localBase(u *UI, st *StackState, verb string) (string, bool) {
	base, err := GatewayBase(st)
	if err != nil {
		u.Refuse(controlCodeStackNotRunning, "%v, so %s cannot reach its KB.", err, verb)
		fmt.Fprintln(os.Stderr, "  Start it:  semiont start")
		return "", false
	}
	return base, true
}

// readPassword reads one line from stdin. On a terminal the prompt goes to
// stderr and the line is read with echo off; piped input is read as-is, which
// is the scripting path.
func readPassword(u *UI) (string, bool) {
	var line string
	var err error
	if fd := int(os.Stdin.Fd()); term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "Password: ")
		var typed []byte
		typed, err = term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		line = string(typed)
	} else {
		line, err = bufio.NewReader(os.Stdin).ReadString('\n')
	}
	pw := strings.TrimRight(line, "\r\n")
	if pw == "" {
		if err != nil {
			u.Fail("No password on stdin.")
		} else {
			u.Fail("Empty password.")
		}
		return "", false
	}
	return pw, true
}
