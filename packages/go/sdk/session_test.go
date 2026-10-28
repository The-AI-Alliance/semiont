package semiont_test

// What a session does, by the session table every SDK runs
// (specs/src/session/cases.json, startup and refusal): what it renews and whom
// it asks, how it ends, and what it says.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

const kb = "kb-alpha"

type sessionRow struct {
	Why      string   `json:"why"`
	Stored   string   `json:"stored"`
	Gateway  []string `json:"gateway"`
	Issuer   []string `json:"issuer"`
	Asks     int      `json:"asks"`
	Renewals int      `json:"renewals"`
	Given    *bool    `json:"given"`
	Ends     string   `json:"ends"`
	Told     *string  `json:"told"`
	Error    *string  `json:"error"`
	Kept     bool     `json:"kept"`
}

func readSessionRows(t *testing.T) (startup, refusal []sessionRow) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "specs", "src", "session", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Startup []sessionRow `json:"startup"`
		Refusal []sessionRow `json:"refusal"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Startup) < 10 || len(table.Refusal) < 4 {
		t.Fatalf("the table states %d startup and %d refusal rows: it was not read", len(table.Startup), len(table.Refusal))
	}
	return table.Startup, table.Refusal
}

// tokenFor is a JWT that expires lifetime from now, told apart by n.
func tokenFor(lifetime time.Duration, n int) string {
	now := time.Now()
	claims, _ := json.Marshal(map[string]any{"iat": now.Unix(), "exp": now.Add(lifetime).Unix(), "n": n})
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(claims) + ".c2lnbmF0dXJl"
}

func alice() api.UserResponse {
	name := "Alice"
	return api.UserResponse{Email: "alice@example.org", Name: &name, Domain: "example.org"}
}

// world is a session's surroundings, and a record of what the session did to
// them. Each script's last answer repeats.
type world struct {
	mu       sync.Mutex
	kept     *semiont.MemorySignIn
	token    *semiont.Variable[string]
	renewals []string // what refresh answers, in order: "" for a refusal
	renewed  int
	// takes is how long the issuer takes to answer a renewal.
	takes       time.Duration
	validations []error // what the gateway says of a token, in order: nil accepts
	validated   []string
	told        []semiont.SessionEndReason
	errors      []string
}

func newWorld(t *testing.T, kept string) *world {
	w := &world{kept: &semiont.MemorySignIn{}, token: semiont.NewVariable("")}
	if kept != "" {
		if err := w.kept.Keep(context.Background(), semiont.HeldSignIn{Access: kept, Refresh: "a-refresh-token", ClientID: "semiont-cli", TokenEndpoint: "https://issuer.test/token"}); err != nil {
			t.Fatal(err)
		}
	}
	return w
}

func (w *world) refresh(context.Context) (string, error) {
	time.Sleep(w.takes)
	w.mu.Lock()
	defer w.mu.Unlock()
	w.renewed++
	if len(w.renewals) == 0 {
		return "", nil
	}
	answer := w.renewals[0]
	w.renewals = w.renewals[1:]
	return answer, nil
}

func (w *world) validate(_ context.Context, token string) (api.UserResponse, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.validated = append(w.validated, token)
	if len(w.validations) == 0 {
		return alice(), nil
	}
	answer := w.validations[0]
	w.validations = w.validations[1:]
	if answer != nil {
		return api.UserResponse{}, answer
	}
	return alice(), nil
}

func (w *world) start(t *testing.T) *semiont.Session {
	t.Helper()
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb:       api.KbTarget{Id: kb},
		Token:    w.token,
		Kept:     w.kept,
		Refresh:  w.refresh,
		Validate: w.validate,
		OnAuthFailed: func(reason semiont.SessionEndReason) {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.told = append(w.told, reason)
		},
		OnError: func(err *semiont.SessionError) {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.errors = append(w.errors, string(err.Code))
		},
		Timing: semiont.DefaultTiming(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(session.Close)
	ready, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatalf("the session was not ready: %v", err)
	}
	return session
}

func (w *world) counts() (asks, renewals int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.validated), w.renewed
}

func scripted(script []string, n int) string { return script[min(n, len(script)-1)] }

func gatewaySays(row sessionRow, n int) error {
	switch answer := scripted(row.Gateway, n); answer {
	case "accepts":
		return nil
	case "refuses":
		return &semiont.TransportError{Code: semiont.TransportErrorCodeUnauthorized, Message: "HTTP 401"}
	case "unreachable":
		return &semiont.TransportError{Code: semiont.TransportErrorCodeUnavailable, Message: "HTTP 503"}
	default:
		panic(fmt.Sprintf("the gateway %s", answer))
	}
}

func issuerSays(row sessionRow, n int, renewed string) string {
	switch answer := scripted(row.Issuer, n); answer {
	case "renews":
		return renewed
	case "refuses":
		return ""
	default:
		panic(fmt.Sprintf("the issuer %s", answer))
	}
}

// oneTooMany stops a session that asks more than the row allows: an answer
// that is no refusal.
var oneTooMany = &semiont.TransportError{Code: semiont.TransportErrorCodeError, Message: "asked more than the case allows"}

func ends(session *semiont.Session, w *world) string {
	if w.token.Value() == "" {
		return "signed-out"
	}
	if session.User().Value() == nil {
		return "unconfirmed"
	}
	return "signed-in"
}

func isAsStated(t *testing.T, row sessionRow, w *world, session *semiont.Session, askedBefore int) {
	t.Helper()
	asks, renewals := w.counts()
	if asks-askedBefore != row.Asks || renewals != row.Renewals {
		t.Errorf("%s: asked %d and renewed %d, want %d and %d", row.Why, asks-askedBefore, renewals, row.Asks, row.Renewals)
	}
	if got := ends(session, w); got != row.Ends {
		t.Errorf("%s: ended %s, want %s", row.Why, got, row.Ends)
	}
	w.mu.Lock()
	told, errs := slices.Clone(w.told), slices.Clone(w.errors)
	w.mu.Unlock()
	var wantTold []semiont.SessionEndReason
	if row.Told != nil {
		wantTold = []semiont.SessionEndReason{semiont.SessionEndReason(*row.Told)}
	}
	if !slices.Equal(told, wantTold) {
		t.Errorf("%s: told %v, want %v", row.Why, told, wantTold)
	}
	var wantErrors []string
	if row.Error != nil {
		wantErrors = []string{*row.Error}
	}
	if !slices.Equal(errs, wantErrors) {
		t.Errorf("%s: said %v, want %v", row.Why, errs, wantErrors)
	}
	_, kept, err := w.kept.Held(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if kept != row.Kept {
		t.Errorf("%s: kept is %v, want %v", row.Why, kept, row.Kept)
	}
}

func TestASessionStartsAsTheTableStates(t *testing.T) {
	startup, _ := readSessionRows(t)
	for _, row := range startup {
		t.Run(row.Why, func(t *testing.T) {
			stored := map[string]string{"none": "", "unexpired": tokenFor(time.Hour, 0), "expired": tokenFor(-time.Minute, 0)}[row.Stored]
			w := newWorld(t, stored)
			for n := range row.Renewals {
				w.renewals = append(w.renewals, issuerSays(row, n, tokenFor(time.Hour, n+1)))
			}
			for n := range row.Asks {
				w.validations = append(w.validations, gatewaySays(row, n))
			}
			w.validations = append(w.validations, oneTooMany)
			session := w.start(t)
			isAsStated(t, row, w, session, 0)
		})
	}
}

func TestARefusedSessionRenewsAndAsksAsTheTableStates(t *testing.T) {
	_, refusal := readSessionRows(t)
	for _, row := range refusal {
		t.Run(row.Why, func(t *testing.T) {
			// The session starts signed in: the gateway accepts the kept token.
			// Then the row's answers.
			w := newWorld(t, tokenFor(time.Hour, 0))
			for n := range row.Renewals {
				w.renewals = append(w.renewals, issuerSays(row, n, tokenFor(time.Hour, 1)))
			}
			w.validations = append(w.validations, nil)
			for n := range row.Asks {
				w.validations = append(w.validations, gatewaySays(row, n))
			}
			w.validations = append(w.validations, oneTooMany)
			session := w.start(t)
			if got := ends(session, w); got != "signed-in" {
				t.Fatalf("the session started %s, not signed in", got)
			}
			given, ok := session.Refresh(context.Background())
			if row.Given == nil || ok != *row.Given {
				t.Errorf("%s: refresh gave a token: %v, want %v", row.Why, ok, row.Given != nil && *row.Given)
			}
			if ok && given != w.token.Value() {
				t.Errorf("%s: refresh gave a token that is not the session's", row.Why)
			}
			isAsStated(t, row, w, session, 1)
		})
	}
}

// Refusals that arrive together are answered together: however many requests
// were refused at once, they cost one renewal and one ask.
func TestRefusalsThatArriveTogetherCostOneRenewalAndOneAsk(t *testing.T) {
	w := newWorld(t, tokenFor(time.Hour, 0))
	w.renewals = []string{tokenFor(time.Hour, 1), tokenFor(time.Hour, 2)}
	session := w.start(t)
	// An issuer that takes a moment, as one does: the refusals overlap.
	w.takes = 200 * time.Millisecond
	asked, _ := w.counts()
	var together sync.WaitGroup
	given := make([]string, 4)
	for i := range given {
		together.Add(1)
		go func() {
			defer together.Done()
			given[i], _ = session.Refresh(context.Background())
		}()
	}
	together.Wait()
	asks, renewals := w.counts()
	if renewals != 1 || asks-asked != 1 {
		t.Errorf("four refusals together renewed %d times and asked %d, want once each", renewals, asks-asked)
	}
	for i, token := range given {
		if token != w.token.Value() {
			t.Errorf("refusal %d was given another token than the session's", i+1)
		}
	}
}

// refusedAtTheGateway is the gateway's refusal of a token.
var refusedAtTheGateway = &semiont.TransportError{Code: semiont.TransportErrorCodeUnauthorized, Message: "HTTP 401"}

// invalidGrant is the issuer's refusal of a renewal, in its own words.
var invalidGrant = errors.New("The issuer refused the token refresh (invalid_grant: Token is not active)")

// keptUnexpired is a kept sign-in whose access token lives an hour.
func keptUnexpired(t *testing.T, kept semiont.SignInKept) {
	t.Helper()
	if err := kept.Keep(context.Background(), semiont.HeldSignIn{Access: tokenFor(time.Hour, 0), Refresh: "a-refresh-token", ClientID: "semiont-cli", TokenEndpoint: "https://issuer.test/token"}); err != nil {
		t.Fatal(err)
	}
}

// forgetsSlowly is a kept sign-in that takes a moment to forget, or until
// let: the moment between a session's token going and its saying why.
type forgetsSlowly struct {
	*semiont.MemorySignIn
	let chan struct{}
}

func (f forgetsSlowly) Forget(ctx context.Context) error {
	select {
	case <-f.let:
	case <-time.After(300 * time.Millisecond):
	}
	return f.MemorySignIn.Forget(ctx)
}

// The start and the stream are refused the kept token together, and the
// stream's refusal is answered first, with a renewal the issuer refuses: the
// session is ready only once it has said why it ended. A host that finds it
// ready holding no token, with nothing said, is left to guess why.
func TestASessionEndedAsItStartsHasSaidWhyByTheTimeItIsReady(t *testing.T) {
	kept := forgetsSlowly{MemorySignIn: &semiont.MemorySignIn{}, let: make(chan struct{})}
	keptUnexpired(t, kept)
	token := semiont.NewVariable("")
	var mu sync.Mutex
	var said []*semiont.SessionError
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: token, Kept: kept,
		Refresh: func(context.Context) (string, error) { return "", invalidGrant },
		// The gateway refuses the start's ask once the stream's refusal has
		// taken the token.
		Validate: func(ctx context.Context, _ string) (api.UserResponse, error) {
			for held := range token.Reading().Changes(ctx) {
				if held == "" {
					break
				}
			}
			return api.UserResponse{}, refusedAtTheGateway
		},
		OnError: func(err *semiont.SessionError) {
			mu.Lock()
			defer mu.Unlock()
			said = append(said, err)
		},
		Timing: semiont.DefaultTiming(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(session.Close)
	answered := make(chan struct{})
	go func() {
		defer close(answered)
		session.Refresh(context.Background())
	}()

	ready, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatalf("the session was not ready: %v", err)
	}
	mu.Lock()
	saidByReady := slices.Clone(said)
	mu.Unlock()
	close(kept.let)
	<-answered

	if len(saidByReady) != 1 || saidByReady[0].Code != semiont.SessionErrorCodeRefreshExhausted {
		t.Fatalf("by the time it was ready the session had said %v, want the one %s", saidByReady, semiont.SessionErrorCodeRefreshExhausted)
	}
	if !strings.Contains(saidByReady[0].Message, "invalid_grant") {
		t.Errorf("the session said %q, not why the issuer refused", saidByReady[0].Message)
	}
	if token.Value() != "" {
		t.Error("a session that ended still holds a token")
	}
}

// The start is answering its refusal, at an issuer that takes a moment to
// refuse, when the stream is refused too: the stream's refusal waits for the
// start's answer, which ended the session and said why, and costs the issuer
// no second renewal.
func TestARefusalMetWhileTheStartAnswersOneIsAnsweredByIt(t *testing.T) {
	kept := &semiont.MemorySignIn{}
	keptUnexpired(t, kept)
	token := semiont.NewVariable("")
	renewing := make(chan struct{})
	var mu sync.Mutex
	grants := 0
	var said []*semiont.SessionError
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: token, Kept: kept,
		// Nothing kept is nothing to renew, and no grant is sent, as
		// Issuer.RenewKept sends none.
		Refresh: func(ctx context.Context) (string, error) {
			if _, held, _ := kept.Held(ctx); !held {
				return "", nil
			}
			mu.Lock()
			grants++
			first := grants == 1
			mu.Unlock()
			if first {
				close(renewing)
				time.Sleep(300 * time.Millisecond)
			}
			return "", invalidGrant
		},
		Validate: func(context.Context, string) (api.UserResponse, error) {
			return api.UserResponse{}, refusedAtTheGateway
		},
		OnError: func(err *semiont.SessionError) {
			mu.Lock()
			defer mu.Unlock()
			said = append(said, err)
		},
		Timing: semiont.DefaultTiming(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(session.Close)
	select {
	case <-renewing:
	case <-time.After(5 * time.Second):
		t.Fatal("the start never renewed the refused token")
	}

	given, ok := session.Refresh(context.Background())
	mu.Lock()
	saidByAnswer := slices.Clone(said)
	mu.Unlock()
	ready, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatalf("the session was not ready: %v", err)
	}

	if ok || given != "" {
		t.Error("the stream was given a token by a session that ended")
	}
	if len(saidByAnswer) != 1 || saidByAnswer[0].Code != semiont.SessionErrorCodeRefreshExhausted {
		t.Errorf("by the time the stream's refusal was answered the session had said %v, want the one %s", saidByAnswer, semiont.SessionErrorCodeRefreshExhausted)
	}
	mu.Lock()
	defer mu.Unlock()
	if grants != 1 || len(said) != 1 {
		t.Errorf("two refusals met together cost %d renewals and said %d failures, want one each", grants, len(said))
	}
}

// A session that never signed in cannot expire: a renewal that gives nothing
// says nothing.
func TestASessionThatNeverSignedInCannotExpire(t *testing.T) {
	w := newWorld(t, "")
	session := w.start(t)
	if _, ok := session.Refresh(context.Background()); ok {
		t.Error("refresh gave a token to a session that holds no sign-in")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.told) != 0 || len(w.errors) != 0 {
		t.Errorf("a session that never signed in told %v and said %v", w.told, w.errors)
	}
}

// Closing a session ends what it runs: a session closed while it starts is
// ready, and says nothing.
func TestASessionClosedWhileItStartsIsReadyAndSaysNothing(t *testing.T) {
	w := newWorld(t, tokenFor(time.Hour, 0))
	asking := make(chan struct{})
	release := make(chan struct{})
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: w.token, Kept: w.kept, Refresh: w.refresh,
		Validate: func(ctx context.Context, token string) (api.UserResponse, error) {
			close(asking)
			select {
			case <-ctx.Done():
				return api.UserResponse{}, ctx.Err()
			case <-release:
				return alice(), nil
			}
		},
		OnError: func(err *semiont.SessionError) { t.Errorf("a session closed while it started said %s", err.Code) },
		Timing:  semiont.DefaultTiming(),
	})
	if err != nil {
		t.Fatal(err)
	}
	<-asking
	session.Close()
	close(release)
	if err := session.Ready(context.Background()); err != nil {
		t.Errorf("a closed session is not ready: %v", err)
	}
}
