package launcher

// EXTERNAL-IDENTITY P3 (launcher lane): [environments.*.identity] derives the
// identity role. keycloak on ${KEYCLOAK_HOST} is provided — launched with its
// database on the [database] PostgreSQL; an oidc issuer is external —
// verified, never launched; every incomplete section refuses, naming the key.

import (
	"strings"
	"testing"
)

const keycloakIdentity = `[environments.local.identity]
type = "keycloak"
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"
`

func TestDerivePlanIdentityAbsent(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, nil))
	checkRole(t, plan, "identity", rolePlan{Obligation: obligationAbsent})
}

func TestDerivePlanIdentityKeycloakProvided(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, map[string]string{"identity": keycloakIdentity}))
	checkRole(t, plan, "identity", rolePlan{
		Obligation: obligationProvided, Driver: "keycloak",
		Image: "quay.io/keycloak/keycloak:26.7.4", Port: 8080,
		Env: []string{"KC_DB=postgres", "KC_DB_USERNAME=postgres", "KC_DB_PASSWORD=localpass", "KC_BOOTSTRAP_ADMIN_USERNAME=admin"},
	})
	rp := plan.Roles["identity"]
	if rp.Issuer != "http://${KEYCLOAK_HOST}:8080/realms/semiont" {
		t.Errorf("issuer not carried on the plan: %+v", rp)
	}
	if got := identityEndpoint(rp); got != "http://localhost:8080/realms/semiont" {
		t.Errorf("endpoint: got %q", got)
	}
}

func TestDerivePlanIdentityOIDCExternal(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, map[string]string{"identity": `[environments.local.identity]
type = "oidc"
issuer = "https://login.example.com/realms/acme"
`}))
	checkRole(t, plan, "identity", rolePlan{
		Obligation: obligationExternal, Driver: "oidc", Address: "login.example.com", Port: 443,
	})
}

func TestDerivePlanIdentityRefusals(t *testing.T) {
	cases := []struct {
		name, section string
		want          []string
	}{
		{"no type",
			"[environments.local.identity]\nissuer = \"https://login.example.com/realms/acme\"\n",
			[]string{"identity", "\"type\""}},
		{"unknown type",
			"[environments.local.identity]\ntype = \"foo\"\nissuer = \"https://login.example.com\"\n",
			[]string{"unknown type", "foo"}},
		{"oidc without issuer",
			"[environments.local.identity]\ntype = \"oidc\"\n",
			[]string{"identity", "\"issuer\""}},
		{"keycloak issuer without a realm path",
			"[environments.local.identity]\ntype = \"keycloak\"\nissuer = \"http://${KEYCLOAK_HOST}:8080\"\n",
			[]string{"/realms/<realm>"}},
		{"oidc on an injected host",
			"[environments.local.identity]\ntype = \"oidc\"\nissuer = \"http://${KEYCLOAK_HOST}:8080/realms/x\"\n",
			[]string{"launcher-injected host"}},
		{"issuer without a scheme",
			"[environments.local.identity]\ntype = \"oidc\"\nissuer = \"login.example.com\"\n",
			[]string{"http://"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env, envName, _, err := loadConfig(variantConfig(t, map[string]string{"identity": c.section}))
			if err != nil {
				t.Fatalf("loadConfig: %v", err)
			}
			if _, err = derivePlan(env, envName, "variant.toml"); err == nil {
				t.Fatalf("derivePlan accepted %s", c.name)
			}
			for _, w := range c.want {
				if !strings.Contains(err.Error(), w) {
					t.Errorf("error %q missing %q", err, w)
				}
			}
		})
	}
}

func TestDerivePlanKeycloakNeedsDatabase(t *testing.T) {
	env, envName, _, err := loadConfig(variantConfig(t, map[string]string{"identity": keycloakIdentity, "database": ""}))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if _, err = derivePlan(env, envName, "variant.toml"); err == nil || !strings.Contains(err.Error(), "[database]") {
		t.Fatalf("keycloak without [database] accepted, or the refusal does not name it: %v", err)
	}
}

func TestKeycloakRealmJSONRegistersTheGateway(t *testing.T) {
	doc := string(keycloakRealmJSON("semiont", "https://example.github.io/my-kb", "192.168.64.1", nil))
	// This assertion was the other way round for one commit, on the reasoning
	// that the gateway verifies tokens and never presents one. True of the agent
	// exchange, false in general: the gateway dials the Archivist for content,
	// events and the working tree's branch, and proves who it is like any caller.
	if !strings.Contains(doc, `"clientId": "semiont-gateway"`) {
		t.Error("realm document has no service account for the gateway, which dials the Archivist")
	}
}

func TestKeycloakRealmJSON(t *testing.T) {
	doc := string(keycloakRealmJSON("semiont", "https://example.github.io/my-kb", "192.168.64.1",
		map[string]string{"archivist": "archivist-secret", "weaver": "weaver-secret"}))
	for _, want := range []string{
		`"realm": "semiont"`,
		`"clientId": "semiont-browser"`,
		`"publicClient": true`,
		`"pkce.code.challenge.method": "S256"`,
		`"http://192.168.64.1:3000/*"`,
		`"included.custom.audience": "https://example.github.io/my-kb"`,
		`"clientId": "semiont-cli"`,
		`"oauth2.device.authorization.grant.enabled": "true"`,
		// The revocation window for every person on this knowledge base: Semiont
		// keeps no admission flag of its own, so a disabled account's token stays
		// good until it expires. A realm imported without this would take whatever
		// Keycloak defaults to that release.
		`"accessTokenLifespan": 300`,
		// Each sidecar that exchanges a service-account token for an agent token
		// needs a confidential client of its own. A shared one would be the
		// static secret this replaced, wearing a realm's clothes.
		`"clientId": "semiont-archivist"`,
		`"clientId": "semiont-weaver"`,
		`"serviceAccountsEnabled": true`,
		`"secret": "archivist-secret"`,
		// The gateway reads a FLAT roles array; Keycloak's nested realm_access
		// shape is deliberately not what this stamps.
		`"claim.name": "roles"`,
		`"claim.value": "[\"semiont-service\"]"`,
		// The realm declares its own user profile rather than inheriting
		// Keycloak's. firstName and lastName are required, so a person an
		// administrator created an account for names themselves at first
		// sign-in — and the `name` claim every event carries is one they chose.
		// Inherited, this moves with a Keycloak upgrade and has no line to read.
		`"declarative-user-profile"`,
		`\"name\":\"firstName\"`,
		`\"name\":\"lastName\"`,
		`\"required\":{\"roles\":[\"user\"]}`,
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("realm document missing %s", want)
		}
	}
}
