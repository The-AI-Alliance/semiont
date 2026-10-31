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
	"io"
	"net/http"
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
	name, email := "Alice", "alice@example.org"
	return api.UserResponse{Email: &email, Name: &name, Domain: "example.org"}
}

// renewal is what refresh answers: a token, or why there is none.
type renewal struct {
	token string
	err   error
}

// answering is an HTTP client's transport whose every request is answered by
// the function.
type answering func(*http.Request) (*http.Response, error)

func (a answering) RoundTrip(request *http.Request) (*http.Response, error) { return a(request) }

// fromTheIssuer is how a renewal fails at an issuer that answers status, or
// answers nothing when status is 0: what Issuer.Refresh returns.
func fromTheIssuer(t *testing.T, status int) error {
	t.Helper()
	issuer := semiont.Issuer{HTTP: &http.Client{Transport: answering(func(*http.Request) (*http.Response, error) {
		if status == 0 {
			return nil, errors.New("the network is down")
		}
		body := `{"error":"invalid_grant","error_description":"Token is not active"}`
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}, Timing: semiont.DefaultTiming()}
	_, err := issuer.Refresh(context.Background(), "https://issuer.test/token", "semiont-cli", "a-refresh-token")
	if err == nil {
		t.Fatalf("an issuer that answers %d renewed", status)
	}
	return err
}

// world is a session's surroundings, and a record of what the session did to
// them. Each script's last answer repeats.
type world struct {
	mu       sync.Mutex
	kept     *semiont.MemorySignIn
	token    *semiont.Variable[string]
	renewals []renewal // what refresh answers, in order; nothing once they are spent
	renewed  int
	// takes is how long the issuer takes to answer a renewal.
	takes       time.Duration
	validations []error // what the gateway says of a token, in order: nil accepts
	validated   []string
	// holding is the token the session held as each ask was made.
	holding []string
	told    []semiont.SessionEndReason
	errors  []*semiont.SessionError
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

func (w *world) refresh(context.Context, string) (string, error) {
	time.Sleep(w.takes)
	w.mu.Lock()
	defer w.mu.Unlock()
	w.renewed++
	if len(w.renewals) == 0 {
		return "", nil
	}
	answer := w.renewals[0]
	w.renewals = w.renewals[1:]
	return answer.token, answer.err
}

func (w *world) validate(_ context.Context, token string) (api.UserResponse, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.validated = append(w.validated, token)
	w.holding = append(w.holding, w.token.Value())
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
			w.errors = append(w.errors, err)
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

func issuerSays(t *testing.T, row sessionRow, n int, renewed string) renewal {
	switch answer := scripted(row.Issuer, n); answer {
	case "renews":
		return renewal{token: renewed}
	case "refuses":
		return renewal{err: fromTheIssuer(t, http.StatusBadRequest)}
	case "unreachable":
		return renewal{err: fromTheIssuer(t, 0)}
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
	told := slices.Clone(w.told)
	var errs []string
	for _, said := range w.errors {
		errs = append(errs, string(said.Code))
	}
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
				w.renewals = append(w.renewals, issuerSays(t, row, n, tokenFor(time.Hour, n+1)))
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
				w.renewals = append(w.renewals, issuerSays(t, row, n, tokenFor(time.Hour, 1)))
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
			given, ok := session.Refresh(context.Background(), w.token.Value())
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
	w.renewals = []renewal{{token: tokenFor(time.Hour, 1)}, {token: tokenFor(time.Hour, 2)}}
	session := w.start(t)
	// An issuer that takes a moment, as one does: the refusals overlap.
	w.takes = 200 * time.Millisecond
	asked, _ := w.counts()
	refused := w.token.Value()
	var together sync.WaitGroup
	given := make([]string, 4)
	for i := range given {
		together.Add(1)
		go func() {
			defer together.Done()
			given[i], _ = session.Refresh(context.Background(), refused)
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

// keptUnexpired keeps a sign-in whose access token lives an hour, and is that
// token.
func keptUnexpired(t *testing.T, kept semiont.SignInKept) string {
	t.Helper()
	access := tokenFor(time.Hour, 0)
	if err := kept.Keep(context.Background(), semiont.HeldSignIn{Access: access, Refresh: "a-refresh-token", ClientID: "semiont-cli", TokenEndpoint: "https://issuer.test/token"}); err != nil {
		t.Fatal(err)
	}
	return access
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
// issuer refuses to renew it: the session is ready only once it has said why
// it ended, whichever refusal was answered first. A host that finds it ready
// holding no token, with nothing said, is left to guess why.
func TestASessionEndedAsItStartsHasSaidWhyByTheTimeItIsReady(t *testing.T) {
	invalidGrant := fromTheIssuer(t, http.StatusBadRequest)
	kept := forgetsSlowly{MemorySignIn: &semiont.MemorySignIn{}, let: make(chan struct{})}
	refused := keptUnexpired(t, kept)
	token := semiont.NewVariable("")
	var mu sync.Mutex
	var said []*semiont.SessionError
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: token, Kept: kept,
		Refresh: func(context.Context, string) (string, error) { return "", invalidGrant },
		// The gateway takes a moment to refuse the start's ask, and refuses
		// it at once when the token goes meanwhile.
		Validate: func(ctx context.Context, _ string) (api.UserResponse, error) {
			moment, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
			defer cancel()
			for held := range token.Reading().Changes(moment) {
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
		session.Refresh(context.Background(), refused)
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
	invalidGrant := fromTheIssuer(t, http.StatusBadRequest)
	kept := &semiont.MemorySignIn{}
	refused := keptUnexpired(t, kept)
	token := semiont.NewVariable("")
	renewing := make(chan struct{})
	var mu sync.Mutex
	grants := 0
	var said []*semiont.SessionError
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: token, Kept: kept,
		// Nothing kept is nothing to renew, and no grant is sent, as
		// Issuer.RenewKept sends none.
		Refresh: func(ctx context.Context, _ string) (string, error) {
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

	given, ok := session.Refresh(context.Background(), refused)
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

// Two requests are refused the session's token, and the second asks for
// another only once the first's refusal is answered: it is given the renewed
// token, and the issuer is not asked to renew again.
func TestRefusalsOfOneTokenOneAfterAnotherCostOneRenewal(t *testing.T) {
	refused := tokenFor(time.Hour, 0)
	renewed := tokenFor(time.Hour, 1)
	w := newWorld(t, refused)
	w.renewals = []renewal{{token: renewed}, {token: tokenFor(time.Hour, 2)}}
	session := w.start(t)
	asked, _ := w.counts()

	first, _ := session.Refresh(context.Background(), refused)
	second, ok := session.Refresh(context.Background(), refused)
	if first != renewed || !ok || second != renewed {
		t.Errorf("the second refusal of the token renewed since was not given the renewed token (given one: %v)", ok)
	}
	if asks, renewals := w.counts(); renewals != 1 || asks-asked != 1 {
		t.Errorf("two refusals of one token, one after another, renewed %d times and asked %d, want once each", renewals, asks-asked)
	}
}

// A refusal of the kept token meets the start asking the gateway about it, at
// a gateway that takes a moment to reach: the refusal waits for the start, so
// the gateway is never asked about a token once the session holds another,
// and the issuer renews once.
func TestARefusalMetWhileTheStartAsksWaitsForIt(t *testing.T) {
	kept := &semiont.MemorySignIn{}
	stale := keptUnexpired(t, kept)
	renewed := tokenFor(time.Hour, 1)
	token := semiont.NewVariable("")
	asking := make(chan struct{})
	answered := make(chan struct{})
	type ask struct{ sent, held string }
	var mu sync.Mutex
	grants := 0
	var asked []ask
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: token, Kept: kept,
		Refresh: func(context.Context, string) (string, error) {
			mu.Lock()
			defer mu.Unlock()
			grants++
			return renewed, nil
		},
		// The start's first ask reaches the gateway once the stream's refusal
		// has been answered, or after a moment. What the session holds then is
		// what the stream is sending.
		Validate: func(_ context.Context, sent string) (api.UserResponse, error) {
			mu.Lock()
			first := len(asked) == 0
			mu.Unlock()
			if first {
				close(asking)
				select {
				case <-answered:
				case <-time.After(300 * time.Millisecond):
				}
			}
			mu.Lock()
			asked = append(asked, ask{sent: sent, held: token.Value()})
			mu.Unlock()
			if sent != renewed {
				return api.UserResponse{}, refusedAtTheGateway
			}
			return alice(), nil
		},
		Timing: semiont.DefaultTiming(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(session.Close)
	select {
	case <-asking:
	case <-time.After(5 * time.Second):
		t.Fatal("the start never asked the gateway")
	}
	var given string
	var ok bool
	go func() {
		defer close(answered)
		given, ok = session.Refresh(context.Background(), stale)
	}()

	ready, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatalf("the session was not ready: %v", err)
	}
	<-answered

	mu.Lock()
	defer mu.Unlock()
	for i, a := range asked {
		if a.held != "" && a.held != a.sent {
			t.Errorf("ask #%d was about a token the session no longer held", i+1)
		}
	}
	if grants != 1 {
		t.Errorf("the start's refusal and the stream's cost %d renewals, want 1", grants)
	}
	if !ok || given != renewed {
		t.Errorf("the stream's refusal was not given the renewed token (given one: %v)", ok)
	}
	if session.User().Value() == nil {
		t.Error("the session did not start signed in")
	}
}

// A session that asks the gateway who its kept token is gives the transport
// that token once the gateway has not refused it: while it is asked the
// transport has none to send, and one the gateway refuses it never has.
func TestTheTransportHasTheKeptTokenOnceTheGatewayHasNotRefusedIt(t *testing.T) {
	kept, renewed := tokenFor(time.Hour, 0), tokenFor(time.Hour, 1)
	named := map[string]string{"": "none", kept: "the kept token", renewed: "the renewed token"}
	for _, row := range []struct {
		why         string
		validations []error
		holding     []string
		holds       string
	}{
		{"the gateway accepts it", []error{nil}, []string{"none"}, "the kept token"},
		{"the gateway cannot be asked", []error{&semiont.TransportError{Code: semiont.TransportErrorCodeUnavailable, Message: "HTTP 503"}}, []string{"none"}, "the kept token"},
		{"the gateway refuses it and accepts the renewed one", []error{refusedAtTheGateway, nil}, []string{"none", "the renewed token"}, "the renewed token"},
	} {
		t.Run(row.why, func(t *testing.T) {
			w := newWorld(t, kept)
			w.renewals = []renewal{{token: renewed}}
			w.validations = row.validations
			w.start(t)
			w.mu.Lock()
			var holding []string
			for _, token := range w.holding {
				holding = append(holding, named[token])
			}
			w.mu.Unlock()
			if !slices.Equal(holding, row.holding) {
				t.Errorf("as the gateway was asked the transport held %v, want %v", holding, row.holding)
			}
			if holds := named[w.token.Value()]; holds != row.holds {
				t.Errorf("once the session started the transport held %s, want %s", holds, row.holds)
			}
		})
	}
}

// A kept token that has expired, and that the issuer will not renew, or that
// nothing is kept to renew, is forgotten at the start, and nothing is said:
// there was no session to end.
func TestAnExpiredTokenTheIssuerWillNotRenewIsForgottenAndNothingIsSaid(t *testing.T) {
	for _, row := range []struct {
		why     string
		renewal renewal
	}{
		{"nothing to renew with", renewal{}},
		{"the issuer refuses", renewal{err: fromTheIssuer(t, http.StatusBadRequest)}},
		{"the issuer answers with no token", renewal{err: fromTheIssuer(t, http.StatusOK)}},
	} {
		t.Run(row.why, func(t *testing.T) {
			w := newWorld(t, tokenFor(-time.Minute, 0))
			w.renewals = []renewal{row.renewal}
			w.start(t)
			if _, kept, _ := w.kept.Held(context.Background()); kept {
				t.Error("the sign-in is still kept")
			}
			w.mu.Lock()
			defer w.mu.Unlock()
			if w.token.Value() != "" || len(w.told) != 0 || len(w.errors) != 0 {
				t.Errorf("the session holds a token: %v; told %v and said %v", w.token.Value() != "", w.told, w.errors)
			}
		})
	}
}

// A kept token that has expired, and whose renewal got no answer, or only
// answers worth another attempt, is kept: the session starts with no token,
// says why, and renews it when a request is refused.
func TestAnExpiredTokenWhoseRenewalGotNoAnswerIsKeptAndRenewedWhenARequestIsRefused(t *testing.T) {
	for _, row := range []struct {
		why     string
		failure error
	}{
		{"no answer", fromTheIssuer(t, 0)},
		{"not now", fromTheIssuer(t, http.StatusServiceUnavailable)},
	} {
		t.Run(row.why, func(t *testing.T) {
			renewed := tokenFor(time.Hour, 2)
			w := newWorld(t, tokenFor(-time.Minute, 0))
			w.renewals = []renewal{{err: row.failure}, {token: renewed}}
			session := w.start(t)
			if _, kept, _ := w.kept.Held(context.Background()); !kept {
				t.Fatal("the sign-in was forgotten")
			}
			w.mu.Lock()
			told, said := slices.Clone(w.told), slices.Clone(w.errors)
			w.mu.Unlock()
			if w.token.Value() != "" || len(told) != 0 {
				t.Errorf("the session holds a token: %v; told %v", w.token.Value() != "", told)
			}
			want := "Token refresh failed: " + row.failure.Error()
			if len(said) != 1 || said[0].Code != semiont.SessionErrorCodeAuthFailed || said[0].Message != want {
				t.Fatalf("the session said %v, want %s: %q", said, semiont.SessionErrorCodeAuthFailed, want)
			}
			// The issuer answers again: a request refused for want of a token
			// renews it.
			given, ok := session.Refresh(context.Background(), "")
			if !ok || given != renewed || w.token.Value() != renewed {
				t.Errorf("a refusal after the start was given the renewed token: %v", ok && given == renewed)
			}
			if _, renewals := w.counts(); renewals != 2 {
				t.Errorf("renewed %d times, want 2", renewals)
			}
		})
	}
}

// A running session whose renewal got no answer, or only answers worth
// another attempt, holds no usable token and keeps what is kept: it says why,
// is not over, and the next refusal renews again.
func TestARenewalThatGotNoAnswerKeepsWhatIsKeptAndTheNextRefusalRenewsAgain(t *testing.T) {
	for _, row := range []struct {
		why     string
		failure error
	}{
		{"no answer", fromTheIssuer(t, 0)},
		{"not now", fromTheIssuer(t, http.StatusServiceUnavailable)},
	} {
		t.Run(row.why, func(t *testing.T) {
			refused, renewed := tokenFor(time.Hour, 0), tokenFor(time.Hour, 2)
			w := newWorld(t, refused)
			w.renewals = []renewal{{err: row.failure}, {token: renewed}}
			session := w.start(t)
			if _, ok := session.Refresh(context.Background(), refused); ok {
				t.Fatal("a renewal that got no answer gave a token")
			}
			if _, kept, _ := w.kept.Held(context.Background()); !kept {
				t.Fatal("the sign-in was forgotten")
			}
			w.mu.Lock()
			told, said := slices.Clone(w.told), slices.Clone(w.errors)
			w.mu.Unlock()
			if w.token.Value() != "" || len(told) != 0 {
				t.Errorf("the session holds a token: %v; told %v", w.token.Value() != "", told)
			}
			want := "Token refresh failed: " + row.failure.Error()
			if len(said) != 1 || said[0].Code != semiont.SessionErrorCodeRefreshExhausted || said[0].Message != want {
				t.Fatalf("the session said %v, want %s: %q", said, semiont.SessionErrorCodeRefreshExhausted, want)
			}
			if given, ok := session.Refresh(context.Background(), ""); !ok || given != renewed {
				t.Errorf("the next refusal was given the renewed token: %v", ok && given == renewed)
			}
		})
	}
}

// A session that never signed in cannot expire: a renewal that gives nothing
// says nothing.
func TestASessionThatNeverSignedInCannotExpire(t *testing.T) {
	w := newWorld(t, "")
	session := w.start(t)
	if _, ok := session.Refresh(context.Background(), ""); ok {
		t.Error("refresh gave a token to a session that holds no sign-in")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.told) != 0 || len(w.errors) != 0 {
		t.Errorf("a session that never signed in told %v and said %v", w.told, w.errors)
	}
}

// refusesToForget is a kept sign-in whose storage will not forget it.
type refusesToForget struct{ *semiont.MemorySignIn }

func (refusesToForget) Forget(context.Context) error { return errors.New("the storage is full") }

// A kept token that expired, and that the issuer will not renew, is forgotten
// at the start with nothing said. One the storage will not forget is said,
// with why.
func TestAnExpiredSignInTheStorageWillNotForgetIsSaidAtTheStart(t *testing.T) {
	invalidGrant := fromTheIssuer(t, http.StatusBadRequest)
	kept := refusesToForget{&semiont.MemorySignIn{}}
	if err := kept.Keep(context.Background(), semiont.HeldSignIn{Access: tokenFor(-time.Hour, 0), Refresh: "a-refresh-token", ClientID: "semiont-cli", TokenEndpoint: "https://issuer.test/token"}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var said []*semiont.SessionError
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: semiont.NewVariable(""), Kept: kept,
		Refresh: func(context.Context, string) (string, error) { return "", invalidGrant },
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
	ready, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatalf("the session was not ready: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(said) != 1 || said[0].Code != semiont.SessionErrorCodeRefreshExhausted || !strings.Contains(said[0].Message, "the storage is full") {
		t.Fatalf("the session said %+v", said)
	}
	if !strings.Contains(said[0].Message, "invalid_grant") {
		t.Errorf("the session said %q, not why the issuer refused", said[0].Message)
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
