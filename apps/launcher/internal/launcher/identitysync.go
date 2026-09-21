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
	"slices"
	"strings"
	"time"
)

var adminHTTP = &http.Client{Timeout: 15 * time.Second}

// syncReport: what one reconciliation did, for the operator to read back.
type syncReport struct {
	created []string
	present []string
	updated []string // "<client>: what changed", and "<realm>: …" for realm settings
}

// syncRealm reconciles everything the preflight can detect.
//
// The pairing is the point: every finding `preflightIdentity` and
// `verifyPublicClients` can produce needs a remedy here, or the promise that a
// realm change costs a line in one function instead of a paragraph of console
// steps holds for missing clients and nothing else.
//
// Still additive. It creates absent clients, ADDS absent redirect URIs, and
// turns off a flow that should be off. It deletes no client, drops no redirect
// URI a deployment added, and never reads or writes an account.
func syncRealm(adminBase, realm, adminUser, adminPass, audience string, lifespan int, secretFor func(svc string) string) (syncReport, error) {
	base := strings.TrimSuffix(adminBase, "/")
	token, err := adminToken(base, adminUser, adminPass)
	if err != nil {
		return syncReport{}, err
	}
	rep, err := reconcileServiceClients(base, realm, token, audience, secretFor)
	if err != nil {
		return rep, err
	}
	if err := reconcilePublicClients(base, realm, token, &rep); err != nil {
		return rep, err
	}
	if err := reconcileRealmSettings(base, realm, token, lifespan, &rep); err != nil {
		return rep, err
	}
	return rep, nil
}

// reconcilePublicClients: the two registrations people sign in through.
//
// Two fields, both of which the preflight refuses or warns on: the loopback
// redirect URIs that make `--port` work at all (RFC 8252 §7.3), and the
// implicit flow, which would handballs the access token back in a redirect
// fragment.
func reconcilePublicClients(base, realm, token string, rep *syncReport) error {
	clients, err := existingClients(base, realm, token)
	if err != nil {
		return err
	}
	for _, id := range []string{browserClientID, cliClientID} {
		c, ok := clients[id]
		if !ok {
			continue // absent is a preflight refusal, not something to invent here
		}
		patch := map[string]any{}
		var changes []string

		if implicit, _ := c.rep["implicitFlowEnabled"].(bool); implicit {
			patch["implicitFlowEnabled"] = false
			changes = append(changes, "implicit flow disabled")
		}
		if id == browserClientID {
			have := stringsOf(c.rep["redirectUris"])
			missing := []string{}
			for _, want := range loopbackRedirectUris() {
				if !slices.Contains(have, want) {
					missing = append(missing, want)
				}
			}
			if len(missing) > 0 {
				// APPENDED, never replaced: the LAN entry is deployment truth
				// this command cannot re-derive.
				patch["redirectUris"] = append(append([]string{}, have...), missing...)
				changes = append(changes, "loopback redirect URIs added ("+strings.Join(missing, ", ")+")")
			}
		}
		if len(patch) == 0 {
			continue
		}
		if err := updateClient(base, realm, token, c.uuid, patch); err != nil {
			return fmt.Errorf("updating %s: %w", id, err)
		}
		rep.updated = append(rep.updated, id+": "+strings.Join(changes, "; "))
	}
	return nil
}

// reconcileRealmSettings: the access-token lifetime, which IS the revocation
// window. The preflight can only observe it (`exp - iat` on a token it just
// minted) and warn; with admin credentials it is a field, and fixable.
func reconcileRealmSettings(base, realm, token string, want int, rep *syncReport) error {
	if want <= 0 {
		return nil // nothing configured; the realm's own value stands
	}
	req, _ := http.NewRequest(http.MethodGet, base+"/admin/realms/"+realm, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("reading the realm settings: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("reading the realm settings: HTTP %d", resp.StatusCode)
	}
	var cfg map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		return fmt.Errorf("parsing the realm settings: %w", err)
	}
	have, ok := cfg["accessTokenLifespan"].(float64)
	if ok && int(have) == want {
		return nil
	}
	b, _ := json.Marshal(map[string]any{"accessTokenLifespan": want})
	put, _ := http.NewRequest(http.MethodPut, base+"/admin/realms/"+realm, bytes.NewReader(b))
	put.Header.Set("Authorization", "Bearer "+token)
	put.Header.Set("content-type", "application/json")
	pr, err := adminHTTP.Do(put)
	if err != nil {
		return fmt.Errorf("setting accessTokenLifespan: %w", err)
	}
	defer pr.Body.Close()
	if pr.StatusCode != http.StatusNoContent && pr.StatusCode != http.StatusOK {
		return fmt.Errorf("setting accessTokenLifespan: HTTP %d", pr.StatusCode)
	}
	rep.updated = append(rep.updated, fmt.Sprintf("<realm>: accessTokenLifespan %v → %d", cfg["accessTokenLifespan"], want))
	return nil
}

func stringsOf(v any) []string {
	raw, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, e := range raw {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func updateClient(base, realm, token, uuid string, patch map[string]any) error {
	b, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodPut, base+"/admin/realms/"+realm+"/clients/"+uuid, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("content-type", "application/json")
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

// reconcileRolesMapper brings an existing service client's roles mapper to
// what the realm document renders for it now. The mapper is a sub-resource
// with its own endpoint — a client-level PUT does not reach it — and it is
// updated IN PLACE, by id, so the client ends with one `roles` claim, not two.
// A client with no such mapper is left alone: that is a hand-built client the
// preflight already refuses by name, and inventing its mapper here would be
// asserting something about an issuer this launcher did not configure.
//
// Returns what changed, for the report; "" when the mapper already agrees.
func reconcileRolesMapper(base, realm, token, svc string, c existingClient) (string, error) {
	want := serviceRolesClaim(svc)
	mappers, _ := c.rep["protocolMappers"].([]any)
	for _, m := range mappers {
		mapper, _ := m.(map[string]any)
		if mapper["name"] != serviceRoleMapperName {
			continue
		}
		cfg, _ := mapper["config"].(map[string]any)
		have, _ := cfg["claim.value"].(string)
		if have == want {
			return "", nil
		}
		id, _ := mapper["id"].(string)
		if id == "" {
			return "", fmt.Errorf("the %q mapper carries no id to update it by", serviceRoleMapperName)
		}
		if cfg == nil {
			cfg = map[string]any{}
		}
		cfg["claim.value"] = want
		mapper["config"] = cfg
		if err := updateClientMapper(base, realm, token, c.uuid, id, mapper); err != nil {
			return "", err
		}
		return fmt.Sprintf("roles mapper now renders %s (was %s)", want, have), nil
	}
	return "", nil
}

// updateClientMapper: PUT one protocol mapper by id. Keycloak wants the whole
// representation back, id included.
func updateClientMapper(base, realm, token, uuid, mapperID string, mapper map[string]any) error {
	b, err := json.Marshal(mapper)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodPut,
		base+"/admin/realms/"+realm+"/clients/"+uuid+"/protocol-mappers/models/"+mapperID, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("content-type", "application/json")
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
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
	return reconcileServiceClients(base, realm, token, audience, secretFor)
}

func reconcileServiceClients(base, realm, token, audience string, secretFor func(svc string) string) (syncReport, error) {
	have, err := existingClients(base, realm, token)
	if err != nil {
		return syncReport{}, err
	}
	var rep syncReport
	for _, svc := range serviceClients {
		id := serviceClientID(svc)
		if c, ok := have[id]; ok {
			// Present — but the client the import WOULD render may have gained
			// a role since this one was created (EXTRACT-JOBS P0 gave the
			// worker one), and the preflight refuses a realm whose mapper
			// still renders the old value. The secret is never reconciled:
			// sync cannot know it.
			change, err := reconcileRolesMapper(base, realm, token, svc, c)
			if err != nil {
				return rep, fmt.Errorf("updating %s: %w", id, err)
			}
			if change != "" {
				rep.updated = append(rep.updated, id+": "+change)
			} else {
				rep.present = append(rep.present, id)
			}
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

// existingClient: what the realm currently holds for one clientId. The uuid is
// the admin API's own key, needed to update it; the representation is what a
// reconciliation compares against.
type existingClient struct {
	uuid string
	rep  map[string]any
}

func existingClients(base, realm, token string) (map[string]existingClient, error) {
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
	var clients []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&clients); err != nil {
		return nil, fmt.Errorf("reading the realm's client list: %w", err)
	}
	have := map[string]existingClient{}
	for _, c := range clients {
		id, _ := c["clientId"].(string)
		uuid, _ := c["id"].(string)
		if id != "" {
			have[id] = existingClient{uuid: uuid, rep: c}
		}
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
