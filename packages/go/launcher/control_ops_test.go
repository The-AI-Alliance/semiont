package launcher

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// onBareMachine: a machine with no launcher state, no settings and nothing on
// PATH, the test standing in a directory that is no knowledge base. It
// returns the machine's home.
func onBareMachine(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, "state"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("SEMIONT_ROOT", "")
	t.Setenv("PATH", t.TempDir())
	t.Chdir(t.TempDir())
	return home
}

// controlAnswer: the answer a request got, as the launcher wrote it.
type controlAnswer struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

// answered: the answer to a request of method with params, its operation run
// as its turn runs it, with no codec and no turn: the params reach the
// handler unchecked, and the answer is held to its schema as every answer is.
// diag is what the launcher wrote to stderr.
func answered(t *testing.T, method, params string) (answer controlAnswer, diag string) {
	t.Helper()
	m, ok := controlMethodNamed(method)
	if !ok {
		t.Fatalf("the control API has no method %s", method)
	}
	s, protocol := codecServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req := &controlRequest{id: json.RawMessage(`7`), key: "7", method: m, params: json.RawMessage(params),
		ctx: ctx, cancel: cancel, server: s}
	result, failure := req.operate()
	s.answer(req, result, failure)
	for _, line := range protocol.lines() {
		var message struct {
			ID json.RawMessage `json:"id"`
			controlAnswer
		}
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			t.Fatalf("the launcher wrote a line that is not JSON: %s", line)
		}
		if string(message.ID) == "7" {
			return message.controlAnswer, s.diag.(*lockedBuffer).b.String()
		}
	}
	t.Fatalf("%s was not answered: %v", method, protocol.lines())
	return controlAnswer{}, ""
}

// resultOf: the answer's result, read into out; the test fails on an error.
func resultOf(t *testing.T, answer controlAnswer, out any) {
	t.Helper()
	if answer.Error != nil {
		t.Fatalf("answered error %d %s: %+v", answer.Error.Code, answer.Error.Message, answer.Error.Data)
	}
	if err := json.Unmarshal(answer.Result, out); err != nil {
		t.Fatalf("the result %s: %v", answer.Result, err)
	}
}

// controlTestUI: a command UI with the refusal record a control request owns.
func controlTestUI() *UI {
	u := NewUI(false)
	u.refused = &refusal{}
	return u
}

// Each request the launcher refuses, on a machine with nothing recorded, is
// answered with the control code its refusal names, and the error's data
// holds to its schema.
func TestControlOperationsRefuseUnderTheirCodes(t *testing.T) {
	cases := []struct {
		name, method, params string
		rpcCode              int
		code                 string
	}{
		{"params that do not decode", "roots.forget", `{"root":5}`, rpcInvalidParams, controlCodeInvalidParams},
		{"forget an unregistered root", "roots.forget", `{"root":"no-such-root"}`, rpcOperationError, controlCodeRootNotRegistered},
		{"status of a codespace on a runtime", "status.snapshot", `{"target":{"kind":"codespace","repo":"o/r"},"runtime":"docker"}`, rpcOperationError, controlCodeInvalidRequest},
		{"status of a root that is not one", "status.snapshot", `{"target":{"kind":"local","root":"no-such-root"}}`, rpcOperationError, controlCodeRootNotFound},
		{"status with no runtime installed", "status.snapshot", `{}`, rpcOperationError, controlCodeRuntimeUnavailable},
		{"status on a runtime not installed", "status.snapshot", `{"runtime":"docker"}`, rpcOperationError, controlCodeRuntimeUnavailable},
		{"dry-run start outside a knowledge base", "stack.start", `{"dryRun":true}`, rpcOperationError, controlCodeRootNotFound},
		{"start a codespace on a runtime", "stack.start", `{"target":{"kind":"codespace","repo":"o/r"},"runtime":"docker"}`, rpcOperationError, controlCodeInvalidRequest},
		{"start an unknown service", "stack.start", `{"service":"no-such-service"}`, rpcOperationError, controlCodeInvalidService},
		{"start an unknown group", "stack.start", `{"group":"no-such-group"}`, rpcOperationError, controlCodeInvalidService},
		{"stop a codespace on a runtime", "stack.stop", `{"target":{"kind":"codespace","repo":"o/r"},"runtime":"docker"}`, rpcOperationError, controlCodeInvalidRequest},
		{"delete unconfirmed", "stack.stop", `{"delete":true}`, rpcOperationError, controlCodeConfirmationRequired},
		{"confirm no delete", "stack.stop", `{"deleteConfirmed":true}`, rpcOperationError, controlCodeInvalidRequest},
		{"sign in with no stack", "auth.login", `{}`, rpcOperationError, controlCodeStackNotRunning},
		{"sign in to a root that is not one", "auth.login", `{"target":{"kind":"local","root":"no-such-root"}}`, rpcOperationError, controlCodeRootNotFound},
		{"sign out of a root that is not one", "auth.logout", `{"target":{"kind":"local","root":"no-such-root"}}`, rpcOperationError, controlCodeRootNotFound},
		{"useradd routes to the selected root", "identity.useradd", `{"target":{"kind":"local","root":"no-such-root"},"email":"person@example.org","generatePassword":true}`, rpcOperationError, controlCodeRootNotFound},
		{"users list routes to the selected root", "identity.users.list", `{"target":{"kind":"local","root":"no-such-root"}}`, rpcOperationError, controlCodeRootNotFound},
		{"follow a root that is not one", "logs.follow", `{"target":{"kind":"local","root":"no-such-root"}}`, rpcOperationError, controlCodeRootNotFound},
		{"settings of a root that is not one", "settings.list", `{"root":"no-such-root"}`, rpcOperationError, controlCodeRootNotFound},
		{"follow a codespace on a runtime", "logs.follow", `{"target":{"kind":"codespace","repo":"o/r"},"runtime":"docker"}`, rpcOperationError, controlCodeInvalidRequest},
		{"follow an unknown service", "logs.follow", `{"service":"no-such-service"}`, rpcOperationError, controlCodeInvalidService},
		{"get an unknown setting", "settings.get", `{"name":"no-such-setting"}`, rpcOperationError, controlCodeUnknownSetting},
		{"set an unknown setting", "settings.set", `{"name":"no-such-setting","value":"x"}`, rpcOperationError, controlCodeUnknownSetting},
		{"unset an unknown setting", "settings.unset", `{"name":"no-such-setting"}`, rpcOperationError, controlCodeUnknownSetting},
		{"set a port that is none", "settings.set", `{"name":"keycloak-port","value":"not-a-port"}`, rpcOperationError, controlCodeInvalidValue},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			onBareMachine(t)
			answer, diag := answered(t, c.method, c.params)
			if answer.Error == nil {
				t.Fatalf("answered %s, want error %s", answer.Result, c.code)
			}
			if answer.Error.Code != c.rpcCode || answer.Error.Data == nil || answer.Error.Data.Code != c.code {
				t.Fatalf("answered %d %+v (%s), want %d %s; stderr: %s", answer.Error.Code, answer.Error.Data,
					answer.Error.Message, c.rpcCode, c.code, diag)
			}
			if answer.Error.Data.Retryable != retryableCodes[c.code] {
				t.Errorf("retryable = %v for %s", answer.Error.Data.Retryable, c.code)
			}
			if answer.Error.Message == "" {
				t.Error("the error has no message")
			}
		})
	}
}

// A machine with nothing recorded knows no roots.
func TestControlRootsListOfABareMachine(t *testing.T) {
	onBareMachine(t)
	answer, _ := answered(t, "roots.list", `{}`)
	var list ControlRootsListResult
	resultOf(t, answer, &list)
	if len(list.Roots) != 0 || len(list.Warnings) != 0 {
		t.Errorf("roots.list = %+v, want no roots and no warnings", list)
	}
}

// Signing out with no stack recorded ends nothing, and is no failure.
func TestControlAuthLogoutWithNoStack(t *testing.T) {
	onBareMachine(t)
	answer, _ := answered(t, "auth.logout", `{}`)
	var ended ControlAuthLogoutResult
	resultOf(t, answer, &ended)
	if ended.Key != nil {
		t.Errorf("auth.logout named stack %s, and none is recorded", *ended.Key)
	}
}

// Outside a knowledge base, settings.list states the machine's settings and
// why no knowledge base's are among them.
func TestControlSettingsListOutsideAKnowledgeBase(t *testing.T) {
	onBareMachine(t)
	answer, _ := answered(t, "settings.list", `{}`)
	var list ControlSettingsListResult
	resultOf(t, answer, &list)
	if list.Root != nil || list.Unresolved == nil {
		t.Errorf("root %v, unresolved %v: want no root, and why", list.Root, list.Unresolved)
	}
	if len(list.Settings) == 0 {
		t.Fatal("no settings listed")
	}
	for _, s := range list.Settings {
		if s.AppliesTo != appliesToMachine {
			t.Errorf("%s applies to %s, and no knowledge base resolved", s.Name, s.AppliesTo)
		}
	}
}

// A setting the launcher can change is read, set and unset through the API.
func TestControlSettingsGetSetUnset(t *testing.T) {
	onBareMachine(t)
	for _, step := range []struct{ method, params, want string }{
		{"settings.set", `{"name":"keycloak-port","value":"18443"}`, "18443"},
		{"settings.get", `{"name":"keycloak-port"}`, "18443"},
		{"settings.unset", `{"name":"keycloak-port"}`, ""},
	} {
		answer, _ := answered(t, step.method, step.params)
		var s ControlSetting
		resultOf(t, answer, &s)
		if s.Name != "keycloak-port" || !s.Settable || len(s.Values) != 1 {
			t.Fatalf("%s = %+v", step.method, s)
		}
		if step.want != "" && s.Values[0].Value != step.want {
			t.Errorf("%s: value %s, want %s", step.method, s.Values[0].Value, step.want)
		}
		if step.want == "" && s.Values[0].Value == "18443" {
			t.Errorf("%s left the port set", step.method)
		}
	}
}

// Each machine document settings.path names is under the machine's home.
func TestControlSettingsPathOfEachDocument(t *testing.T) {
	home := onBareMachine(t)
	for document := range machineDocuments {
		answer, _ := answered(t, "settings.path", `{"document":"`+document+`"}`)
		var p ControlSettingsPathResult
		resultOf(t, answer, &p)
		if !strings.HasPrefix(p.Path, home) {
			t.Errorf("%s's document is at %s, outside the machine's home %s", document, p.Path, home)
		}
	}
}

// An operation that panics fails its request alone: it is answered -32603
// control.failed, and stderr says what panicked (E4).
func TestControlOperationThatPanicsFailsItsRequest(t *testing.T) {
	about := controlHandlers["launcher.about"]
	t.Cleanup(func() { controlHandlers["launcher.about"] = about })
	controlHandlers["launcher.about"] = func(*controlRequest, *UI) (any, *controlFailure) { panic("a test's panic") }
	answer, diag := answered(t, "launcher.about", `{}`)
	if answer.Error == nil || answer.Error.Code != rpcInternalError || answer.Error.Data == nil ||
		answer.Error.Data.Code != controlCodeFailed {
		t.Fatalf("answered %+v, want -32603 %s", answer, controlCodeFailed)
	}
	if !strings.Contains(diag, "panicked: a test's panic") {
		t.Errorf("stderr does not say what panicked: %q", diag)
	}
}

func TestControlIdentityUseraddForTarget(t *testing.T) {
	target := &StackState{KBRoot: "/kb", KBDid: "did:web:kb.example"}
	params := ControlIdentityUseraddParams{Email: "person@example.org"}
	run := func(_ *UI, got useraddOpts, password, root, did string) (useraddResult, int) {
		if got.email != params.Email || password != "secret" || root != target.KBRoot || did != target.KBDid {
			t.Fatalf("useradd arguments = %+v, %q, %q, %q", got, password, root, did)
		}
		return useraddResult{email: got.email, identity: "did:web:kb.example:users:1", created: true, generatedPassword: "once"}, 0
	}
	password := "secret"
	params.Password = &password

	t.Run("invalid email is refused", func(t *testing.T) {
		bad := params
		bad.Email = "not-an-email"
		_, failure := controlIdentityUseraddForTarget(controlTestUI(), bad, target, true, run)
		if failure == nil || failure.code != controlCodeInvalidParams {
			t.Fatalf("failure = %+v, want invalid params", failure)
		}
	})
	t.Run("missing password is refused", func(t *testing.T) {
		missing := params
		missing.Password = nil
		_, failure := controlIdentityUseraddForTarget(controlTestUI(), missing, target, true, run)
		if failure == nil || failure.code != controlCodeInvalidParams {
			t.Fatalf("failure = %+v, want invalid params", failure)
		}
	})
	t.Run("unrecorded stack is refused", func(t *testing.T) {
		_, failure := controlIdentityUseraddForTarget(controlTestUI(), params, nil, false, run)
		if failure == nil || failure.code != controlCodeFailed {
			t.Fatalf("failure = %+v, want failed lookup", failure)
		}
	})
	t.Run("codespace is refused", func(t *testing.T) {
		remote := &StackState{Codespace: &codespacePlacement{Repo: "owner/kb"}}
		_, failure := controlIdentityUseraddForTarget(controlTestUI(), params, remote, true, run)
		if failure == nil || failure.code != controlCodeStackNotRunning {
			t.Fatalf("failure = %+v, want local-stack refusal", failure)
		}
	})
	t.Run("useradd failure is returned", func(t *testing.T) {
		_, failure := controlIdentityUseraddForTarget(controlTestUI(), params, target, true, func(*UI, useraddOpts, string, string, string) (useraddResult, int) {
			return useraddResult{}, 1
		})
		if failure == nil || failure.code != controlCodeFailed {
			t.Fatalf("failure = %+v, want failed useradd", failure)
		}
	})
	t.Run("successful result includes the one-time generated password", func(t *testing.T) {
		params.Password = nil
		params.GeneratePassword = true
		result, failure := controlIdentityUseraddForTarget(controlTestUI(), params, target, true, func(_ *UI, got useraddOpts, _, _, _ string) (useraddResult, int) {
			if !got.generate {
				t.Fatal("the generate-password flag was not mapped")
			}
			return useraddResult{email: got.email, identity: "did:web:kb.example:users:1", created: true, generatedPassword: "one-time"}, 0
		})
		if failure != nil {
			t.Fatalf("failure = %+v", failure)
		}
		got := result.(ControlIdentityUseraddResult)
		if got.Email != params.Email || got.Identity == "" || !got.Created || got.GeneratedPassword == nil || *got.GeneratedPassword != "one-time" {
			t.Fatalf("result = %+v", got)
		}
	})
}

func TestControlIdentityUsersListForTarget(t *testing.T) {
	target := &StackState{KBRoot: "/kb", KBDid: "did:web:kb.example"}
	admin := realmAdmin{base: "http://issuer", realm: "semiont", token: "admin", domain: "kb.example", subjectClaim: "sub"}
	resolve := func(_ *UI, root, did string) (realmAdmin, bool) {
		if root != target.KBRoot || did != target.KBDid {
			t.Fatalf("resolve arguments = %q, %q", root, did)
		}
		return admin, true
	}
	list := func(base, realm, token string) ([]realmUser, error) {
		if base != admin.base || realm != admin.realm || token != admin.token {
			t.Fatalf("list arguments = %q, %q, %q", base, realm, token)
		}
		return []realmUser{{id: "123", email: "person@example.org", enabled: true}}, nil
	}

	for _, tc := range []struct {
		name    string
		target  *StackState
		ok      bool
		resolve controlRealmAdminResolver
		list    controlRealmUserLister
		code    string
	}{
		{name: "failed root lookup", target: target, ok: false, resolve: resolve, list: list, code: controlCodeFailed},
		{name: "no local stack", ok: true, resolve: resolve, list: list, code: controlCodeStackNotRunning},
		{name: "codespace target", target: &StackState{Codespace: &codespacePlacement{Repo: "owner/kb"}}, ok: true, resolve: resolve, list: list, code: controlCodeStackNotRunning},
		{name: "cannot resolve realm admin", target: target, ok: true, resolve: func(*UI, string, string) (realmAdmin, bool) { return realmAdmin{}, false }, list: list, code: controlCodeFailed},
		{name: "realm request fails", target: target, ok: true, resolve: resolve, list: func(string, string, string) ([]realmUser, error) { return nil, fmt.Errorf("issuer unavailable") }, code: controlCodeFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, failure := controlIdentityUsersListForTarget(controlTestUI(), tc.target, tc.ok, tc.resolve, tc.list)
			if failure == nil || failure.code != tc.code {
				t.Fatalf("failure = %+v, want %s", failure, tc.code)
			}
		})
	}
	t.Run("returns account identities and enabled state", func(t *testing.T) {
		result, failure := controlIdentityUsersListForTarget(controlTestUI(), target, true, resolve, list)
		if failure != nil {
			t.Fatalf("failure = %+v", failure)
		}
		got := result.(ControlIdentityUsersListResult)
		if len(got.Users) != 1 || got.Users[0].Email != "person@example.org" || got.Users[0].Identity != "did:web:kb.example:users:123" || !got.Users[0].Enabled {
			t.Fatalf("users = %+v", got.Users)
		}
	})
}
