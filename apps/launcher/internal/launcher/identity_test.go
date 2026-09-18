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
audience = "semiont-gateway"
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
	if rp.Issuer != "http://${KEYCLOAK_HOST}:8080/realms/semiont" || rp.Audience != "semiont-gateway" {
		t.Errorf("issuer/audience not carried on the plan: %+v", rp)
	}
	if got := identityEndpoint(rp); got != "http://localhost:8080/realms/semiont" {
		t.Errorf("endpoint: got %q", got)
	}
}

func TestDerivePlanIdentityOIDCExternal(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, map[string]string{"identity": `[environments.local.identity]
type = "oidc"
issuer = "https://login.example.com/realms/acme"
audience = "semiont-gateway"
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
			"[environments.local.identity]\nissuer = \"https://login.example.com/realms/acme\"\naudience = \"semiont-gateway\"\n",
			[]string{"identity", "\"type\""}},
		{"unknown type",
			"[environments.local.identity]\ntype = \"foo\"\nissuer = \"https://login.example.com\"\naudience = \"a\"\n",
			[]string{"unknown type", "foo"}},
		{"oidc without issuer",
			"[environments.local.identity]\ntype = \"oidc\"\naudience = \"semiont-gateway\"\n",
			[]string{"identity", "\"issuer\""}},
		{"keycloak without audience",
			"[environments.local.identity]\ntype = \"keycloak\"\nissuer = \"http://${KEYCLOAK_HOST}:8080/realms/semiont\"\n",
			[]string{"identity", "\"audience\""}},
		{"keycloak issuer without a realm path",
			"[environments.local.identity]\ntype = \"keycloak\"\nissuer = \"http://${KEYCLOAK_HOST}:8080\"\naudience = \"a\"\n",
			[]string{"/realms/<realm>"}},
		{"oidc on an injected host",
			"[environments.local.identity]\ntype = \"oidc\"\nissuer = \"http://${KEYCLOAK_HOST}:8080/realms/x\"\naudience = \"a\"\n",
			[]string{"launcher-injected host"}},
		{"issuer without a scheme",
			"[environments.local.identity]\ntype = \"oidc\"\nissuer = \"login.example.com\"\naudience = \"a\"\n",
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

func TestKeycloakRealmJSON(t *testing.T) {
	doc := string(keycloakRealmJSON("semiont", "semiont-gateway", "192.168.64.1"))
	for _, want := range []string{
		`"realm": "semiont"`,
		`"clientId": "semiont-browser"`,
		`"publicClient": true`,
		`"pkce.code.challenge.method": "S256"`,
		`"http://192.168.64.1:3000/*"`,
		`"included.custom.audience": "semiont-gateway"`,
		`"clientId": "semiont-cli"`,
		`"oauth2.device.authorization.grant.enabled": "true"`,
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("realm document missing %s", want)
		}
	}
}
