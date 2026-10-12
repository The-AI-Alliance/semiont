package launcher

import (
	"runtime/debug"
	"strings"
	"testing"

	"github.com/nats-io/nats-server/v2/conf"
)

// The broker's pair, read back through nats-server's own config parser: what a
// variable's value means is that lexer's to say, so the launcher's handover is
// held to it rather than to a description of it.
//
// Every password here is one nats-server does not read as text when it is
// handed bare. The first three are draws the generator makes; about one hex
// password in fourteen has the shape of the first two.
func TestBrokerReadsItsKeptPairAsText(t *testing.T) {
	for name, kept := range map[string]string{
		"digits, e, a digit":      "7e1c0ffee0ddba11deadbeef00112233",
		"digits, e, b, a digit":   "42eb9c0ffee0ddba11deadbeef001122",
		"digits alone":            "12345678901234567890123456789012",
		"a quote and a backslash": `pass "word" \ more`,
	} {
		t.Run(name, func(t *testing.T) {
			fc := flowCtx{userEnv: []string{"--env", daemonPasswords["messaging"].env + "=" + kept}}
			env, err := daemonLaunchEnv(fc, "messaging", rolePlan{})
			if err != nil {
				t.Fatal(err)
			}
			for _, pair := range env {
				variable, value, _ := strings.Cut(pair, "=")
				t.Setenv(variable, value)
			}
			doc, err := conf.Parse(string(natsConf()))
			if err != nil {
				t.Fatalf("nats-server refuses the staged config with the pair it is handed: %v", err)
			}
			auth, _ := doc["authorization"].(map[string]any)
			if auth["user"] != brokerUser {
				t.Errorf("the broker reads its user as %#v, want %q", auth["user"], brokerUser)
			}
			if auth["password"] != kept {
				t.Errorf("the broker reads its password as %#v, want the kept %q", auth["password"], kept)
			}
		})
	}
}

// The parser the test above reads with is the launched broker's: the module's
// version is the image's. A broker moved alone would leave that test proving
// a lexer nothing runs.
func TestBrokerPairIsReadByTheLaunchedBrokersParser(t *testing.T) {
	const module = "github.com/nats-io/nats-server/v2"
	info, ok := debug.ReadBuildInfo()
	if !ok {
		t.Fatal("this test binary carries no build information")
	}
	image := descriptorFor("messaging", "jetstream").image
	for _, dep := range info.Deps {
		if dep.Path != module {
			continue
		}
		if want := "nats:" + strings.TrimPrefix(dep.Version, "v") + "-alpine"; image != want {
			t.Errorf("the launcher runs %s, and its tests parse with %s %s (%s) — move go.mod and the descriptor together", image, module, dep.Version, want)
		}
		return
	}
	t.Fatalf("%s is not among this test binary's modules", module)
}
