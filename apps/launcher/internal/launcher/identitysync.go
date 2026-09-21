package launcher

// identitysync.go — `semiont identity sync`: reconcile a realm's
// service-account clients against `serviceClients`.
//
// The repair half of the preflight. A realm is imported on its FIRST boot and
// never again, so a deployment that predates a client simply does not have it,
// `preflightIdentity` correctly refuses to start, and until now nothing could
// fix it: re-importing would have meant deleting the realm, and the realm holds
// the accounts. Each realm-shape change therefore shipped with a hand-written
// paragraph of console steps. This is what ends that — the refusal names a
// command instead, and the next new client costs a line in `serviceClients`
// rather than a new paragraph of prose.
//
// CONFIGURATION ONLY, NEVER ACCOUNTS. It creates what is missing and removes
// nothing. That is the property that makes it safe to run against a deployment
// with real users, and it is asserted rather than merely intended
// (`TestIdentitySyncTouchesNoAccounts`).
//
// The client it creates comes from `serviceAccountClient` — the same renderer
// the realm import uses. Restating the shape here would be a mirror of the
// realm document, and the flat `roles` claim plus the audience mapper are
// exactly what a hand-created client gets wrong.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var adminHTTP = &http.Client{Timeout: 15 * time.Second}

// syncReport: what one reconciliation did, for the operator to read back.
type syncReport struct {
	created []string
	present []string
}

// syncServiceClients reconciles `realm` against `serviceClients`.
//
// `adminBase` is Keycloak's root as this process can reach it (the launcher's
// own localhost form), not the issuer URL a token carries.
func syncServiceClients(adminBase, realm, adminUser, adminPass, audience string, secretFor func(svc string) string) (syncReport, error) {
	base := strings.TrimSuffix(adminBase, "/")

	token, err := adminToken(base, adminUser, adminPass)
	if err != nil {
		return syncReport{}, err
	}

	have, err := existingClientIDs(base, realm, token)
	if err != nil {
		return syncReport{}, err
	}

	var rep syncReport
	for _, svc := range serviceClients {
		id := serviceClientID(svc)
		if have[id] {
			rep.present = append(rep.present, id)
			continue
		}
		if err := createClient(base, realm, token, serviceAccountClient(svc, secretFor(svc), audience)); err != nil {
			return rep, fmt.Errorf("creating %s: %w", id, err)
		}
		rep.created = append(rep.created, id)
	}
	return rep, nil
}

// adminToken: the bootstrap admin's password grant against the MASTER realm,
// which is where Keycloak's own admin lives — not the KB's realm.
func adminToken(base, user, pass string) (string, error) {
	form := url.Values{
		"grant_type": {"password"},
		"client_id":  {"admin-cli"},
		"username":   {user},
		"password":   {pass},
	}
	resp, err := adminHTTP.PostForm(base+"/realms/master/protocol/openid-connect/token", form)
	if err != nil {
		return "", fmt.Errorf("reaching Keycloak for an admin token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the bootstrap admin login was refused (HTTP %d) — is KC_BOOTSTRAP_ADMIN_PASSWORD the one this realm's database was created with?", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.AccessToken == "" {
		return "", fmt.Errorf("the admin token response carried no access_token")
	}
	return body.AccessToken, nil
}

func existingClientIDs(base, realm, token string) (map[string]bool, error) {
	req, _ := http.NewRequest(http.MethodGet, base+"/admin/realms/"+realm+"/clients", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("listing the realm's clients: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("listing the realm's clients: HTTP %d", resp.StatusCode)
	}
	var clients []struct {
		ClientID string `json:"clientId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&clients); err != nil {
		return nil, fmt.Errorf("reading the realm's client list: %w", err)
	}
	have := map[string]bool{}
	for _, c := range clients {
		have[c.ClientID] = true
	}
	return have, nil
}

func createClient(base, realm, token string, client map[string]any) error {
	b, err := json.Marshal(client)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodPost, base+"/admin/realms/"+realm+"/clients", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("content-type", "application/json")
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// 409 is success for our purposes: the client appeared between the list
	// and the create. Reconciliation converges; it does not race to an error.
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusConflict {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
