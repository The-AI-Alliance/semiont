package launcher

// oauth.go — the launcher as an OAuth public client (client id semiont-cli):
// issuer discovery from a knowledge base's resource metadata (RFC 9728), the
// device authorization grant (RFC 8628) behind `semiont login`, the refresh
// grant behind every verb's invisible renewal, and token revocation (RFC
// 7009) behind `semiont logout`. Plain HTTP against the issuer; nothing here
// names a vendor, and no process ever holds a password.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

const (
	cliClientID = "semiont-cli"
	// offline_access asks for a refresh token that outlives the issuer's
	// browser session — a CLI session is a once-a-month event, not an
	// hourly chore.
	deviceScope     = "openid email profile offline_access"
	deviceGrantType = "urn:ietf:params:oauth:grant-type:device_code"
)

// errNoIssuer: the knowledge base trusts no external issuer (no [identity]
// section), so there is nothing to sign in to.
var errNoIssuer = errors.New("the knowledge base trusts no external issuer")

type issuerEndpoints struct {
	Issuer              string `json:"issuer"`
	DeviceAuthorization string `json:"device_authorization_endpoint"`
	Token               string `json:"token_endpoint"`
	Revocation          string `json:"revocation_endpoint"`
}

// discoverIssuer: the knowledge base names its issuer (resource metadata),
// the issuer names its endpoints (OIDC discovery). No configuration on this
// side — a client that knows a gateway's address knows everything.
func discoverIssuer(ctx context.Context, cli *semiont.ClientWithResponses, base string) (issuerEndpoints, error) {
	meta, err := cli.GetWellKnownOauthProtectedResourceWithResponse(ctx)
	if err != nil {
		return issuerEndpoints{}, fmt.Errorf("gateway unreachable at %s: %w", base, err)
	}
	if meta.JSON404 != nil {
		return issuerEndpoints{}, errNoIssuer
	}
	if meta.JSON200 == nil || len(meta.JSON200.AuthorizationServers) == 0 {
		return issuerEndpoints{}, fmt.Errorf("gateway at %s published no authorization server (HTTP %d)", base, meta.HTTPResponse.StatusCode)
	}
	issuer := meta.JSON200.AuthorizationServers[0]
	var ep issuerEndpoints
	if err := fetchJSON(strings.TrimSuffix(issuer, "/")+"/.well-known/openid-configuration", 15*time.Second, &ep); err != nil {
		return issuerEndpoints{}, fmt.Errorf("issuer %s: discovery failed: %w", issuer, err)
	}
	if ep.Issuer != issuer {
		return issuerEndpoints{}, fmt.Errorf("issuer %s: its discovery document names a different issuer (%s)", issuer, ep.Issuer)
	}
	if ep.Token == "" {
		return issuerEndpoints{}, fmt.Errorf("issuer %s: discovery names no token endpoint", issuer)
	}
	if ep.DeviceAuthorization == "" {
		return issuerEndpoints{}, fmt.Errorf("issuer %s offers no device authorization endpoint — semiont login needs the device grant (RFC 8628) enabled for client %s", issuer, cliClientID)
	}
	return ep, nil
}

type deviceAuthorization struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type tokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	TokenType        string `json:"token_type"`
	ExpiresIn        int    `json:"expires_in"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// deviceLogin runs the device authorization grant: ask the issuer for a code,
// tell the user where to enter it, poll the token endpoint at the issuer's
// interval until approval, denial, or expiry.
func deviceLogin(ctx context.Context, u *ui, ep issuerEndpoints) (tokenResponse, error) {
	var da deviceAuthorization
	status, err := postForm(ctx, ep.DeviceAuthorization, url.Values{
		"client_id": {cliClientID},
		"scope":     {deviceScope},
	}, &da)
	if err != nil {
		return tokenResponse{}, fmt.Errorf("device authorization request: %w", err)
	}
	if status != http.StatusOK || da.DeviceCode == "" {
		return tokenResponse{}, fmt.Errorf("issuer refused the device authorization request (HTTP %d)", status)
	}
	where := da.VerificationURIComplete
	if where == "" {
		where = da.VerificationURI
	}
	expires := time.Duration(da.ExpiresIn) * time.Second
	if expires <= 0 {
		expires = 10 * time.Minute
	}
	u.log("To sign in, open %s %s", u.bold(where), u.dim("(code "+da.UserCode+", valid "+expires.Round(time.Second).String()+")"))
	u.log("Waiting for approval at the issuer...")

	interval := time.Duration(da.Interval) * time.Second
	if interval < time.Second {
		interval = time.Second
	}
	deadline := time.Now().Add(expires)
	for {
		select {
		case <-ctx.Done():
			return tokenResponse{}, ctx.Err()
		case <-time.After(interval):
		}
		if time.Now().After(deadline) {
			return tokenResponse{}, errors.New("the code expired before it was approved — run semiont login again")
		}
		var tr tokenResponse
		status, err := postForm(ctx, ep.Token, url.Values{
			"grant_type":  {deviceGrantType},
			"device_code": {da.DeviceCode},
			"client_id":   {cliClientID},
		}, &tr)
		if err != nil {
			return tokenResponse{}, fmt.Errorf("token request: %w", err)
		}
		switch {
		case status == http.StatusOK && tr.AccessToken != "":
			return tr, nil
		case tr.Error == "authorization_pending":
		case tr.Error == "slow_down":
			interval += 5 * time.Second
		case tr.Error == "access_denied":
			return tokenResponse{}, errors.New("sign-in was denied at the issuer")
		case tr.Error == "expired_token":
			return tokenResponse{}, errors.New("the code expired before it was approved — run semiont login again")
		default:
			return tokenResponse{}, fmt.Errorf("issuer returned HTTP %d: %s %s", status, tr.Error, tr.ErrorDescription)
		}
	}
}

// refreshTokens: the refresh grant. An issuer may rotate the refresh token;
// the response carries whichever is now current.
func refreshTokens(ctx context.Context, tokenEndpoint, refreshToken string) (tokenResponse, error) {
	var tr tokenResponse
	status, err := postForm(ctx, tokenEndpoint, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {cliClientID},
	}, &tr)
	if err != nil {
		return tokenResponse{}, err
	}
	if status != http.StatusOK || tr.AccessToken == "" {
		return tokenResponse{}, fmt.Errorf("issuer returned HTTP %d: %s %s", status, tr.Error, tr.ErrorDescription)
	}
	return tr, nil
}

// revokeToken: RFC 7009. The issuer answers 200 for a token it already
// forgot, so this is idempotent.
func revokeToken(ctx context.Context, revocationEndpoint, refreshToken string) error {
	status, err := postForm(ctx, revocationEndpoint, url.Values{
		"token":           {refreshToken},
		"token_type_hint": {"refresh_token"},
		"client_id":       {cliClientID},
	}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("issuer returned HTTP %d", status)
	}
	return nil
}

// fetchJSON GETs a JSON document within a timeout. The error names the step
// that failed; a probe that only needs yes/no compares it to nil. The body
// is capped at 1 MiB — every document this launcher reads is small, and a
// misdirected URL must not be read to exhaustion.
func fetchJSON(target string, timeout time.Duration, out any) error {
	c := &http.Client{Timeout: timeout}
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

// postForm posts application/x-www-form-urlencoded and decodes the JSON
// body whatever the status — OAuth error bodies are JSON too, and the caller
// reads `error` from them. A nil out discards the body.
func postForm(ctx context.Context, target string, form url.Values, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil && resp.StatusCode == http.StatusOK {
			return resp.StatusCode, fmt.Errorf("HTTP %d from %s: %w", resp.StatusCode, target, err)
		}
	}
	return resp.StatusCode, nil
}
