package launcher

// login.go — `semiont login`: sign in to a running stack's knowledge base
// through the issuer it trusts (oauth.go: resource metadata → discovery →
// device grant) and store the session tokens per stack (tokens.go). The
// launcher never sees a password: the user approves the sign-in in a browser
// they trust, and only the tokens reach this process.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
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
	u := newUI(false)
	repo, wantLocal := "", false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--repo":
			if i+1 >= len(args) {
				u.fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
			i++
		case "--runtime":
			if i+1 >= len(args) {
				u.fail("Missing value for --runtime")
				return 1
			}
			wantLocal = true
			i++
		case "--help", "-h":
			fmt.Print(loginUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", args[i])
			return 1
		}
	}

	ss := loadStackSet()
	target, ok := selectVerbStack(u, "login", ss, repo, wantLocal)
	if !ok {
		return 1
	}
	base, key := "", ""
	if target != nil {
		base = fmt.Sprintf("http://localhost:%d", target.ForwardPort)
		key = "codespace:" + target.Repo
	} else {
		local := ss.Stacks["local"]
		if local == nil {
			u.fail("login needs a running stack, and none is recorded.")
			fmt.Fprintln(os.Stderr, "  Start one first:  semiont start")
			return 1
		}
		base = gatewayBase(local)
		key = "local"
	}

	cli, err := semiont.NewClientWithResponses(base)
	if err != nil {
		u.fail("client: %v", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	ep, err := discoverIssuer(ctx, cli, base)
	cancel()
	if err != nil {
		if errors.Is(err, errNoIssuer) {
			u.fail("The knowledge base at %s trusts no external issuer, so there is nothing to sign in to.", base)
			fmt.Fprintln(os.Stderr, "  Add an [identity] section to its config — the launcher runs Keycloak by default:")
			fmt.Fprintln(os.Stderr, "    [environments.<env>.identity]")
			fmt.Fprintln(os.Stderr, "    type = \"keycloak\"")
			fmt.Fprintln(os.Stderr, "    issuer = \"http://${KEYCLOAK_HOST}:8080/realms/semiont\"")
			return 1
		}
		u.fail("%v", err)
		fmt.Fprintln(os.Stderr, "  Is the stack up?  semiont status")
		return 1
	}
	u.log("Issuer: %s %s", ep.Issuer, u.dim("(named by the knowledge base's resource metadata)"))

	tr, err := deviceLogin(context.Background(), u, ep)
	if err != nil {
		u.fail("Sign-in failed: %v", err)
		return 1
	}

	// The gateway is the judge of the token, not the issuer: a 401 here means
	// the realm's audience mapper and the knowledge base's own resource
	// identifier disagree, and storing the token would only defer that error
	// to the first verb.
	ctx, cancel = context.WithTimeout(context.Background(), 15*time.Second)
	me, err := cli.GetApiUsersMeWithResponse(ctx, bearer(tr.AccessToken))
	cancel()
	if err != nil {
		u.fail("Gateway unreachable at %s: %v", base, err)
		return 1
	}
	if me.JSON200 == nil {
		u.fail("The issuer signed you in, but the gateway rejected the token (HTTP %d) — the realm's audience mapper and this knowledge base's resource identifier disagree.", me.HTTPResponse.StatusCode)
		return 1
	}
	email := string(me.JSON200.Email)
	now := time.Now().UTC()
	if err := saveToken(key, tokenEntry{
		Token:              tr.AccessToken,
		RefreshToken:       tr.RefreshToken,
		Email:              email,
		ObtainedAt:         now,
		ExpiresAt:          expiresAt(now, tr.ExpiresIn),
		Issuer:             ep.Issuer,
		TokenEndpoint:      ep.Token,
		RevocationEndpoint: ep.Revocation,
	}); err != nil {
		u.fail("Token could not be stored (%v) — NOT logged in.", err)
		return 1
	}
	u.ok("Logged in to %s as %s %s", key, email, u.dim("(token in "+tokensPath()+")"))
	return 0
}

// gatewayBase derives the API base URL from the local stack's recorded
// gateway health endpoint — the record knows the real port even when the
// config moved it.
func gatewayBase(st *stackState) string {
	if e, ok := st.Services["gateway"]; ok {
		if b, found := strings.CutSuffix(e.Endpoint, "/api/health"); found && b != "" {
			return b
		}
	}
	return "http://localhost:4000"
}

// readPassword reads one line from stdin. On a terminal the prompt goes to
// stderr and echo is disabled via stty (best-effort — no extra dependency);
// piped input is read as-is, which is the scripting path.
func readPassword(u *ui) (string, bool) {
	fi, err := os.Stdin.Stat()
	tty := err == nil && fi.Mode()&os.ModeCharDevice != 0
	if tty {
		fmt.Fprint(os.Stderr, "Password: ")
		off := exec.Command("stty", "-echo")
		off.Stdin = os.Stdin
		_ = off.Run()
		defer func() {
			on := exec.Command("stty", "echo")
			on.Stdin = os.Stdin
			_ = on.Run()
			fmt.Fprintln(os.Stderr)
		}()
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	pw := strings.TrimRight(line, "\r\n")
	if pw == "" {
		if err != nil {
			u.fail("No password on stdin.")
		} else {
			u.fail("Empty password.")
		}
		return "", false
	}
	return pw, true
}
