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

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"golang.org/x/term"
)

const loginUsage = `Usage: semiont login [--repo <owner/name> | --runtime <rt>]

Sign in to a running stack's knowledge base through the issuer it trusts,
and store the session (launcher state home, mode 0600). The launcher asks
the knowledge base which issuer it trusts, then runs the OAuth device grant:
it prints a URL and a code, you approve the sign-in in a browser, and the
tokens come back here. No password ever reaches this process.

Sessions renew themselves from the stored refresh token; sign in again only
when the issuer says so.

Options:
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help
`

func Login(args []string) int {
	u := NewUI(false)
	repo, wantLocal := "", false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--repo":
			if i+1 >= len(args) {
				u.Fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
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

	ss := LoadStackSet()
	target, ok := SelectVerbStack(u, "login", ss, repo, wantLocal)
	if !ok {
		return 1
	}
	base, key := "", ""
	if target != nil {
		if base, ok = ForwardedBase(u, target, "login"); !ok {
			return 1
		}
		key = "codespace:" + target.Codespace.Repo
	} else {
		local := ss.Stacks["local"]
		if local == nil {
			u.Fail("login needs a running stack, and none is recorded.")
			fmt.Fprintln(os.Stderr, "  Start one first:  semiont start")
			return 1
		}
		if base, ok = LocalBase(u, local, "login"); !ok {
			return 1
		}
		key = "local"
	}

	ctx := context.Background()
	issuer := semiont.Issuer{HTTP: &http.Client{Transport: launcherTransport}, Timing: semiont.DefaultTiming()}
	endpoints, err := issuer.Discover(ctx, base)
	if err != nil {
		u.Fail("%v", err)
		fmt.Fprintln(os.Stderr, "  Is the stack up?  semiont status")
		return 1
	}
	u.Log("Issuer: %s %s", endpoints.Issuer, u.Dim("(named by the knowledge base's resource metadata)"))

	tokens, err := issuer.SignInWithDeviceGrant(ctx, endpoints, func(code semiont.DeviceCode) {
		promptToOpen(u, code)
		u.Log("Waiting for approval at the issuer...")
	})
	if err != nil {
		u.Fail("Sign-in failed: %v", err)
		return 1
	}

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
		u.Fail("The issuer signed you in, but the gateway rejected the token — the realm's audience mapper and this knowledge base's resource identifier disagree.")
		return 1
	}
	if err != nil {
		u.Fail("Gateway unreachable at %s: %v", base, err)
		return 1
	}

	if err := keepSignIn(ctx, key, semiont.HeldSignIn{
		Access:             tokens.Access,
		Refresh:            tokens.Refresh,
		ClientID:           semiont.ScriptClientID,
		TokenEndpoint:      endpoints.Token,
		RevocationEndpoint: endpoints.Revocation,
	}); err != nil {
		u.Fail("Token could not be stored (%v) — NOT logged in.", err)
		return 1
	}
	u.Ok("Logged in to %s as %s %s", key, me.Email, u.Dim("(token in "+tokensPath()+")"))
	return 0
}

// NoGatewayRecorded: a local stack's record names no gateway endpoint, so
// there is no address to reach its KB at. None is made up: a start records
// the endpoint, on whatever port the config gave it.
type NoGatewayRecorded struct{}

func (*NoGatewayRecorded) Error() string { return "the local stack's record names no gateway" }

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

// LocalBase is GatewayBase for verb. ok=false: the record names no gateway,
// which was said with the command that records one.
func LocalBase(u *UI, st *StackState, verb string) (string, bool) {
	base, err := GatewayBase(st)
	if err != nil {
		u.Fail("%v, so %s cannot reach its KB.", err, verb)
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
