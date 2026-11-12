package semiont_test

// What a session does, by the session table every SDK runs
// (protocol/specs/src/session/cases.json, startup and refusal): what it renews and whom
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
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

const kb = "kb-alpha"

type sessionRow struct {
	Why      string   `json:"why"`
	Stored   string   `json:"stored"`
	Refused  string   `json:"refused"`
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
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "specs", "src", "session", "cases.json"))
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

// answerTo is who the gateway says a token is when it accepts the nth ask:
// told apart from every other answer.
func answerTo(n int) api.UserResponse {
	user := alice()
	name := fmt.Sprintf("Alice %d", n)
	user.Name = &name
	return user
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
	// renewedAt is when each renewal was asked for, and handed what each was
	// handed: the token it renews.
	renewedAt []time.Time
	handed    []string
	// takes is how long the issuer takes to answer a renewal.
	takes       time.Duration
	validations []error // what the gateway says of a token, in order: nil accepts
	validated   []string
	// answered is who the gateway last said a token is.
	answered *api.UserResponse
	// holding is the token the session held as each ask was made.
	holding []string
	told    []semiont.SessionEndReason
	// heard is what the session says on its errors stream, and closed ends
	// it, its client and the client's transport.
	heard  *hearing
	closed func()
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

func (w *world) refresh(_ context.Context, renewing string) (string, error) {
	time.Sleep(w.takes)
	w.mu.Lock()
	defer w.mu.Unlock()
	w.renewed++
	w.renewedAt = append(w.renewedAt, time.Now())
	w.handed = append(w.handed, renewing)
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
	if len(w.validations) != 0 {
		answer := w.validations[0]
		w.validations = w.validations[1:]
		if answer != nil {
			return api.UserResponse{}, answer
		}
	}
	user := answerTo(len(w.validated))
	w.answered = &user
	return user, nil
}

func (w *world) start(t *testing.T) *semiont.Session {
	t.Helper()
	session, heard, closed := started(t, testClient(), semiont.SessionConfig{
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
		Timing: semiont.DefaultTiming(),
	})
	w.heard, w.closed = heard, closed
	ready, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatalf("the session was not ready: %v", err)
	}
	return session
}

// testClient is a client over doubles nothing is scripted to answer.
func testClient() semionttest.TestClient {
	return semionttest.NewTestClient(semionttest.TestClientConfig{Timing: semiont.DefaultTiming()})
}

// started is a session of config over client, what it says on its errors
// stream, read from as soon as it is made, and closed, which closes the
// client, then ends the session, then closes the client's transport, as the
// test's cleanup does too.
func started(t *testing.T, client semionttest.TestClient, config semiont.SessionConfig) (*semiont.Session, *hearing, func()) {
	t.Helper()
	config.Client = client.Client
	session, err := semiont.StartSession(context.Background(), config)
	if err != nil {
		client.Client.Close()
		client.Transport.Close()
		t.Fatal(err)
	}
	heard := hear(session)
	closed := sync.OnceFunc(func() {
		client.Client.Close()
		session.Close()
		client.Transport.Close()
	})
	t.Cleanup(closed)
	return session, heard, closed
}

// hearing is what a session says on its errors stream, its one stream of
// what went wrong: its own failures and its transport's. A session starts as
// it is made, so it is read from as soon as StartSession returns.
type hearing struct {
	said  chan error
	ended chan struct{}
}

func hear(session *semiont.Session) *hearing {
	h := &hearing{said: make(chan error, 256), ended: make(chan struct{})}
	errs := session.Errors()
	go func() {
		defer close(h.ended)
		for failure := range errs {
			h.said <- failure
		}
	}()
	return h
}

// next is the next failure the session says, within the wait; nil when it
// says none by then.
func (h *hearing) next(within time.Duration) error {
	select {
	case said := <-h.said:
		return said
	case <-time.After(within):
		return nil
	}
}

// sofar is every failure said and not yet taken: in a bubble, once
// synctest.Wait has returned, everything said so far.
func (h *hearing) sofar() []error {
	var said []error
	for {
		select {
		case each := <-h.said:
			said = append(said, each)
		default:
			return said
		}
	}
}

// rest is every failure said and not yet taken, until the stream ends:
// closed is called first, which closes the client, the session and the
// client's transport, and a stream that does not end then fails.
func (h *hearing) rest(t *testing.T, closed func()) []error {
	t.Helper()
	closed()
	select {
	case <-h.ended:
	case <-time.After(10 * time.Second):
		t.Fatal("the session's errors stream did not end once the session was closed")
	}
	return h.sofar()
}

// ownErrors is the session's own failures among said, in order.
func ownErrors(said []error) []*semiont.SessionError {
	var own []*semiont.SessionError
	for _, failure := range said {
		if each := sessionError(failure); each != nil {
			own = append(own, each)
		}
	}
	return own
}

// codes is the code of each of the session's own failures, in order.
func codes(said []*semiont.SessionError) []string {
	var named []string
	for _, each := range said {
		named = append(named, string(each.Code))
	}
	return named
}

// sessionError is failure as the session's own; nil when it is none.
func sessionError(failure error) *semiont.SessionError {
	var own *semiont.SessionError
	if errors.As(failure, &own) {
		return own
	}
	return nil
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

// isAsStated holds the session to the row, and each of its renewals to being
// handed renews, the token it renews: the token the row stored, at the start,
// or the one its session started on, at a refusal.
func isAsStated(t *testing.T, row sessionRow, w *world, session *semiont.Session, askedBefore int, renews string) {
	t.Helper()
	asks, renewals := w.counts()
	if asks-askedBefore != row.Asks || renewals != row.Renewals {
		t.Errorf("%s: asked %d and renewed %d, want %d and %d", row.Why, asks-askedBefore, renewals, row.Asks, row.Renewals)
	}
	w.mu.Lock()
	handed := slices.Clone(w.handed)
	w.mu.Unlock()
	for n, each := range handed {
		if each != renews {
			t.Errorf("%s: renewal #%d was handed %q, want the token it renews", row.Why, n+1, each)
		}
	}
	if got := ends(session, w); got != row.Ends {
		t.Errorf("%s: ended %s, want %s", row.Why, got, row.Ends)
	}
	if user := session.User().Value(); row.Ends == "signed-in" && (user == nil || w.answered == nil || *user.Name != *w.answered.Name) {
		t.Errorf("%s: signed in as someone the gateway did not last say the token is", row.Why)
	}
	w.mu.Lock()
	told := slices.Clone(w.told)
	w.mu.Unlock()
	errs := codes(ownErrors(w.heard.rest(t, w.closed)))
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
			isAsStated(t, row, w, session, 0, stored)
		})
	}
}

func TestARefusedSessionRenewsAndAsksAsTheTableStates(t *testing.T) {
	_, refusal := readSessionRows(t)
	for _, row := range refusal {
		t.Run(row.Why, func(t *testing.T) {
			// The session starts signed in: the gateway accepts the kept token.
			// Then the row's answers.
			startedOn := tokenFor(time.Hour, 0)
			w := newWorld(t, startedOn)
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
			var refused string
			switch row.Refused {
			case "held":
				refused = w.token.Value()
			case "replaced":
				refused = tokenFor(time.Hour, -1)
			default:
				t.Fatalf("%s: the gateway refused a token the table calls %q", row.Why, row.Refused)
			}
			given, ok := session.Refresh(context.Background(), refused)
			if row.Given == nil || ok != *row.Given {
				t.Errorf("%s: refresh gave a token: %v, want %v", row.Why, ok, row.Given != nil && *row.Given)
			}
			if ok && given != w.token.Value() {
				t.Errorf("%s: refresh gave a token that is not the session's", row.Why)
			}
			isAsStated(t, row, w, session, 1, startedOn)
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
	session, heard, closed := started(t, testClient(), semiont.SessionConfig{
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
		Timing: semiont.DefaultTiming(),
	})
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
	// What it said by the time it was ready is on its stream already. The
	// forget is held until after this read, so a session that says why only
	// once it has forgotten says it a moment after the read has given up.
	saidByReady := sessionError(heard.next(200 * time.Millisecond))
	close(kept.let)
	<-answered

	if saidByReady == nil || saidByReady.Code != semiont.SessionErrorCodeRefreshExhausted {
		t.Fatalf("by the time it was ready the session had said %v on its errors stream, want %s", saidByReady, semiont.SessionErrorCodeRefreshExhausted)
	}
	if !strings.Contains(saidByReady.Message, "invalid_grant") {
		t.Errorf("the session said %q, not why the issuer refused", saidByReady.Message)
	}
	if token.Value() != "" {
		t.Error("a session that ended still holds a token")
	}
	if more := codes(ownErrors(heard.rest(t, closed))); len(more) != 0 {
		t.Errorf("the session said %v after it said why it ended, want nothing more", more)
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
	session, heard, closed := started(t, testClient(), semiont.SessionConfig{
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
		Timing: semiont.DefaultTiming(),
	})
	select {
	case <-renewing:
	case <-time.After(5 * time.Second):
		t.Fatal("the start never renewed the refused token")
	}

	given, ok := session.Refresh(context.Background(), refused)
	saidByAnswer := sessionError(heard.next(200 * time.Millisecond))
	ready, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatalf("the session was not ready: %v", err)
	}

	if ok || given != "" {
		t.Error("the stream was given a token by a session that ended")
	}
	if saidByAnswer == nil || saidByAnswer.Code != semiont.SessionErrorCodeRefreshExhausted {
		t.Errorf("by the time the stream's refusal was answered the session had said %v on its errors stream, want %s", saidByAnswer, semiont.SessionErrorCodeRefreshExhausted)
	}
	more := ownErrors(heard.rest(t, closed))
	mu.Lock()
	defer mu.Unlock()
	if grants != 1 || len(more) != 0 {
		t.Errorf("two refusals met together cost %d renewals and said %v besides the first failure, want one renewal and nothing more", grants, codes(more))
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
	session, _, _ := started(t, testClient(), semiont.SessionConfig{
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
			said := codes(ownErrors(w.heard.rest(t, w.closed)))
			w.mu.Lock()
			defer w.mu.Unlock()
			if w.token.Value() != "" || len(w.told) != 0 || len(said) != 0 {
				t.Errorf("the session holds a token: %v; told %v and said %v", w.token.Value() != "", w.told, said)
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
			told := slices.Clone(w.told)
			w.mu.Unlock()
			if w.token.Value() != "" || len(told) != 0 {
				t.Errorf("the session holds a token: %v; told %v", w.token.Value() != "", told)
			}
			want := "Token refresh failed: " + row.failure.Error()
			if said := sessionError(w.heard.next(5 * time.Second)); said == nil || said.Code != semiont.SessionErrorCodeAuthFailed || said.Message != want {
				t.Fatalf("the session said %v on its errors stream, want %s: %q", said, semiont.SessionErrorCodeAuthFailed, want)
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
			if more := codes(ownErrors(w.heard.rest(t, w.closed))); len(more) != 0 {
				t.Errorf("the session said %v besides why it started with no token, want nothing more", more)
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
			told := slices.Clone(w.told)
			w.mu.Unlock()
			if w.token.Value() != "" || len(told) != 0 {
				t.Errorf("the session holds a token: %v; told %v", w.token.Value() != "", told)
			}
			want := "Token refresh failed: " + row.failure.Error()
			if said := sessionError(w.heard.next(5 * time.Second)); said == nil || said.Code != semiont.SessionErrorCodeRefreshExhausted || said.Message != want {
				t.Fatalf("the session said %v on its errors stream, want %s: %q", said, semiont.SessionErrorCodeRefreshExhausted, want)
			}
			if given, ok := session.Refresh(context.Background(), ""); !ok || given != renewed {
				t.Errorf("the next refusal was given the renewed token: %v", ok && given == renewed)
			}
			if more := codes(ownErrors(w.heard.rest(t, w.closed))); len(more) != 0 {
				t.Errorf("the session said %v besides why its renewal gave no token, want nothing more", more)
			}
		})
	}
}

// A renewal that got no answer is tried again on the reconnect backoff, each
// wait the equal jitter of a step double the one before up to the longest,
// until one is made; the issuer's refusal ends the attempts; and one made
// while nobody has said who the token is asks the gateway once. On the test's
// own clock.
func TestARenewalThatGotNoAnswerIsTriedAgainOnTheReconnectBackoff(t *testing.T) {
	timing := semiont.DefaultTiming()
	var steps []time.Duration
	for step := timing.Reconnect; len(steps) < 6; step = min(2*step, timing.MaxReconnect) {
		steps = append(steps, step)
	}
	unanswered := fromTheIssuer(t, 0)
	refused := fromTheIssuer(t, http.StatusBadRequest)

	t.Run("until one is made", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			first, renewed := tokenFor(time.Hour, 0), tokenFor(time.Hour, 2)
			w := newWorld(t, first)
			for range steps {
				w.renewals = append(w.renewals, renewal{err: unanswered})
			}
			w.renewals = append(w.renewals, renewal{token: renewed})
			session := w.start(t)
			if _, ok := session.Refresh(context.Background(), first); ok {
				t.Fatal("a renewal that got no answer gave a token")
			}
			var all time.Duration
			for _, step := range steps {
				all += step
			}
			// Past every wait at its longest: the renewal made ends them.
			time.Sleep(all + 30*time.Second)
			synctest.Wait()
			w.mu.Lock()
			renewedAt, handed := slices.Clone(w.renewedAt), slices.Clone(w.handed)
			w.mu.Unlock()
			if len(renewedAt) != len(steps)+1 {
				t.Fatalf("renewed %d times, want %d", len(renewedAt), len(steps)+1)
			}
			// Each is handed the token whose renewal got no answer.
			for n, each := range handed {
				if each != first {
					t.Errorf("renewal #%d was handed %q, want the token the gateway refused", n+1, each)
				}
			}
			for n, step := range steps {
				if gap := renewedAt[n+1].Sub(renewedAt[n]); gap < step/2 || gap > step {
					t.Errorf("waited %v for a step of %v", gap, step)
				}
			}
			if w.token.Value() != renewed {
				t.Error("the renewal made is not the session's token")
			}
			// The renewal made ends the waits, and asks nobody: the gateway
			// said who the token is at the start.
			time.Sleep(4 * timing.MaxReconnect)
			synctest.Wait()
			if asks, renewals := w.counts(); renewals != len(steps)+1 || asks != 1 {
				t.Errorf("then renewed %d times and asked %d, want %d and 1", renewals, asks, len(steps)+1)
			}
		})
	})

	t.Run("until the issuer refuses", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			first := tokenFor(time.Hour, 0)
			w := newWorld(t, first)
			w.renewals = []renewal{{err: unanswered}, {err: refused}}
			session := w.start(t)
			session.Refresh(context.Background(), first)
			// Past the latest its renewal on the backoff falls due, and
			// short of the earliest a second can.
			time.Sleep(timing.Reconnect * 6 / 5)
			synctest.Wait()
			if _, kept, _ := w.kept.Held(context.Background()); kept {
				t.Error("the sign-in the issuer refused is still kept")
			}
			time.Sleep(2 * time.Hour)
			synctest.Wait()
			if _, renewals := w.counts(); renewals != 2 {
				t.Errorf("renewed %d times, want 2", renewals)
			}
		})
	})

	t.Run("asking once who a token is that nobody has said", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			renewed := tokenFor(time.Hour, 2)
			w := newWorld(t, tokenFor(-time.Minute, 0))
			w.renewals = []renewal{{err: unanswered}, {token: renewed}}
			session := w.start(t)
			if asks, _ := w.counts(); asks != 0 || session.User().Value() != nil {
				t.Fatalf("an offline start asked %d times, or says who signed in", asks)
			}
			// Past the latest its renewal on the backoff falls due, and
			// short of the earliest a second can.
			time.Sleep(timing.Reconnect * 6 / 5)
			synctest.Wait()
			if w.token.Value() != renewed {
				t.Fatal("the renewal on the backoff was not made")
			}
			w.mu.Lock()
			answered := w.answered
			w.mu.Unlock()
			if user := session.User().Value(); user == nil || answered == nil || *user.Name != *answered.Name {
				t.Error("the session does not say who the gateway said the renewed token is")
			}
			time.Sleep(4 * timing.MaxReconnect)
			synctest.Wait()
			if asks, renewals := w.counts(); asks != 1 || renewals != 2 {
				t.Errorf("asked %d times and renewed %d, want once and twice", asks, renewals)
			}
		})
	})
}

// A session that never signed in cannot expire: a renewal that gives nothing
// says nothing.
func TestASessionThatNeverSignedInCannotExpire(t *testing.T) {
	w := newWorld(t, "")
	session := w.start(t)
	if _, ok := session.Refresh(context.Background(), ""); ok {
		t.Error("refresh gave a token to a session that holds no sign-in")
	}
	said := codes(ownErrors(w.heard.rest(t, w.closed)))
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.told) != 0 || len(said) != 0 {
		t.Errorf("a session that never signed in told %v and said %v", w.told, said)
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
	session, heard, closed := started(t, testClient(), semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: semiont.NewVariable(""), Kept: kept,
		Refresh: func(context.Context, string) (string, error) { return "", invalidGrant },
		Timing:  semiont.DefaultTiming(),
	})
	ready, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatalf("the session was not ready: %v", err)
	}

	said := ownErrors(heard.rest(t, closed))
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
	session, heard, closed := started(t, testClient(), semiont.SessionConfig{
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
		Timing: semiont.DefaultTiming(),
	})
	<-asking
	session.Close()
	close(release)
	if err := session.Ready(context.Background()); err != nil {
		t.Errorf("a closed session is not ready: %v", err)
	}
	if said := codes(ownErrors(heard.rest(t, closed))); len(said) != 0 {
		t.Errorf("a session closed while it started said %v", said)
	}
}

// A sign-in kept in memory records the person the gateway named as one step,
// only while it holds the token that was asked about and names nobody; a
// renewal keeps the person.
func TestASignInKeptInMemoryRecordsThePersonOfTheTokenAskedAbout(t *testing.T) {
	ctx := context.Background()
	jo, ann := semiont.PersonKey("did:web:example.org:users:jo"), semiont.PersonKey("did:web:example.org:users:ann")
	kept := &semiont.MemorySignIn{}
	if recorded, err := kept.RecordPersonKey(ctx, "a1", jo); err != nil || recorded {
		t.Fatalf("a person recorded on nothing kept: %v, %v", recorded, err)
	}
	read := semiont.HeldSignIn{Access: "a1", Refresh: "r1", ClientID: semiont.ScriptClientID, TokenEndpoint: "https://issuer.test/token"}
	if err := kept.Keep(ctx, read); err != nil {
		t.Fatal(err)
	}
	for _, record := range []struct {
		access, person string
		recorded       bool
	}{{"another token", jo, false}, {"a1", jo, true}, {"a1", jo, true}, {"a1", ann, false}} {
		if recorded, err := kept.RecordPersonKey(ctx, record.access, record.person); err != nil || recorded != record.recorded {
			t.Fatalf("recording %s on the sign-in of %s: %v, %v; want %v", record.person, record.access, recorded, err, record.recorded)
		}
	}
	named, _, _ := kept.Held(ctx)
	if _, ok, err := kept.Renewed(ctx, named, "a2", "r2"); err != nil || !ok {
		t.Fatalf("the renewal: %v, %v", ok, err)
	}
	if held, _, _ := kept.Held(ctx); held.Access != "a2" || held.PersonKey == nil || *held.PersonKey != jo {
		t.Fatalf("held after a renewal: %+v", held)
	}
}

// A session's errors are its one stream of what went wrong: its own failures
// and its transport's, each said once there.
func TestASessionSaysItsOwnFailuresAndItsTransportsOnOneStream(t *testing.T) {
	kept := &semiont.MemorySignIn{}
	if err := kept.Keep(context.Background(), semiont.HeldSignIn{Access: tokenFor(-time.Minute, 0), Refresh: "a-refresh-token", ClientID: "semiont-cli", TokenEndpoint: "https://issuer.test/token"}); err != nil {
		t.Fatal(err)
	}
	unanswered := fromTheIssuer(t, 0)
	client := testClient()
	session, heard, closed := started(t, client, semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: semiont.NewVariable(""), Kept: kept,
		Refresh: func(context.Context, string) (string, error) { return "", unanswered },
		Timing:  semiont.DefaultTiming(),
	})
	ready, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatalf("the session was not ready: %v", err)
	}
	forbidden := &semiont.TransportError{Code: semiont.TransportErrorCodeForbidden, Message: "HTTP 403"}
	client.Transport.Fail(forbidden)
	// Heard before the session is closed: what its transport meets once it
	// has ended is said nowhere.
	var said []error
	for !slices.ContainsFunc(said, func(each error) bool { return each == forbidden }) {
		next := heard.next(5 * time.Second)
		if next == nil {
			t.Fatal("the session never said its transport's refusal on its errors stream")
		}
		said = append(said, next)
	}

	var own []string
	var transports []*semiont.TransportError
	for _, failure := range append(said, heard.rest(t, closed)...) {
		var transport *semiont.TransportError
		switch said := sessionError(failure); {
		case said != nil:
			own = append(own, string(said.Code))
		case errors.As(failure, &transport):
			transports = append(transports, transport)
		}
	}
	if !slices.Equal(own, []string{string(semiont.SessionErrorCodeAuthFailed)}) {
		t.Errorf("the session said %v of its own on its errors stream, want the one %s", own, semiont.SessionErrorCodeAuthFailed)
	}
	if len(transports) != 1 || transports[0] != forbidden {
		t.Errorf("the session said %v of its transport's on its errors stream, want the one refusal", transports)
	}
}

// A session's errors end when the session ends: its client and the client's
// transport, still open, are not waited for. What it said before is given
// first.
func TestASessionEndedAloneEndsItsErrors(t *testing.T) {
	client := testClient()
	session, heard, _ := started(t, client, semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: semiont.NewVariable(""), Kept: &semiont.MemorySignIn{},
		Timing: semiont.DefaultTiming(),
	})
	forbidden := &semiont.TransportError{Code: semiont.TransportErrorCodeForbidden, Message: "HTTP 403"}
	client.Transport.Fail(forbidden)
	if said := heard.next(5 * time.Second); said != forbidden {
		t.Fatalf("the session said %v on its errors stream, want its transport's refusal", said)
	}

	session.Close()
	select {
	case <-heard.ended:
	case <-time.After(10 * time.Second):
		t.Fatal("the session's errors stream did not end when the session was closed, its client and its transport still open")
	}
	if client.Transport.State().Value() == semiont.ConnectionStateClosed {
		t.Error("the session closed its client's transport")
	}
}

// A failure the transport met just before the session is closed is said on
// the session's errors before they end: it is among them before the call
// that met it returns, with no wait between that and the close. On the
// test's own clock.
func TestATransportFailureSaidJustBeforeTheCloseIsSaidBeforeTheErrorsEnd(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client := testClient()
		_, heard, closed := started(t, client, semiont.SessionConfig{
			Kb: api.KbTarget{Id: kb}, Token: semiont.NewVariable(""), Kept: &semiont.MemorySignIn{},
			Timing: semiont.DefaultTiming(),
		})
		forbidden := &semiont.TransportError{Code: semiont.TransportErrorCodeForbidden, Message: "HTTP 403"}
		client.Transport.Fail(forbidden)
		closed()
		synctest.Wait()
		select {
		case <-heard.ended:
		default:
			t.Fatal("the session's errors did not end once the session was closed")
		}
		if said := heard.sofar(); len(said) != 1 || said[0] != forbidden {
			t.Errorf("the session said %v on its errors stream, want its transport's refusal", said)
		}
	})
}

// metInTurn is a session's own errors and its transport's failures, met in
// turn: its own, its transport's, its own, its transport's. Each of its own is
// a renewal that got no answer, met as Refresh answers a refusal of the token
// the session holds, so it is said on the goroutine that called Refresh.
type metInTurn struct {
	failures [2]*semiont.TransportError
	renewals atomic.Int32
}

func newMetInTurn() *metInTurn {
	return &metInTurn{failures: [2]*semiont.TransportError{
		{Code: semiont.TransportErrorCodeUnavailable, Message: "HTTP 503"},
		{Code: semiont.TransportErrorCodeForbidden, Message: "HTTP 403"},
	}}
}

// unanswered is how the issuer fails the nth renewal: with no answer, told
// apart from every other.
func unanswered(n int32) *semiont.SignInError {
	return &semiont.SignInError{Code: semiont.SignInErrorCodeExchange, Message: fmt.Sprintf("renewal %d got no answer", n)}
}

// config is what makes a session whose kept sign-in has not expired and
// whose every renewal gets no answer.
func (m *metInTurn) config(t *testing.T) semiont.SessionConfig {
	kept := &semiont.MemorySignIn{}
	keptUnexpired(t, kept)
	return semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Token: semiont.NewVariable(""), Kept: kept,
		Refresh: func(context.Context, string) (string, error) { return "", unanswered(m.renewals.Add(1)) },
		Timing:  semiont.DefaultTiming(),
	}
}

// meet has session meet them in turn, once it is ready.
func (m *metInTurn) meet(t *testing.T, session *semiont.Session, transport *semionttest.FaultyTransport) {
	t.Helper()
	if err := session.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	session.Refresh(context.Background(), session.Token().Value())
	transport.Fail(m.failures[0])
	// The unanswered renewal left the session holding no token.
	session.Refresh(context.Background(), "")
	transport.Fail(m.failures[1])
}

// inTurn is whether said is what was met, in the order it was met.
func (m *metInTurn) inTurn(said []error) bool {
	unansweredRenewal := func(failure error, n int32) bool {
		own := sessionError(failure)
		return own != nil && own.Code == semiont.SessionErrorCodeRefreshExhausted && strings.HasSuffix(own.Message, unanswered(n).Message)
	}
	return len(said) == 4 && unansweredRenewal(said[0], 1) && said[1] == m.failures[0] && unansweredRenewal(said[2], 2) && said[3] == m.failures[1]
}

// A session's own errors and its transport's failures, met before anyone
// reads, are given to the first reader in the order they were met: each
// failure is said within the transport's telling of it, so the own error the
// session says next cannot overtake it. On the test's own clock.
func TestASessionsOwnErrorsAndItsTransportsFailuresAreSaidInTheOrderTheyWereMet(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		met := newMetInTurn()
		client := testClient()
		config := met.config(t)
		config.Client = client.Client
		session, err := semiont.StartSession(context.Background(), config)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			client.Client.Close()
			session.Close()
			client.Transport.Close()
		})
		met.meet(t, session, client.Transport)

		heard := hear(session)
		synctest.Wait()
		if said := heard.sofar(); !met.inTurn(said) {
			t.Errorf("the session said %v on its errors stream, want an unanswered renewal, its transport's unavailability, another unanswered renewal and its transport's refusal, in that order", said)
		}
	})
}

// A reader already listening hears a session's own errors and its
// transport's failures in the order they were met. On the test's own clock.
func TestASessionsOwnErrorsAndItsTransportsFailuresAreHeardInTheOrderTheyWereMet(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		met := newMetInTurn()
		client := testClient()
		session, heard, _ := started(t, client, met.config(t))
		met.meet(t, session, client.Transport)

		synctest.Wait()
		if said := heard.sofar(); !met.inTurn(said) {
			t.Errorf("the session said %v on its errors stream, want an unanswered renewal, its transport's unavailability, another unanswered renewal and its transport's refusal, in that order", said)
		}
	})
}

// A session nobody has read keeps, of what it says, the latest
// ErrorsKeptForFirstReaderCount for its first reader, the oldest dropped, and
// its first reader hears them in the order they were met.
func TestASessionNobodyHasReadKeepsTheLatestOfWhatItSaysForItsFirstReader(t *testing.T) {
	timing := semiont.DefaultTiming()
	client := testClient()
	session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
		Kb: api.KbTarget{Id: kb}, Client: client.Client, Token: semiont.NewVariable(""), Kept: &semiont.MemorySignIn{}, Timing: timing,
	})
	if err != nil {
		t.Fatal(err)
	}
	closed := sync.OnceFunc(func() {
		client.Client.Close()
		session.Close()
		client.Transport.Close()
	})
	t.Cleanup(closed)
	if err := session.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	beyond := 5
	met := make([]error, timing.ErrorsKeptForFirstReaderCount+beyond)
	for n := range met {
		failure := &semiont.TransportError{Code: semiont.TransportErrorCodeUnavailable, Message: fmt.Sprintf("failure %d", n)}
		met[n] = failure
		client.Transport.Fail(failure)
	}

	if said := hear(session).rest(t, closed); !slices.Equal(said, met[beyond:]) {
		t.Errorf("the first reader heard %d failures, want the latest %d met, in order: %v", len(said), timing.ErrorsKeptForFirstReaderCount, said)
	}
}

// errUnreadable is why a sign-in cannot be read.
var errUnreadable = errors.New("the sign-in cannot be read")

// failsAfter is a kept sign-in that can be read readable times, and whose
// every read after that fails.
type failsAfter struct {
	*semiont.MemorySignIn
	readable int32
	reads    atomic.Int32
}

func (f *failsAfter) Held(ctx context.Context) (semiont.HeldSignIn, bool, error) {
	if f.reads.Add(1) > f.readable {
		return semiont.HeldSignIn{}, false, errUnreadable
	}
	return f.MemorySignIn.Held(ctx)
}

// localTarget is the knowledge base kb, at a gateway nothing in these tests
// asks.
func localTarget(t *testing.T) api.KbTarget {
	t.Helper()
	var at api.KbEndpoint
	if err := at.FromHttpEndpoint(api.HttpEndpoint{Kind: api.HttpEndpointKindHttp, Host: "localhost", Port: 4000, Protocol: api.HttpEndpointProtocolHttp}); err != nil {
		t.Fatal(err)
	}
	return api.KbTarget{Id: kb, Label: kb, Endpoint: at}
}

// A sign-in that cannot be read as a session is made from it is no session:
// SessionFromKept gives its caller why, whether the session keeps what its
// client holds for the person or not.
func TestASignInUnreadableAtTheStartIsGivenToTheCaller(t *testing.T) {
	for _, row := range []struct {
		why     string
		storage semiont.SessionStorage
	}{
		{"keeping nothing", nil},
		{"keeping for the person it names", semiont.NewMemoryStorage()},
	} {
		t.Run(row.why, func(t *testing.T) {
			session, end, err := semiont.SessionFromKept(context.Background(), semiont.SessionFromKeptConfig{
				Kb: localTarget(t), Kept: &failsAfter{MemorySignIn: &semiont.MemorySignIn{}},
				HTTP: &http.Client{}, Timing: semiont.DefaultTiming(), Storage: row.storage,
			})
			if err == nil {
				end()
				t.Fatal("a session was made from a sign-in that cannot be read")
			}
			if !errors.Is(err, errUnreadable) || session != nil {
				t.Errorf("the caller was given %v, and a session: %v; want why the sign-in cannot be read, and no session", err, session != nil)
			}
		})
	}
}

// A sign-in that can be read as the session starts and not when it is
// renewed is a renewal that got no answer: the session keeps the sign-in,
// tells nobody it ended, says why on its errors stream (session.auth-failed
// during its start's renewal, session.refresh-exhausted after it), and renews
// again on the reconnect backoff. The sign-in is read once as the session
// starts; every read after that is a renewal's. On the test's own clock.
func TestASignInUnreadableAtARenewalIsARenewalWithNoAnswer(t *testing.T) {
	timing := semiont.DefaultTiming()
	for _, row := range []struct {
		why string
		// stored is the access token kept.
		stored time.Duration
		// refused is whether a request is refused the session's token once
		// it has started.
		refused bool
		said    semiont.SessionErrorCode
	}{
		{"the start's renewal", -time.Minute, false, semiont.SessionErrorCodeAuthFailed},
		{"a renewal a refusal asks for", time.Hour, true, semiont.SessionErrorCodeRefreshExhausted},
	} {
		t.Run(row.why, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				kept := &failsAfter{MemorySignIn: &semiont.MemorySignIn{}, readable: 1}
				if err := kept.MemorySignIn.Keep(context.Background(), semiont.HeldSignIn{Access: tokenFor(row.stored, 0), Refresh: "a-refresh-token", ClientID: "semiont-cli", TokenEndpoint: "https://issuer.test/token"}); err != nil {
					t.Fatal(err)
				}
				var mu sync.Mutex
				var told []semiont.SessionEndReason
				client := testClient()
				session, err := semiont.ResumeSession(context.Background(), semiont.ResumeConfig{
					Kb: localTarget(t), Client: client.Client, Kept: kept, Token: semiont.NewVariable(""),
					HTTP: &http.Client{}, Timing: timing, SkipAskingWhoTokenIs: true,
					OnAuthFailed: func(reason semiont.SessionEndReason) {
						mu.Lock()
						defer mu.Unlock()
						told = append(told, reason)
					},
				})
				if err != nil {
					client.Client.Close()
					client.Transport.Close()
					t.Fatal(err)
				}
				heard := hear(session)
				t.Cleanup(sync.OnceFunc(func() {
					client.Client.Close()
					session.Close()
					client.Transport.Close()
				}))
				if err := session.Ready(context.Background()); err != nil {
					t.Fatal(err)
				}
				if row.refused {
					session.Refresh(context.Background(), session.Token().Value())
				}
				synctest.Wait()

				if said := codes(ownErrors(heard.sofar())); !slices.Equal(said, []string{string(row.said)}) {
					t.Errorf("the session said %v on its errors stream, want the one %s", said, row.said)
				}
				if session.Token().Value() != "" {
					t.Error("a session whose sign-in could not be read for its renewal holds a token")
				}
				// Past the latest its renewal on the backoff falls due, and
				// short of the earliest a second can.
				readsBefore := kept.reads.Load()
				time.Sleep(timing.Reconnect * 6 / 5)
				synctest.Wait()
				if kept.reads.Load() == readsBefore {
					t.Error("the session did not renew again on the reconnect backoff")
				}
				if _, has, _ := kept.MemorySignIn.Held(context.Background()); !has {
					t.Error("the sign-in was forgotten")
				}
				mu.Lock()
				defer mu.Unlock()
				if len(told) != 0 {
					t.Errorf("the session told %v, as if it had ended", told)
				}
			})
		})
	}
}

// A renewal that gave no token, after which the sign-in cannot be read,
// cannot tell a sign-in that is gone from one that is kept: it is a renewal
// that got no answer, not the session's end. The session keeps the sign-in,
// tells nobody it ended, says session.refresh-exhausted on its errors stream,
// and renews again on the reconnect backoff. On the test's own clock.
func TestARenewalAfterWhichTheSignInCannotBeReadDoesNotEndTheSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		timing := semiont.DefaultTiming()
		kept := &failsAfter{MemorySignIn: &semiont.MemorySignIn{}, readable: 1}
		held := keptUnexpired(t, kept.MemorySignIn)
		var mu sync.Mutex
		renewals := 0
		var told []semiont.SessionEndReason
		session, heard, _ := started(t, testClient(), semiont.SessionConfig{
			Kb: api.KbTarget{Id: kb}, Token: semiont.NewVariable(""), Kept: kept,
			// Nothing to renew with, as far as the renewal can tell.
			Refresh: func(context.Context, string) (string, error) {
				mu.Lock()
				defer mu.Unlock()
				renewals++
				return "", nil
			},
			OnAuthFailed: func(reason semiont.SessionEndReason) {
				mu.Lock()
				defer mu.Unlock()
				told = append(told, reason)
			},
			Timing: timing,
		})
		if err := session.Ready(context.Background()); err != nil {
			t.Fatal(err)
		}
		if session.Token().Value() != held {
			t.Fatal("the session does not hold the kept token")
		}
		session.Refresh(context.Background(), held)
		synctest.Wait()

		if said := codes(ownErrors(heard.sofar())); !slices.Equal(said, []string{string(semiont.SessionErrorCodeRefreshExhausted)}) {
			t.Errorf("the session said %v on its errors stream, want the one %s", said, semiont.SessionErrorCodeRefreshExhausted)
		}
		// Past the latest its renewal on the backoff falls due, and short of
		// the earliest a second can.
		time.Sleep(timing.Reconnect * 6 / 5)
		synctest.Wait()
		if _, has, _ := kept.MemorySignIn.Held(context.Background()); !has {
			t.Error("the sign-in was forgotten")
		}
		mu.Lock()
		defer mu.Unlock()
		if len(told) != 0 {
			t.Errorf("the session told %v, as if it had ended", told)
		}
		if renewals != 2 {
			t.Errorf("renewed %d times, want once and once more on the backoff", renewals)
		}
	})
}
