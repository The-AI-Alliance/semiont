package launcher

// keycloakusers.go — the realm's ACCOUNT surface, beside identitysync.go's
// client/mapper/realm-settings surface. Both speak Keycloak's admin API with
// the same bootstrap-admin token (adminToken) and the same HTTP client.
//
// Only Keycloak. `[identity] type = "oidc"` names an issuer Semiont does not
// administer: accounts there are created at the issuer and then sign in here.
// The caller enforces that before reaching any of this.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// realmUser: what the realm holds for one address. `id` is the `sub` its
// tokens will carry, and so the subject every Semiont DID is derived from.
type realmUser struct {
	id      string
	email   string
	enabled bool
}

func usersURL(base, realm, suffix string) string {
	return base + "/admin/realms/" + realm + "/users" + suffix
}

func adminRequest(method, url, token string, body any) (*http.Request, error) {
	var rdr *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// findUserByEmail: the realm's account for this address, nil when it holds
// none. `exact` or the realm answers substring matches, and a search for
// sam@x.co would find samantha@x.co — updating an account nobody named.
func findUserByEmail(base, realm, token, email string) (*realmUser, error) {
	q := url.Values{"email": {email}, "exact": {"true"}}
	req, err := adminRequest(http.MethodGet, usersURL(base, realm, "")+"?"+q.Encode(), token, nil)
	if err != nil {
		return nil, err
	}
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("searching realm %s for %s: %w", realm, email, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("searching realm %s for %s failed (HTTP %d)", realm, email, resp.StatusCode)
	}
	var found []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&found); err != nil {
		return nil, fmt.Errorf("searching realm %s for %s returned no list: %w", realm, email, err)
	}
	for _, entry := range found {
		id, _ := entry["id"].(string)
		if id == "" {
			continue
		}
		u := &realmUser{id: id, email: email, enabled: true}
		if e, ok := entry["email"].(string); ok {
			u.email = e
		}
		if en, ok := entry["enabled"].(bool); ok {
			u.enabled = en
		}
		return u, nil
	}
	return nil, nil
}

// createUser: the account, and its id — the `sub` its tokens will carry.
//
// `enabled` is the issuer's answer to "may this person sign in", and it is the
// only answer: the gateway admits every subject whose token verifies. Disabling
// stops new tokens at once, but one already in hand works until it expires —
// that window is the access token lifetime.
//
// No display name. The realm's user profile requires firstName and lastName, so
// Keycloak asks the person at first sign-in and composes the `name` claim from
// both. An administrator types one string, and splitting it on a space gets
// "Mary Jane" and "van der Berg" wrong — so nobody guesses, and the person says.
func createUser(base, realm, token, email, password string, enabled bool) (string, error) {
	req, err := adminRequest(http.MethodPost, usersURL(base, realm, ""), token, map[string]any{
		"username": email,
		"email":    email,
		// A token whose email_verified is false is refused at sign-in, so an
		// unverified account could never reach the KB it was just granted.
		"emailVerified": true,
		"enabled":       enabled,
		// temporary:false so the password the administrator just set is the one
		// that works, with no reset step on top of the profile form the realm
		// already asks for.
		"credentials": []map[string]any{{"type": "password", "value": password, "temporary": false}},
	})
	if err != nil {
		return "", err
	}
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("creating %s in realm %s: %w", email, realm, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return "", fmt.Errorf("realm %s already holds an account for %s", realm, email)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", fmt.Errorf("creating %s in realm %s failed (HTTP %d)", email, realm, resp.StatusCode)
	}
	// Keycloak names the new account only in Location; there is no body.
	loc := resp.Header.Get("Location")
	id := loc[strings.LastIndex(loc, "/")+1:]
	if loc == "" || id == "" {
		return "", fmt.Errorf("realm %s created %s but named no id in its Location header", realm, email)
	}
	return id, nil
}

func setUserPassword(base, realm, token, userID, password string) error {
	suffix := "/" + url.PathEscape(userID) + "/reset-password"
	req, err := adminRequest(http.MethodPut, usersURL(base, realm, suffix), token,
		map[string]any{"type": "password", "value": password, "temporary": false})
	if err != nil {
		return err
	}
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("setting the password for %s: %w", userID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("setting the password for %s failed (HTTP %d)", userID, resp.StatusCode)
	}
	return nil
}

// setUserEnabled: both directions, deliberately. A control with no way back is
// one administrators avoid using.
func setUserEnabled(base, realm, token, userID string, enabled bool) error {
	req, err := adminRequest(http.MethodPut, usersURL(base, realm, "/"+url.PathEscape(userID)), token,
		map[string]any{"enabled": enabled})
	if err != nil {
		return err
	}
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("updating %s in realm %s: %w", userID, realm, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		verb := "enabling"
		if !enabled {
			verb = "disabling"
		}
		return fmt.Errorf("%s %s in realm %s failed (HTTP %d)", verb, userID, realm, resp.StatusCode)
	}
	return nil
}
