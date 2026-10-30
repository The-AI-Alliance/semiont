package readme_test

// The README's programs: each Go block packages/go/sdk/README.md shows is one
// file of this package, word for word below its package clause, and each is
// run here. What takes a client runs over semionttest's doubles; what needs a
// gateway or an issuer runs against a stand-in one, on this machine.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/readme"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/state"
)

// goBlock is a Go block of a Markdown text: what is between its fences.
var goBlock = regexp.MustCompile("(?ms)^```go\n(.*?)^```$")

func TestEachGoBlockOfTheREADMEIsAProgramOfThisPackageWordForWord(t *testing.T) {
	shown, err := os.ReadFile("../../README.md")
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	programs := map[string]string{}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") || file == "doc.go" {
			continue
		}
		text, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		program, ok := strings.CutPrefix(string(text), "package readme\n\n")
		if !ok {
			t.Errorf("%s does not begin with its package clause and a blank line", file)
			continue
		}
		programs[file] = program
	}
	blocks := goBlock.FindAllStringSubmatch(string(shown), -1)
	if len(blocks) == 0 {
		t.Fatal("the README shows no Go block")
	}
	seen := map[string]bool{}
	for _, block := range blocks {
		file := ""
		for name, program := range programs {
			if program == block[1] {
				file = name
			}
		}
		if file == "" {
			first, _, _ := strings.Cut(strings.TrimPrefix(block[1], "import ("), "\n\n")
			t.Errorf("a Go block of the README is no program of packages/go/sdk/internal/readme, word for word: the one whose imports are %s", strings.TrimSpace(first))
			continue
		}
		if seen[file] {
			t.Errorf("the README shows %s twice", file)
		}
		seen[file] = true
	}
	for name := range programs {
		if !seen[name] {
			t.Errorf("%s is a program the README does not show", name)
		}
	}
}

// ── Stand-ins ───────────────────────────────────────────────────────────

// signedToken is a JWT an issuer signed for alice, which expires in an hour,
// n telling one from another.
func signedToken(n int) string {
	claims, err := json.Marshal(map[string]any{"iss": "https://kb.example/realms/semiont", "email": "alice@example.org", "exp": time.Now().Add(time.Hour).Unix(), "n": n})
	if err != nil {
		panic(err)
	}
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(claims) + ".c2lnbmF0dXJl"
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

const (
	alice       = `{"did":"did:web:kb.example:users:alice","domain":"kb.example","email":"alice@example.org","name":"Alice","image":null}`
	statusOK    = `{"status":"ok","version":"0.7.0","message":"Semiont is running","features":{"collaboration":"enabled","semanticContent":"enabled"}}`
	aResource   = `{"@context":"https://schema.org","@id":"res-1","name":"A page of notes","representations":[]}`
	markAddedOn = `{"id":"e-1","type":"mark:added","userId":"did:web:kb.example:users:alice","version":1,"timestamp":"2026-10-26T00:00:00.000Z","payload":{}}`
)

// newIssuer is an issuer that grants a service account whose secret is
// s3cret a token, at <origin>/realms/semiont.
func newIssuer(t *testing.T) *httptest.Server {
	t.Helper()
	var issuer *httptest.Server
	issuer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/realms/semiont/.well-known/openid-configuration":
			writeJSON(w, http.StatusOK, fmt.Sprintf(`{"token_endpoint":%q}`, issuer.URL+"/realms/semiont/token"))
		case "/realms/semiont/token":
			if r.FormValue("grant_type") != "client_credentials" || r.FormValue("client_secret") != "s3cret" {
				writeJSON(w, http.StatusUnauthorized, `{"error":"invalid_client"}`)
				return
			}
			writeJSON(w, http.StatusOK, fmt.Sprintf(`{"access_token":%q,"expires_in":3600}`, signedToken(1)))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(issuer.Close)
	return issuer
}

// gateway is a stand-in gateway: it says who a token is and how it is, holds streams, answers a resource's request on the
// newest one, and gives a stream that holds res-1's scope an annotation
// added to it.
type gateway struct {
	*httptest.Server
	mu      sync.Mutex
	streams []chan string
}

func newGateway(t *testing.T) *gateway {
	t.Helper()
	g := &gateway{}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/users/me":
			writeJSON(w, http.StatusOK, alice)
		case "/api/status":
			writeJSON(w, http.StatusOK, statusOK)
		case "/bus/subscribe":
			g.stream(w, r)
		case "/bus/emit":
			var emitted api.BusEmitRequest
			if err := json.NewDecoder(r.Body).Decode(&emitted); err != nil {
				writeJSON(w, http.StatusBadRequest, `{"error":"not an emit"}`)
				return
			}
			if emitted.Channel == string(bus.BrowseResourceRequested.Request().Channel()) && emitted.CorrelationId != nil {
				g.send("", fmt.Sprintf(`{"channel":%q,"correlationId":%q,"payload":{"response":{"resource":%s,"lastSequence":1}}}`,
					bus.BrowseResourceRequested.Result().Channel(), *emitted.CorrelationId, aResource))
			}
			writeJSON(w, http.StatusAccepted, `{"subscribers":1}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(g.Close)
	return g
}

func (g *gateway) stream(w http.ResponseWriter, r *http.Request) {
	var subscription api.BusSubscribeRequest
	if err := json.NewDecoder(r.Body).Decode(&subscription); err != nil {
		writeJSON(w, http.StatusBadRequest, `{"error":"not a subscription"}`)
		return
	}
	sent := make(chan string, 8)
	g.mu.Lock()
	g.streams = append(g.streams, sent)
	g.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	w.(http.Flusher).Flush()
	if subscription.Scoped != nil {
		for _, scoped := range *subscription.Scoped {
			if scoped.Scope.String() == "res-1" {
				sent <- event("p-1", fmt.Sprintf(`{"channel":"mark:added","scope":"res-1","payload":%s}`, markAddedOn))
			}
		}
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-sent:
			_, _ = fmt.Fprint(w, data)
			w.(http.Flusher).Flush()
		}
	}
}

// event is a bus event of the stream, with id when it is not "".
func event(id, data string) string {
	if id == "" {
		return fmt.Sprintf("event: bus-event\ndata: %s\n\n", data)
	}
	return fmt.Sprintf("event: bus-event\nid: %s\ndata: %s\n\n", id, data)
}

// send gives the newest stream a frame.
func (g *gateway) send(id, data string) {
	g.mu.Lock()
	newest := g.streams[len(g.streams)-1]
	g.mu.Unlock()
	newest <- event(id, data)
}

// target is the knowledge base id at g.
func (g *gateway) target(t *testing.T, id string) api.KbTarget {
	t.Helper()
	at, err := url.Parse(g.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(at.Port())
	if err != nil {
		t.Fatal(err)
	}
	var endpoint api.KbEndpoint
	if err := endpoint.FromHttpEndpoint(api.HttpEndpoint{Kind: api.HttpEndpointKindHttp, Protocol: api.HttpEndpointProtocol(at.Scheme), Host: at.Hostname(), Port: port}); err != nil {
		t.Fatal(err)
	}
	return api.KbTarget{Id: id, Label: id, Endpoint: endpoint}
}

func within(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func idOf(t *testing.T, text string) api.ResourceId {
	t.Helper()
	id, err := api.ParseResourceId(text)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// jobTiming is the client's waits, with a followed job asked for its status
// soon after it falls silent.
func jobTiming() semiont.Timing {
	timing := semiont.DefaultTiming()
	timing.JobSilence, timing.JobStatusPoll = 50*time.Millisecond, 50*time.Millisecond
	return timing
}

// testClient is a client over doubles, closed when the test ends.
func testClient(t *testing.T, timing semiont.Timing) semionttest.TestClient {
	t.Helper()
	made := semionttest.NewTestClient(semionttest.TestClientConfig{Timing: timing})
	t.Cleanup(func() {
		made.Client.Close()
		made.Transport.Close()
	})
	return made
}

// completed is a job:status-requested response: the job, of type of, complete with result.
func completed(jobID, of, result string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"jobId":%q,"type":%q,"status":"complete","userId":"did:web:kb.example:users:alice","created":"2026-10-26T00:00:00.000Z","result":%s}`, jobID, of, result))
}

var (
	jobCreate = bus.JobCreate.Request().Channel()
	jobStatus = bus.JobStatusRequested.Request().Channel()
)

// ── The programs ────────────────────────────────────────────────────────

func TestAnAgent(t *testing.T) {
	issuer, kb := newIssuer(t), newGateway(t)
	if err := readme.Work(within(t), kb.URL, issuer.URL+"/realms/semiont", "s3cret"); err != nil {
		t.Fatal(err)
	}
}

func TestAPerson(t *testing.T) {
	kb := newGateway(t)
	home := t.TempDir()
	directory, ok := semiont.StateDir(semiont.ThisSystem(), home, "", "")
	if !ok {
		t.Fatal("this system keeps no sign-ins")
	}
	// What `semiont login` would have kept for the stack.
	kept := semiont.NewSignInStore(filepath.Join(directory, semiont.SignInFile)).Entry("kb-test")
	if err := kept.Keep(context.Background(), semiont.HeldSignIn{Access: signedToken(1), Refresh: "refresh-1", ClientID: semiont.ScriptClientID, TokenEndpoint: kb.URL + "/token"}); err != nil {
		t.Fatal(err)
	}
	if err := readme.AsMe(within(t), kb.target(t, "kb-test"), home); err != nil {
		t.Fatal(err)
	}
}

func TestAFirstProgram(t *testing.T) {
	made := testClient(t, jobTiming())
	made.Transport.QueueReply(jobCreate, json.RawMessage(`{"jobId":"job-1"}`), json.RawMessage(`{"jobId":"job-2"}`))
	made.Transport.QueueReply(jobStatus,
		completed("job-1", "mark", `{"found":3,"persisted":3}`),
		completed("job-2", "yield", `{"resourceId":"res-summary","resourceName":"A summary","truncated":false}`))
	made.Transport.QueueReply(bus.GatherResourceRequested.Request().Channel(), json.RawMessage(
		`{"focus":{"kind":"resource","resource":{"@context":"https://schema.org","@id":"test-content-1","name":"Attention Is All You Need","representations":[]}},"graph":{"nodes":[],"edges":[]},"metadata":{}}`))

	summary, ok, err := readme.Summarize(within(t), made.Client, []byte("%PDF-1.7"))
	if err != nil || !ok || summary.String() != "res-summary" {
		t.Fatalf("the summary is %q (%v, %v)", summary, ok, err)
	}
}

func TestTheClient(t *testing.T) {
	made := testClient(t, jobTiming())
	made.Transport.QueueReply(bus.BrowseResourceRequested.Request().Channel(), json.RawMessage(`{"resource":`+aResource+`}`))
	made.Transport.QueueReply(jobCreate, json.RawMessage(`{"jobId":"job-1"}`))
	made.Transport.QueueReply(jobStatus, completed("job-1", "mark", `{"found":1,"persisted":1}`))
	made.Transport.Counted(2)
	resource := idOf(t, "res-1")
	made.Content.Seed(resource, semiont.Content{Bytes: []byte("Some notes.\n"), ContentType: "text/plain; charset=utf-8"})
	annotation, err := api.ParseAnnotationId("ann-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := readme.Annotate(within(t), made.Client, resource, annotation); err != nil {
		t.Fatal(err)
	}
}

func TestLiveQueries(t *testing.T) {
	made := testClient(t, semiont.DefaultTiming())
	resource := idOf(t, "res-1")
	made.Content.SeedAnnotations(resource, api.GetAnnotationsResponse{Annotations: []api.Annotation{}, Total: 0})
	watching, stop := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer stop()
	readme.Watch(watching, made.Client, resource)
	if !slices.ContainsFunc(made.Content.Calls(), func(call semionttest.ContentCall) bool { return call.Operation == "getAnnotations" }) {
		t.Fatalf("the annotations were never asked for: %v", made.Content.Calls())
	}
	if holds := made.Transport.Holds(resource); holds != 0 {
		t.Fatalf("the watch left %d holds on the resource's scope", holds)
	}
}

func TestStateUnits(t *testing.T) {
	made := testClient(t, semiont.DefaultTiming())
	beckon := state.NewBeckonStateUnit(made.Client, idOf(t, "res-1"))
	done := make(chan struct{})
	go func() {
		defer close(done)
		readme.ShowHover(context.Background(), beckon)
	}()
	annotation, err := api.ParseAnnotationId("ann-1")
	if err != nil {
		t.Fatal(err)
	}
	made.Client.Beckon.Hover(&annotation)
	beckon.Close()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("closing the unit did not end what it handed out")
	}
}

func TestAWorker(t *testing.T) {
	made := testClient(t, semiont.DefaultTiming())
	made.Transport.RefuseWhen(func(operation bus.Channel, _ json.RawMessage) json.RawMessage {
		if operation == bus.JobClaim.Request().Channel() {
			return json.RawMessage(`{"code":"unauthorized","message":"This account cannot claim jobs"}`)
		}
		return nil
	})
	err := readme.Run(within(t), made.Client)
	var refused *semiont.ClaimRefusal
	if !errors.As(err, &refused) || refused.Code == nil || *refused.Code != semiont.BusRequestErrorCodeUnauthorized {
		t.Fatalf("the worker stopped with %v", err)
	}
}

func TestTesting(t *testing.T) {
	readme.ATitleIsItsResourcesNameInCapitals(t)
}

func TestTheBus(t *testing.T) {
	kb := newGateway(t)
	if err := readme.Read(within(t), kb.URL, signedToken(1), idOf(t, "res-1")); err != nil {
		t.Fatal(err)
	}
}

func TestContent(t *testing.T) {
	gateway := &semionttest.StubGateway{}
	var user api.UserResponse
	if err := json.Unmarshal([]byte(alice), &user); err != nil {
		t.Fatal(err)
	}
	gateway.CurrentUser(user)
	gateway.Health(api.HealthResponse{Status: "operational", Message: "Semiont is running", Version: "0.7.0", Timestamp: "2026-10-26T00:00:00.000Z"})
	created, err := readme.Store(within(t), semionttest.NewInMemoryContent(), gateway, []byte("# A page\n"))
	if err != nil || created.IsZero() {
		t.Fatalf("stored as %q (%v)", created, err)
	}
}

func TestIds(t *testing.T) {
	if err := readme.Ids(); err != nil {
		t.Fatal(err)
	}
}
