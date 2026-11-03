package launcher

// identityrealm.go — the knowledge base's realm, created through Keycloak's
// admin API when a start finds the Keycloak the launcher runs without it, and
// deleted through it by `semiont clean`.
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

// realmHeld: whether the Keycloak whose origin is base holds realm, asked at
// the realm's public root, which needs no admin login.
func realmHeld(base, realm string) (bool, error) {
	resp, err := adminHTTP.Get(base + "/realms/" + realm)
	if err != nil {
		return false, fmt.Errorf("asking Keycloak for the realm: %w", err)
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	}
	return false, fmt.Errorf("asking Keycloak for the realm: HTTP %d", resp.StatusCode)
}

// ensureRealm creates realm at the Keycloak whose origin is base, from doc,
// unless Keycloak holds it already, and says whether it created it.
func ensureRealm(base, realm, adminPass string, doc []byte) (bool, error) {
	if held, err := realmHeld(base, realm); err != nil || held {
		return false, err
	}

	token, err := adminToken(base, keycloakAdminUser, adminPass)
	if err != nil {
		return false, err
	}
	req, _ := http.NewRequest(http.MethodPost, base+"/admin/realms", bytes.NewReader(doc))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("content-type", "application/json")
	resp, err := adminHTTP.Do(req)
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
	return false, fmt.Errorf("Keycloak refused to create the realm: %s", keycloakRefusal(resp))
}

// keycloakRefusal: an admin API refusal as Keycloak gives it, its status and
// the reason it carries when it carries one.
func keycloakRefusal(resp *http.Response) string {
	refused := fmt.Sprintf("HTTP %d", resp.StatusCode)
	var refusal struct {
		ErrorMessage string `json:"errorMessage"`
	}
	if json.NewDecoder(resp.Body).Decode(&refusal) == nil && refusal.ErrorMessage != "" {
		refused += " " + refusal.ErrorMessage
	}
	return refused
}

// deleteRealm deletes realm, its accounts and its clients with it, from the
// Keycloak whose origin is base. A realm that is gone before the delete
// reaches it is as deleted.
func deleteRealm(base, realm, adminPass string) error {
	token, err := adminToken(base, keycloakAdminUser, adminPass)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodDelete, base+"/admin/realms/"+realm, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := adminHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("deleting the realm: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNoContent, http.StatusNotFound:
		return nil
	}
	return fmt.Errorf("Keycloak refused to delete the realm: %s", keycloakRefusal(resp))
}
