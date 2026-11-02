package launcher

// identityrealm.go — the knowledge base's realm, created through Keycloak's
// admin API when a start finds the Keycloak the launcher runs without it.
//
// The start asks the realm's public root first. A realm Keycloak holds is left
// as it is: a start needs no admin login once its realm exists, and a realm
// somebody has customised is never rewritten. `semiont identity sync`
// reconciles one that exists; only an absent realm is created here, from
// keycloakRealmJSON.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

// ensureRealm creates realm at the Keycloak whose origin is base, from doc,
// unless Keycloak holds it already, and says whether it created it.
func ensureRealm(base, realm, adminPass string, doc []byte) (bool, error) {
	resp, err := adminHTTP.Get(base + "/realms/" + realm)
	if err != nil {
		return false, fmt.Errorf("asking Keycloak for the realm: %w", err)
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return false, nil
	case http.StatusNotFound:
	default:
		return false, fmt.Errorf("asking Keycloak for the realm: HTTP %d", resp.StatusCode)
	}

	token, err := adminToken(base, keycloakAdminUser, adminPass)
	if err != nil {
		return false, err
	}
	req, _ := http.NewRequest(http.MethodPost, base+"/admin/realms", bytes.NewReader(doc))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("content-type", "application/json")
	resp, err = adminHTTP.Do(req)
	if err != nil {
		return false, fmt.Errorf("creating the realm: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusCreated:
		return true, nil
	case http.StatusConflict:
		// It appeared between the ask and the create, and a start needs no
		// more than that it is held.
		return false, nil
	}
	refused := fmt.Sprintf("HTTP %d", resp.StatusCode)
	var refusal struct {
		ErrorMessage string `json:"errorMessage"`
	}
	if json.NewDecoder(resp.Body).Decode(&refusal) == nil && refusal.ErrorMessage != "" {
		refused += " " + refusal.ErrorMessage
	}
	return false, fmt.Errorf("Keycloak refused to create the realm: %s", refused)
}
