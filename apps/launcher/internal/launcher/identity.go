package launcher

// identity.go — the launched Keycloak's shape beyond its plan row: the issuer
// URL's parts, the realm it imports, and the run-time extras (realm file,
// database, admin password) a `run -d` needs that derivePlan cannot know.

import (
	"encoding/json"
	"fmt"
	"strings"
)

const (
	keycloakAdminUser = "admin"
	keycloakDatabase  = "keycloak"
	// browserClientID: the Browser's registration in every KB realm. The
	// Browser is machine-level, so one public client (PKCE) serves it.
	browserClientID = "semiont-browser"
)

// splitIssuer: the host, port and path of an issuer URL. Not url.Parse — a
// launcher-injected ${KEYCLOAK_HOST} is not a legal hostname to it.
func splitIssuer(issuer string) (host string, port int, path string, err error) {
	rest, ok := strings.CutPrefix(issuer, "http://")
	if !ok {
		if rest, ok = strings.CutPrefix(issuer, "https://"); !ok {
			return "", 0, "", fmt.Errorf("must start with http:// or https://")
		}
	}
	authority, p, _ := strings.Cut(rest, "/")
	host, port = parseHostPort(authority)
	if host == "" {
		return "", 0, "", fmt.Errorf("names no host")
	}
	return host, port, "/" + p, nil
}

func issuerPath(issuer string) string {
	_, _, path, err := splitIssuer(issuer)
	if err != nil {
		return "/"
	}
	return path
}

// keycloakRealm: the realm named by an issuer path of the shape
// /realms/<realm>; "" for any other path.
func keycloakRealm(path string) string {
	realm, ok := strings.CutPrefix(path, "/realms/")
	if !ok || realm == "" || strings.Contains(realm, "/") {
		return ""
	}
	return realm
}

// identityEndpoint: the issuer as reachable from this host — the realm's
// root, which Keycloak serves only once the realm exists.
func identityEndpoint(rp rolePlan) string {
	return fmt.Sprintf("http://localhost:%d%s", rp.Port, issuerPath(rp.Issuer))
}

// keycloakRealmJSON renders the realm Keycloak imports on first boot: the
// realm itself and the Browser's public client, with an audience mapper that
// stamps the gateway's client id into every access token — the value the
// gateway's verifier checks. Import skips a realm that already exists, so a
// second start changes nothing.
func keycloakRealmJSON(realm, audience, addr string) []byte {
	doc := map[string]any{
		"realm":       realm,
		"enabled":     true,
		"sslRequired": "none",
		"clients": []map[string]any{{
			"clientId":                  browserClientID,
			"name":                      "Semiont Browser",
			"enabled":                   true,
			"protocol":                  "openid-connect",
			"publicClient":              true,
			"standardFlowEnabled":       true,
			"implicitFlowEnabled":       false,
			"directAccessGrantsEnabled": false,
			"redirectUris":              []string{"http://localhost:3000/*", "http://" + addr + ":3000/*"},
			"webOrigins":                []string{"+"},
			"attributes": map[string]string{
				"pkce.code.challenge.method": "S256",
				"post.logout.redirect.uris":  "+",
			},
			"protocolMappers": []map[string]any{{
				"name":            "gateway audience",
				"protocol":        "openid-connect",
				"protocolMapper":  "oidc-audience-mapper",
				"consentRequired": false,
				"config": map[string]string{
					"included.custom.audience": audience,
					"access.token.claim":       "true",
					"id.token.claim":           "false",
				},
			}},
		}},
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		panic(err)
	}
	return append(b, '\n')
}

// identityRunExtras: what a launched Keycloak needs beyond its plan row —
// its database on the [database] PostgreSQL (created there when the launcher
// runs that PostgreSQL), the realm file to import, and the bootstrap admin
// password. The password is per root and persisted: Keycloak creates the
// admin on its FIRST boot only, so a regenerated value would lock the
// console out of a realm that already exists.
func identityRunExtras(x executor, fc flowCtx, addr string) ([]string, bool) {
	rp := fc.plan.Roles["identity"]
	db := fc.plan.Roles["database"]
	dbHost := db.Address
	if db.Obligation == obligationProvided {
		dbHost = addr
		if !x.createDatabase(envValue(rp.Env, "KC_DB_USERNAME"), keycloakDatabase) {
			return nil, false
		}
	} else {
		x.say(sayLog, "identity — PostgreSQL at %s is not launcher-run; the %q database must already exist there", dbHost, keycloakDatabase)
		x.note("identity: external PostgreSQL at %s — the %q database must already exist there", dbHost, keycloakDatabase)
	}
	realm := keycloakRealm(issuerPath(rp.Issuer))
	realmFile, ok := x.stageRealm(realm, keycloakRealmJSON(realm, rp.Audience, addr))
	if !ok {
		return nil, false
	}
	password, ok := x.identityAdminPassword(fc.root)
	if !ok {
		return nil, false
	}
	return []string{
		"-v", realmFile + ":/opt/keycloak/data/import/" + realm + ".json:ro",
		"-e", fmt.Sprintf("KC_DB_URL=jdbc:postgresql://%s:%d/%s", dbHost, db.Port, keycloakDatabase),
		"--env", "KC_BOOTSTRAP_ADMIN_PASSWORD=" + password,
	}, true
}
