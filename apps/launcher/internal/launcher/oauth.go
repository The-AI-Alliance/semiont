package launcher

// oauth.go — what of signing in is the launcher's own: the issuer a
// knowledge base advertises, read before anything dials it; the one-time code
// shown to a person and the browser offered to them, during `semiont login`'s
// device grant, which the Go SDK makes (semiont.Issuer); and a small JSON
// read. Nothing here names a vendor, and no process ever holds a password.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"golang.org/x/term"
)

// trustedIssuer: the issuer a KB's resource metadata names — the gateway's
// word, read before anything dials the issuer itself.
func trustedIssuer(ctx context.Context, cli *api.ClientWithResponses, base string) (string, error) {
	meta, err := cli.GetProtectedResourceMetadataWithResponse(ctx)
	if err != nil {
		return "", fmt.Errorf("gateway unreachable at %s: %w", base, err)
	}
	if meta.JSON200 == nil || len(meta.JSON200.AuthorizationServers) == 0 {
		return "", fmt.Errorf("gateway at %s published no authorization server (HTTP %d)", base, meta.HTTPResponse.StatusCode)
	}
	return meta.JSON200.AuthorizationServers[0], nil
}

// advertisedIssuer: trustedIssuer for a KB at base, on a fresh client.
func advertisedIssuer(base string) (string, error) {
	cli, err := api.NewClientWithResponses(base)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return trustedIssuer(ctx, cli, base)
}

// promptToOpen shows the one-time code and, on a terminal, offers to open the
// issuer's page.
//
// The code is printed FIRST and on its own line, because it is the one thing a
// person has to carry out of the terminal: the device flow expects them to
// check that the page shows the same code, and they need it verbatim if they
// approve on a different machine.
//
// `verification_uri_complete` carries the code already, so that is what gets
// opened; the SHORT uri is what gets printed, since that is the one somebody
// retypes on a phone.
//
// Nothing is opened when stdin is not a terminal. `semiont login` runs from
// scripts, and a CI box either has no browser or should not be sent to one —
// there nothing is asked, and the poll starts immediately.
func promptToOpen(u *UI, code semiont.DeviceCode) {
	valid := u.Dim("(valid " + code.ExpiresIn.Round(time.Second).String() + ")")
	u.Log("Your one-time code: %s %s", u.Bold(code.UserCode), valid)

	where := code.VerificationURIComplete
	if where == "" {
		where = code.VerificationURI
	}
	// The URI is printed UNCONDITIONALLY, before any question of opening it.
	// It is what a person needs when the browser does not open, opens on the
	// wrong machine, or is not where they want to approve — so it must not be
	// gated on detecting a terminal correctly.
	u.Log("To sign in, open %s and enter it.", u.Bold(code.VerificationURI))

	if !stdinIsTerminal() {
		return
	}
	fmt.Fprintf(os.Stderr, "Press Enter to open it in your browser (Ctrl-C to open it yourself)... ")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	if err := openBrowser(where); err != nil {
		u.Warn("Could not open a browser (%v).", err)
	}
}

// stdinIsTerminal: whether a PERSON is at stdin.
//
// `os.Stdin.Stat()` and `ModeCharDevice` is the usual shorthand and it is
// wrong here: `/dev/null` is a character device, so a CI step — whose stdin is
// commonly /dev/null — reads as interactive under it, and this would prompt
// a runner that has no browser. term.IsTerminal asks the real question: it
// succeeds only on a terminal, on every system.
func stdinIsTerminal() bool {
	return term.IsTerminal(int(os.Stdin.Fd()))
}

// browserCommand: how one platform opens a URL. Separated from running it so
// the mapping is a fact a test can read, not a guess compiled into one branch.
//
// One entry per system the launcher builds for; anything else is treated as
// Linux. Windows has no `open`: rundll32 hands the URL to whatever handles it.
func browserCommand(goos, url string) []string {
	switch goos {
	case "darwin":
		return []string{"open", url}
	case "windows":
		return []string{"rundll32", "url.dll,FileProtocolHandler", url}
	}
	return []string{"xdg-open", url}
}

// openBrowser hands a URL to whatever the platform uses, shelled out rather
// than taken as a dependency.
func openBrowser(url string) error {
	argv := browserCommand(runtime.GOOS, url)
	return exec.Command(argv[0], argv[1:]...).Start()
}

// fetchJSON GETs a JSON document within a timeout. The error names the step
// that failed; a probe that only needs yes/no compares it to nil. The body
// is capped at 1 MiB — every document this launcher reads is small, and a
// misdirected URL must not be read to exhaustion.
func fetchJSON(target string, timeout time.Duration, out any) error {
	c := &http.Client{Transport: launcherTransport, Timeout: timeout}
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d from %s", resp.StatusCode, target)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}
