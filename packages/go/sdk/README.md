# Semiont Go SDK

The Go SDK for [Semiont][semiont], an open platform for building trusted AI
knowledge bases: a shared workspace where humans and AI agents annotate,
connect and govern a corpus of documents.

This module is the client. With it a program reads and writes one knowledge
base: it adds resources, annotates and links them, searches them, gathers
context for a model, and hears what the other participants do as they do it.
A person's application and an AI agent use the same client. The SDK does not
tell them apart.

It has the same namespaces, methods, live queries and state units as the
[TypeScript][sdk-typescript], [Rust][sdk-rust] and [Python][sdk-python] SDKs,
and is held to the same [conformance suite][conformance]: its wire, its live
queries and its worker, case by case. The [`semiont` launcher][launcher] is
built on it. New to Semiont? The [Introduction][introduction] explains the
domain and the ideas the API falls out of. Its code is TypeScript, and the
ideas are this module's too.

## Install

The module is `github.com/The-AI-Alliance/semiont/packages/go/sdk`, package
`semiont`:

```text
import semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
```

It is published nowhere: the import path is its identity. A program in the
monorepo depends on it through a `replace` directive on its relative path, as
the launcher's `go.mod` does:

```text
require github.com/The-AI-Alliance/semiont/packages/go/sdk v0.0.0-00010101000000-000000000000

replace github.com/The-AI-Alliance/semiont/packages/go/sdk => ../../packages/go/sdk
```

It requires the Go toolchain its `go.mod` names. One module holds all of it:
the client, the transport that carries it over HTTP to a knowledge base's
gateway, signing in, the state units (package `state`) and the doubles a test
is built on (package `semionttest`). Its dependencies are `oapi-codegen`'s
runtime, `google/uuid`, OpenTelemetry's API and `golang.org/x/text`.

A client speaks to a running knowledge base. The [Quick Start][quick-start]
sets one up on your own machine.

## Signing in

A transport sends the token it is given. Where the token comes from is one of
three things, and each keeps it renewed: half its lifetime before it expires,
at most five minutes before, and at once when the gateway refuses it.

**An agent** is a service account's token exchanged at the gateway for the
token of the agent `(provider, model)`. It is what a service holds: a
transport, its agent's token, and the channels it awaits replies on. The
gateway answers the exchange with the agent's DID, which is who its work is
attributed to: `agent.DID()`, once it is signed in, as the gateway minted it.

```go
import (
	"context"
	"fmt"
	"net/http"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// Work signs the agent in, and opens a stream as it.
func Work(ctx context.Context, gateway, issuer, secret string) error {
	timing := semiont.DefaultTiming()
	service := semiont.NewServiceToken(
		semiont.Credential{Issuer: issuer, ClientID: "semiont-smelter", ClientSecret: secret},
		semiont.Issuer{HTTP: http.DefaultClient, Timing: timing},
	)
	agent, err := semiont.SignInAgent(ctx, semiont.AgentConfig{
		Gateway: gateway, Provider: "ollama", Model: "gemma2:27b", Service: service, HTTP: http.DefaultClient, Timing: timing,
	})
	if err != nil {
		return err
	}
	defer agent.Close()
	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{
		BaseURL: gateway, Token: agent.Token(), Refresher: agent, Channels: semiont.JobClaimChannels,
		HTTP: http.DefaultClient, Timing: timing,
	})
	defer transport.Close()
	fmt.Println("working as", agent.DID()) // who its work is attributed to, as the gateway named it
	for state := range transport.State().Changes(ctx) {
		if state == semiont.ConnectionStateOpen {
			fmt.Println("its stream is open, as the agent")
			return nil
		}
	}
	return ctx.Err()
}
```

**A person** is signed in at the issuer the knowledge base trusts, and the
sign-in is kept. [`semiont login`][launcher] keeps one for each stack, and a
session here is built over it; a program on a machine with no launcher makes
its own by the device grant, which shows a code to approve in any browser. No
password passes through this process. A session is given the knowledge base's
target (`api.KbTarget`: its id, its label and its endpoint), as the other
SDKs' are, and reaches the gateway its HTTP endpoint names.

```go
import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

func show(code semiont.DeviceCode) {
	fmt.Printf("Open %s and enter %s\n", code.VerificationURI, code.UserCode)
}

// AsMe is a session as the person signed in to kb, by `semiont login` or by
// the device grant here.
func AsMe(ctx context.Context, kb api.KbTarget, home string) error {
	directory, ok := semiont.StateDir(semiont.ThisSystem(), home, "", "")
	if !ok {
		return errors.New("this system keeps no sign-ins")
	}
	// The sign-in of the stack `semiont login` keys as the knowledge base's id.
	kept := semiont.NewSignInStore(filepath.Join(directory, semiont.SignInFile)).Entry(kb.Id)
	timing := semiont.DefaultTiming()
	if _, held, err := kept.Held(ctx); err != nil {
		return err
	} else if !held {
		endpoint, err := kb.Endpoint.AsHttpEndpoint()
		if err != nil {
			return err
		}
		gateway, err := semiont.GatewayURL(endpoint)
		if err != nil {
			return err
		}
		issuer := semiont.Issuer{HTTP: http.DefaultClient, Timing: timing}
		if _, err := semiont.SignInWithDevice(ctx, issuer, gateway, kept, show); err != nil {
			return err
		}
	}
	session, end, err := semiont.SessionFromKept(ctx, semiont.SessionFromKeptConfig{
		Kb: kb, Kept: kept, HTTP: http.DefaultClient, Timing: timing, AskWhoTokenIs: true, Channels: bus.BridgedChannels,
	})
	if err != nil {
		return err
	}
	defer end() // the session, then its client and its transport
	status, err := session.Client().System.Status(ctx)
	if err != nil {
		return err
	}
	if me := session.User().Value(); me != nil {
		fmt.Println(me.Email, status.Version)
	}
	return nil
}
```

- **`SessionFromKept`** makes the transport, the client and the session
  together, ready, and returns what ends all three. `ResumeSession` is the
  session alone, over a client its caller made: the launcher makes its own,
  with the channels a command follows.
- **An agent whose renewal fails keeps the token it has** and tries again: a
  process holding a token that still works does not stop over one bad round
  trip. Signing in is the one step that fails.
- **A person's session ends once, and says why.** A token the issuer will not
  renew ends it as `expired`, and a token the issuer has just issued and the
  gateway refuses ends it as `refused` (`OnAuthFailed`). The sign-in is then
  forgotten, so a dead credential is never sent again. What a session does at
  its start and when it is refused is
  [`specs/src/session/cases.json`][session-cases], row for row.
- **A renewal spends its refresh token once.** Renewals asked for together are
  one request of the issuer.
- **The store is the launcher's** ([`specs/src/sign-in-store`][sign-in-store]):
  the same file and the same lock, on macOS, Linux and Windows. A sign-in made
  here serves the launcher's verbs, and one it renewed serves this session.
  `MemorySignIn` keeps one for the life of the process instead, and `SignOut`
  revokes one at its issuer and forgets it.
- **`SEMIONT_BUS_LOG` is the only environment variable the SDK reads**
  ([Telemetry](#telemetry)). Everything else it needs, it is given: an
  application reads its own environment (`HOME`, a secret, an address) and
  says what it found.

## Eight verbs

Every operation belongs to one of eight flows: verbs for what a participant
does with a shared corpus. Four write, three read, and one directs
attention. Each is a namespace of the client, a field of `*semiont.Client`.

| | Verb | What it does | Among its methods |
|---|---|---|---|
| Writing | `Yield` | Introduce a resource, uploaded or generated from gathered context | `Yield.Resource`, `Yield.Delegate` |
| | `Mark` | Annotate a resource | `Mark.Annotation`, `Mark.Delegate`, `Mark.UpdateEntityTypes`, `Mark.Archive` |
| | `Bind` | Resolve an ambiguous reference to a specific resource | `Bind.Body`, `Bind.Initiate` |
| | `Frame` | Define and grow the schema vocabulary | `Frame.AddEntityTypes`, `Frame.AddTagSchema` |
| Reading | `Browse` | Navigate, read and observe, including who is here | `Browse.Resource`, `Browse.Annotations`, `Browse.Agents`, `Browse.Click` |
| | `Match` | Search the corpus: resources by text, and candidates for a reference | `Match.Resources`, `Match.Search` |
| | `Gather` | Assemble grounding context around a resource or an annotation, and list what refers to a resource | `Gather.Resource`, `Gather.Annotation`, `Gather.ReferencedBy` |
| Attention | `Beckon` | Direct attention across participants | `Beckon.Hover`, `Beckon.Sparkle`, `Beckon.OpenResource` |

Beside the eight are `Job`, `Auth` and `System`. What each flow means is in
[docs/protocol/flows][flows].

## A first program

From a signed-in client, this ingests a paper, has a model mark the concepts
it mentions, gathers the context around it, and generates a summary grounded
in that context. Those are the [Quick Start][quick-start]'s last two steps,
from code, and the two that come next. [Signing in](#signing-in) is how a
client comes to be signed in.

```go
import (
	"context"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// Summarize ingests a paper, has a model mark the concepts it mentions,
// gathers the context around it, and generates a summary grounded in it. ok
// is false when the job declined, and made nothing.
func Summarize(ctx context.Context, client *semiont.Client, paper []byte) (summary api.ResourceId, ok bool, err error) {
	// Ingest: the paper's bytes become a resource.
	created, err := client.Yield.Resource(ctx, semiont.PutBinaryRequest{
		Name:       "Attention Is All You Need",
		Bytes:      paper,
		Format:     "application/pdf",
		StorageURI: "file://papers/attention-is-all-you-need.pdf",
	}).Wait(ctx)
	if err != nil {
		return api.ResourceId{}, false, err
	}
	paperID := created.ResourceId

	// Annotate: a model reads it and marks each mention of a concept.
	var linking api.MarkJobParams
	if err := linking.FromLinkingJobParams(api.LinkingJobParams{Motivation: api.LinkingJobParamsMotivationLinking, EntityTypes: []string{"Concept"}}); err != nil {
		return api.ResourceId{}, false, err
	}
	if _, err := client.Mark.Delegate(paperID, linking).Wait(ctx); err != nil {
		return api.ResourceId{}, false, err
	}

	// Gather: the paper, its annotations, and what the knowledge base holds around it.
	gathered, err := client.Gather.Resource(ctx, paperID, api.GatherResourceRequestOptions{})
	if err != nil {
		return api.ResourceId{}, false, err
	}

	// Generate: a new resource, grounded in that context and linked to its source.
	task := "summary"
	done, err := client.Yield.Delegate(api.GenerationJobParams{
		Title:      "Attention Is All You Need: a summary",
		StorageUri: "file://generated/attention-summary.md",
		Context:    gathered,
		Task:       &task,
	}, 0).Wait(ctx)
	if err != nil {
		return api.ResourceId{}, false, err
	}
	// What a yield job reports is the resource it made. One that could not read what it was given declines, and makes nothing.
	if done.Result == nil {
		return api.ResourceId{}, false, nil
	}
	if declined, err := done.Result.AsJobDeclined(); err == nil && declined.Declined == api.JobDeclinedDeclinedTrue {
		return api.ResourceId{}, false, nil
	}
	made, err := done.Result.AsYieldJobDone()
	return made.ResourceId, err == nil, err
}
```

Both resources, and every annotation the model made, are in the knowledge base
for the next participant, person or agent, to read and build on.

Where to go from here:

- The [Developer Guide][developer-guide] has each of these steps as a recipe,
  and the ones after them: reading, searching, annotating by hand, reacting to
  what others do, and testing. Its code is TypeScript, and the calls are this
  module's too.
- The [agent skills][skills] are whole scripts, one per task, for an AI coding
  assistant to load. They are TypeScript as well.

## The client

A client is eleven namespaces over one transport: the
[eight verbs](#eight-verbs), one per [flow of the protocol][protocol], and
`Job`, `Auth` and `System` beside them. Each method is a row of
[`specs/src/client/surface.json`][surface], the table every Semiont SDK is
held to.

```go
import (
	"context"
	"fmt"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// Annotate reads a resource, has it highlighted, and directs attention to
// one of its annotations.
func Annotate(ctx context.Context, client *semiont.Client, resource api.ResourceId, annotation api.AnnotationId) error {
	described, err := client.Browse.Resource(resource).Fresh(ctx) // a query, read once
	if err != nil {
		return err
	}
	text, err := client.Browse.ResourceContent(ctx, resource) // asked once, answered once
	if err != nil {
		return err
	}
	fmt.Println(described.Name, len(text))

	var highlighting api.MarkJobParams
	if err := highlighting.FromHighlightingJobParams(api.HighlightingJobParams{Motivation: api.HighlightingJobParamsMotivationHighlighting}); err != nil {
		return err
	}
	for event, err := range client.Mark.Delegate(resource, highlighting).Events(ctx) { // a job, followed
		if err != nil {
			return err
		}
		switch event := event.(type) {
		case semiont.JobCreated:
			fmt.Println("to cancel it:", event.Data.JobId) // what client.Job.Cancel names
		case semiont.JobProgressed:
			fmt.Println(event.Data.Percentage)
		case semiont.JobAttemptFailed:
			fmt.Println("trying again after:", event.Data.Error)
		case semiont.JobCompleted[api.MarkJobCompleteCommand]:
			fmt.Println(event.Data.Result)
		}
	}

	reached, counted, err := client.Beckon.Attention(ctx, resource, annotation) // a drive: how many the gateway reached
	if err != nil {
		return err
	}
	client.Browse.Click(annotation) // a signal: this viewer's own, never sent
	fmt.Println(reached, counted)
	return nil
}
```

Every method returns one of nine shapes, and the table says which:

| Shape | In Go | |
|---|---|---|
| asked once, answered once | `(T, error)`, given a context | the failure is the error |
| a long-running operation | `*Running[T]` | `Wait(ctx)` for its final value, or `Events(ctx)` for every report and then the final value; one or the other, once |
| a job another party does | `*Delegation[C]` | `Wait(ctx)` for the job's completion, or `Events(ctx)` for every event of the job, its completion the last; one or the other, once |
| an upload | `*Upload` | `Progress()` for how much has been sent, `Wait(ctx)` for the resource it created |
| a query | `*Cached[T]` | building it sends nothing; `Fresh(ctx)` reads it once, and `States(ctx)` watches it |
| a worker's claims | `*Claims` | `All()`: each job the worker comes to hold, or a claim it was refused; a held job says its own lifecycle and commits its own annotations, and `Complete`, `Fail` and `Cancel` each settle it once |
| a signal | no result | published on the client's own bus, or sent and not awaited |
| a drive | `(subscribers int, counted bool, err error)` | how many participants the gateway reached; `counted` is false when it kept no count |
| a channel's events | `iter.Seq2[Delivered[P], error]`, given a context | each event's payload decoded, until the context is done |

- **A delegated job** (`Mark.Delegate`, `Yield.Delegate`) is described by
  its parameters, which are the protocol's own shapes: `api.MarkJobParams`,
  one of `HighlightingJobParams`, `CommentingJobParams`,
  `AssessingJobParams`, `LinkingJobParams` and `TaggingJobParams`; and
  `api.GenerationJobParams` for a `yield` job. Waited for, the job gives its
  verb's completion: an `api.MarkJobCompleteCommand`, whose `Result` is the
  job's counts (`MarkJobDone`) or a decline (`JobDeclined`), or an
  `api.YieldJobCompleteCommand`, whose `Result` is the resource the job made
  (`YieldJobDone`) or a decline. Ranged over, its events are `JobCreated`,
  `JobProgressed`, `JobAttemptFailed` and `JobCompleted[C]`, read with a type
  switch. A job that says nothing is asked for its status, so a completion
  the stream did not carry is still heard. It ends as a `*JobError` when the
  job failed for good, was cancelled, or (a generation) said nothing for
  longer than its stall deadline allows; and as a `*TransportError` when what
  completed is not a job of the verb that was delegated.
- **`client.Bus`** is the client's own bus: every frame its transport
  delivered, and every signal its own parts gave each other.
  **`client.Wire`** is the bus over the transport, typed by channel.
- **A client is made over three things** (`semiont.NewClient`, with a
  `ClientConfig`): a transport, a content transport and the gateway's own
  operations. Over HTTP all three are one `*HTTPTransport`, its content being
  `semiont.NewHTTPContentTransport(transport)`. `Close` ends what the client
  started. It does not close its transport: whoever opened that closes it,
  after the client. A session holds one as `session.Client()`.
- **What it sends unasked is the table's**: a list's first hundred, a
  search's ten candidates, a context's two thousand characters. An option
  left at its zero value is an option not given, and is not sent.

Why the shapes are these, in every SDK, is
[the reactive model][reactive-model].

## Live queries

A query is one of ten reads
([`specs/src/client/refresh.json`][refresh] names them) that answer from the
client's cache. Read once, it asks the knowledge base now. Watched, it is its
state now, and each state after it, until the context is done or the client
closes.

```go
import (
	"context"
	"fmt"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// Watch shows a resource's annotations as they change, until ctx is done.
func Watch(ctx context.Context, client *semiont.Client, resource api.ResourceId) {
	for state := range client.Browse.Annotations(resource).States(ctx) { // holds the resource's scope
		switch state := state.(type) {
		case semiont.Pending:
			fmt.Println("asking")
		case semiont.Ready[[]api.Annotation]:
			fmt.Println(len(state.Value), "annotations")
		case semiont.Failed: // a state, not the end: the query lives on
			fmt.Println("failed:", state.Err)
		}
	}
}
```

- **A state is one of three**: `Pending`, `Ready[T]` or `Failed`. `Failed` is
  the state of a query with no value whose request failed and failed again.
  It is not the end: the next watcher, an event or `Invalidate` asks again,
  and every watcher is shown what comes.
- **Watching is what asks.** The first watcher of a query starts its request,
  and watchers that arrive together share it. A later one is given what is
  held. A request that fails is made once more; a query that has a value
  keeps showing it whatever its refetches do.
- **A watched query stays true.** While a query of one resource is watched,
  the client holds that resource's scope, so its events reach the client; and
  each event asks again for exactly the queries the refresh table gives it,
  writes the value an event carries, or ends an annotation that is gone. What
  events ask of one query inside a window is one request. A stream that
  dropped and returned asks again for what its events could not replay.
- **A read** (`Fresh(ctx)`) asks now, gives the failure it meets, and gives
  every watcher of the query its answer.
- **A watcher that falls behind** is given the latest state, not each one it
  missed: a state is what is true now.
- **A client can keep what its small queries hold**
  (`ClientConfig.Persistence`, a `CachePersistence` over a `SessionStorage`
  the application supplies): a resource's description, its annotations, one
  annotation, the entity types, the tag schemas. The next client over the
  same storage shows them at once and asks for each anew the first time it is
  watched. `SessionFromKeptConfig.Storage` does this for a session, and keeps
  the stream's place in each resource's scope with it (`CoupledBookmarks`),
  so the next session is sent what was recorded since.

The behaviours every SDK's live queries are held to are numbered in
[the cache's semantics][cache-semantics].

## State units

A state unit holds one flow as state, for an application to read and watch:
a terminal, a daemon and an agent read one alike. It is built over a client it
never closes, and it hears the client's own bus from the moment it exists.
Each thing it holds is a `semiont.Watched[T]`: `Value()` is its value now, and
`Changes(ctx)` gives that value and then each change, until the unit ends. A
new session has a new client, so a unit lasts as long as the session it was
built from. `Close()` ends a unit: what it had running has stopped, and every
`Changes` it handed out ends.

| Unit | holds | hears, or is told |
|---|---|---|
| `state.MarkStateUnit` (one resource) | the annotation being composed; the motivation, id and progress of the delegated job running, the motivation that progress is of, and why the last job ended without completing | `client.Mark.Request`, `Submit`, which name its resource; `RequestDelegate`, `CancelPending`, `DismissProgress` |
| `state.GatherStateUnit` (one resource) | an annotation's context, and a resource's, each with its loading and its failure | `GatherAnnotation`, `GatherResource` |
| `state.MatchStateUnit` | nothing: it answers on the bus, under the asker's correlation id | `client.Match.RequestSearch` |
| `state.YieldStateUnit` | whether a generation runs, its job's id, its progress, what it produced, and why it ended without a result | `Generate`, `DismissProgress` |
| `state.BeckonStateUnit` (one resource) | the annotation hovered | `client.Beckon.Hover`; an annotation opened, here or by another participant; `Focus` |
| `state.HoverDwell` | nothing: it says an annotation is hovered once the pointer has rested on it for a delay, and none the moment the pointer leaves | `Enter`, `Leave` |
| `state.SearchPipeline[T]` | a query and the results of the query it settled on | `SetQuery` |
| `semiont.SessionSignals` | that the session ended, that a request was refused for lack of permission, that another knowledge base answers at a registered address | `Notify…`, `Acknowledge…` |

`semiont.Session` and `semiont.Cache` are state units too: a session's token,
who is signed in and its stream's state; and the values a client's queries
answer from.

This shows what is hovered as it changes:

```go
import (
	"context"
	"fmt"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/state"
)

// ShowHover shows what is hovered as it changes.
func ShowHover(ctx context.Context, beckon *state.BeckonStateUnit) {
	// What it holds now, then each change, until the unit is closed.
	for hovered := range beckon.HoveredAnnotationId().Changes(ctx) {
		if hovered.IsZero() {
			fmt.Println("nothing hovered")
		} else {
			fmt.Println("hovering", hovered)
		}
	}
}
```

What every SDK's units do is one table,
[`specs/src/client/state-units.json`][state-units-cases], which this
module's tests run. The ideas behind them are in [State Units][state-units].

## A worker

A worker claims jobs from a knowledge base's queue, does each one, and says
what became of it. `client.Job.Claim` is its side of the queue. It is given
what the worker accepts, each an `api.JobFilter`: the `mark` jobs of one
motivation, or the `yield` jobs. What it returns hands out the jobs the worker
comes to hold, one at a time, and a held job says its own lifecycle.

```go
import (
	"context"
	"errors"
	"fmt"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// Count is your work: read the resource, and say how many lines it has. A
// worker that annotates builds each api.Annotation it finds and commits them
// with job.Commit before it completes.
func Count(ctx context.Context, client *semiont.Client, job *semiont.HeldMarkJob) (api.MarkJobResult, error) {
	var result api.MarkJobResult
	text, err := client.Browse.ResourceContent(ctx, job.ResourceId())
	if err != nil {
		return result, err
	}
	if err := job.Progress(ctx, api.JobProgress{Percentage: 50}); err != nil {
		return result, err
	}
	err = result.FromMarkJobDone(api.MarkJobDone{Found: strings.Count(text, "\n"), Persisted: 0})
	return result, err
}

// Run claims the highlighting jobs of the knowledge base client reaches, one
// at a time, until ctx is done or the credential can never claim.
func Run(ctx context.Context, client *semiont.Client) error {
	var highlights api.MarkJobFilter
	highlights.JobType = api.MarkJobFilterJobTypeMark
	highlights.Params.Motivation = api.MotivationHighlighting
	var accepts api.JobFilter
	if err := accepts.FromMarkJobFilter(highlights); err != nil {
		return err
	}
	// Closing the claims stops the worker: a job it still holds is failed first, and the queue retries it.
	claims := client.Job.Claim([]api.JobFilter{accepts})
	defer claims.Close()
	stop := context.AfterFunc(ctx, claims.Close)
	defer stop()
	deterministic := api.FailureClassDeterministic
	// Each job the worker comes to hold, one at a time. The next is claimed when this one settles.
	for held, err := range claims.All() {
		var refused *semiont.ClaimRefusal
		if errors.As(err, &refused) && refused.Code != nil && *refused.Code == semiont.BusRequestErrorCodeUnauthorized {
			// This credential can never claim. Stop, so that whoever runs the worker sees it.
			return refused
		}
		if err != nil {
			fmt.Println("claim refused:", err)
			continue
		}
		switch job := held.(type) {
		case *semiont.HeldYieldJob:
			if err := job.Fail(ctx, "this worker runs no yield job", semiont.JobFailure{FailureClass: &deterministic}); err != nil {
				return err
			}
		case *semiont.HeldMarkJob:
			if err := job.Start(ctx); err != nil {
				return err
			}
			result, err := Count(ctx, client, job)
			if err != nil {
				err = job.Fail(ctx, err.Error(), semiont.JobFailure{})
			} else {
				err = job.Complete(ctx, result)
			}
			if err != nil {
				return err
			}
		}
	}
	return ctx.Err()
}
```

- **A worker is an agent.** Its process signs in with a service account
  ([Signing in](#signing-in)), and the gateway gives it the agent its work is
  attributed to. The account needs two roles at the issuer:
  `semiont-service`, to be given an agent, and `semiont-worker`, without
  which every claim is refused as `bus.unauthorized`.
- **Its stream names `semiont.JobClaimChannels`**, and the reply channels of
  whatever else it awaits. The announcements that wake an idle worker reach
  only a stream that names them, so claims over a transport whose stream does
  not are refused at once, as `bus.unsubscribed`.
- **A held job commits for itself**: `job.Commit(ctx, resourceID, annotations)`
  sends the batch as `mark:commit`, citing the job, and returns once the
  record has it. A worker that commits names `semiont.JobCommitChannels` in
  its stream as well.
- **It claims when it is idle**: when its stream opens, each time a job
  settles, when a job it accepts is announced, and when its stream opens
  again. A claim answered with nothing pending is no refusal, and the worker
  waits. A `*ClaimRefusal` is a claim the dispatcher refused or did not
  answer.
- **A held job settles once**: `Complete`, with what its verb reports,
  `Fail`, or `Cancel`. Each says the outcome and lets the job go, and a second
  is refused. `Start` comes first, and `Progress` and `Checkpoint` as often as
  there is something to say. A held job is a `*HeldMarkJob` or a
  `*HeldYieldJob`, read with a type switch, since a completion is its verb's.
- **A job is never left.** Closing the claims stops the worker, which fails
  the job it still holds, and the queue runs it again at once. Closing the
  client closes its claims.
- **`Fail` says whether the queue will run the job again**, from the budget on
  the record the worker claimed and the failure's class:
  `api.FailureClassDeterministic` is a failure no second attempt can change,
  and `api.FailureClassWithheld` an answer the model's provider withheld. The
  queue retries neither.
- **A cancellation is signalled.** `job.Cancelled()` becomes true when a
  cancellation names the held job: the work stops where it can, and says
  `job.Cancel`.
- **Each job has a trace of its own.** `job.Trace()` is the trace its reply
  arrived in, and `semiont.Continuing(ctx, job.Trace())` is a context whose
  spans continue it.
- **`claims.Vitals()`** is what the worker can say of itself: when it last
  heard an announcement, claimed, was active and settled, the job it holds,
  and how many it has completed. **`claims.Stalled()`** tells of a held job
  that has shown no activity for fifteen minutes.

What a worker promises the dispatcher is [the worker contract][worker-contract],
and [its conformance suite][worker-conformance] holds this module to it.

## Annotations

Package `annotations` is what reads an annotation and what builds one, as
every SDK reads and builds them, case for case
([`specs/src/annotations`](../../../specs/src/annotations)).

- **The readers** take an `api.Annotation` apart: what kind it is
  (`IsHighlight`, `IsComment`, `IsTag`, `IsReference`, `IsAssessment`), the
  resource it is on (`TargetSource`) and where in it (`TargetSelector`,
  `TextQuoteSelector`), the text it covers (`AnnotationExactText`), what a
  reference points at and whether it is resolved yet (`BodySource`,
  `IsStubReference`, `IsResolvedReference`), and what a comment, a tag or a
  linking job said (`CommentText`, `TagCategory`, `TagSchemaId`,
  `EntityTypes`).
- **`Reconcile`** finds where a model's quoted words are in the text: exactly,
  then with the text's white space and quotation marks made plain, then case
  aside, then by the nearest stretch. It says how it found them
  (`AnchorMethod`) and how closely they match (`MatchQuality`), and finds
  nothing rather than a guess.
- **`AnnotationOfSpan`** builds the annotation of a span of text, its
  offsets counted in code points: a position selector and a quote selector,
  and, for a span of a PDF, the fragment selectors of the pages and
  rectangles it covers. A span that is not the text's is refused with
  `SpanRefusedError`, whose code says why. **`AnnotationOfResource`** builds
  one of a whole resource. Each makes the annotation's id from what it is, so
  the same annotation built twice is one annotation.

## Several knowledge bases

Package `registry` is what an application a person uses holds beside its
knowledge bases: the list it has registered, which one is active and that
one's session, and what the person has open in each. It keeps all of it in a
`SessionStorage`, under the keys every SDK's registry uses, so a registry
made again over the same storage picks up where the last one was.

- **One session is live at a time.** `SetActiveKb` closes the active one's
  session and brings up the next: its readers see no session, then the new
  one. `SessionActivating` says a session is on its way. A session is built by
  the `SessionFactory` the registry is given; `HttpSessionFactory` builds one
  over a knowledge base's gateway, renewing its token at the issuer its stored
  sign-in names, and keeping its caches in the registry's storage.
- **A sign-in lands on the knowledge base that answered.** `BeginSignIn`
  remembers a pending sign-in and gives the address to send the person to;
  `CompleteSignIn`, given the address the issuer sent them back to, exchanges
  the code, asks the knowledge base who it is, and registers it under what it
  says. Its did is what an entry is matched by, never the address a person
  typed or the row they clicked; what they believed is said back
  (`SignInOutcome.Expected`) for the application to set against it. The grant
  itself is the root package's: `BeginAuthorization` and
  `CompleteAuthorization`, the authorization-code grant with PKCE, and
  `DescribeConnection`, the question a completed sign-in asks.
- **What a session's arrival checks.** When a session comes up, the
  knowledge base is asked who it is, and each open resource is checked
  against it. A different knowledge base answering voids what was open and
  raises `KbIdentityConflict` on the session's signals; a resource the
  knowledge base says is gone is closed; no answer changes nothing. A request
  the gateway refuses for want of a valid token renews the session, and one
  refused for lack of permission raises `PermissionDenied`.

Package `discovery` reads the document a launcher publishes of the knowledge
bases it manages: whole or not at all, a launcher that is not there told from
one that manages nothing, and what changed since it was last read
(`SubscribeDiscovery`). It is a registry's list of what can be signed in to.

## Testing what is built on it

Package `semionttest` gives a real client over doubles. Its namespaces, its
cache and its deadlines are the client's own; only what it speaks through is
scripted. A test says what the knowledge base answers, runs the code under
test, and reads what that code asked.

```go
import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// TitleOf is the code under test: a resource's name, in capitals.
func TitleOf(ctx context.Context, client *semiont.Client, resource api.ResourceId) (string, error) {
	described, err := client.Browse.Resource(resource).Fresh(ctx)
	return strings.ToUpper(described.Name), err
}

// ATitleIsItsResourcesNameInCapitals is the test of it.
func ATitleIsItsResourcesNameInCapitals(t *testing.T) {
	made := semionttest.NewTestClient(semionttest.TestClientConfig{Timing: semiont.DefaultTiming()})
	defer made.Transport.Close()
	defer made.Client.Close()
	asked := bus.BrowseResourceRequested.Request().Channel()
	made.Transport.QueueReply(asked, json.RawMessage(`{"resource":{"@context":"https://schema.org","@id":"res-1","name":"a page of notes","representations":[]}}`))

	resource, err := api.ParseResourceId("res-1")
	if err != nil {
		t.Fatal(err)
	}
	if title, err := TitleOf(context.Background(), made.Client, resource); err != nil || title != "A PAGE OF NOTES" {
		t.Fatalf("the title is %q (%v)", title, err)
	}

	// What the code under test asked of the knowledge base, as it was sent.
	sent := made.Transport.RequestLog()
	if !slices.EqualFunc(sent, []string{`{"resourceId":"res-1"}`}, func(entry semionttest.RequestLogEntry, payload string) bool {
		return entry.Channel == asked && string(entry.Payload) == payload
	}) {
		t.Fatalf("asked %v", sent)
	}
}
```

- **`FaultyTransport`** is a transport with no wire. `QueueReply` says what
  the gateway answers the next requests of an operation with, and
  `RefuseWhen` has it answer with a failure. A reply that names what it
  answers for, as a gathered context names its resource, takes that from the
  request, so a test queues the response alone. A schedule of `Deliver`,
  `DropReply`, `Delay`, `DuplicateReply` and `RejectEmit` says what the wire
  does to each request in turn, so a lost reply and the retry after it can be
  scripted. `RequestLog` and `Emitted` are what was sent; `Deliver` carries a
  frame in as the bus would; `SetState` drops the stream and brings it back.
- **`InMemoryContent`** keeps what is uploaded and what a test seeds, and
  **`StubGateway`** answers the gateway's own operations as a test scripted
  them. Each records the calls made of it.
- **A double refuses what nobody scripted, by name.** A request with no
  answer scripted fails naming its operation, and a read of content nobody
  stored fails naming the resource. None answers with a value of its own
  making, so a test that forgot to say something fails where it forgot.
- **Every double works inside a `testing/synctest` bubble**: a test can let
  what is ready run (`synctest.Wait`) and move the clock (`time.Sleep`).
- **`AssertStateUnitAxioms`** holds a state unit to what every unit promises.
- **`NewTestSession`** is a real `semiont.Session` over a test client, ready
  at once, holding a token only if its sign-in held one.
- **`ScriptedSessions`** is a `registry.SessionFactory` of real sessions over
  scripted transports, one a knowledge base, for a test of a registry: a test
  says what each knowledge base answers, who a token is and what a renewal
  gives. **`SharedStorage`** is a storage several contexts share, each hearing
  what the others write, as two windows do.
- **`AssertLivenessAxioms`** holds a composition to the liveness axioms over
  fault schedules (`FaultSchedules`): every output says something, and every
  awaited path settles, within a bound. **`AssertExactlyOnceDelivery`** holds
  anything shaped like a connection to delivering each event exactly once,
  wherever a transition lands among the writes.

## The bus

Under the namespaces is the bus, and a program can speak on it directly.

```go
import (
	"context"
	"errors"
	"fmt"
	"net/http"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// Read asks for a resource on the bus, then hears what is added to it.
func Read(ctx context.Context, origin, token string, resource api.ResourceId) error {
	timing := semiont.DefaultTiming()
	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{
		BaseURL: origin, Token: semiont.NewVariable(token), Channels: bus.BridgedChannels, HTTP: http.DefaultClient, Timing: timing,
	})
	defer transport.Close()
	wire := semiont.NewWire(transport)

	reply, err := semiont.Request(ctx, wire, bus.BrowseResourceRequested, api.BrowseResourceRequest{ResourceId: resource}, timing.BusRequestTimeout)
	var refused *semiont.BusRequestError
	if errors.As(err, &refused) {
		fmt.Println(refused.Code) // "bus.not-found", "bus.timeout", …: a closed vocabulary
		return nil
	}
	if err != nil {
		return err
	}
	fmt.Println(reply.Response.Resource.Name)

	// A resource's channel is read for the resource: the read holds its scope, and lets go when the loop stops or ctx is done.
	added, err := semiont.FramesOf(ctx, wire, bus.MarkAdded, resource)
	if err != nil {
		return err
	}
	for frame, err := range added {
		if err != nil {
			return err
		}
		fmt.Println(frame.Scope, frame.Payload.Type)
		return nil
	}
	return ctx.Err()
}
```

- **The bus is typed by channel.** A channel of package `bus` is a value that
  carries its payload's type: `semiont.Emit`, `semiont.Frames`,
  `semiont.FramesOf` and `semiont.Request` refuse another channel's payload,
  and a request's reply is its operation's result. By name, with JSON
  objects, it is the `Wire`'s `EmitOn`, `FramesOn` and `RequestOf`.
- **A request** waits for the stream to be open before it is sent, is
  answered once, and is abandoned by cancelling its context.
- **Frames** are a sequence: each reader is given every one, in order, however
  far behind it falls, until its loop stops or its context is done.
- **A resource's channel is read for the resource.** `mark:added` and the
  other events of the record are delivered on their resource's scope, and
  their channels are `bus.Scoped`. `semiont.FramesOf(ctx, wire, bus.MarkAdded, resource)`
  holds that scope until the loop stops or `ctx` is done, and gives that
  resource's frames and no other's. `semiont.Frames` takes only a channel delivered to everyone.
- **The connection's state** (`transport.State()`) is a `Watched` value: what
  it is now, and each thing it becomes. A dropped stream is a state, never an
  error, and opens again by itself.
- **Failures** are `semiont.Error`s under the codes of
  [`specs/src/errors/codes.json`][codes]: `*TransportError`,
  `*BusRequestError`, `*SessionError`, `*SignInError` and `*JobError`. What a
  server refused is also on `transport.Failures()`.
- **The token** is a `*Variable[string]` the transport watches: when it
  changes, the next request carries the new one. A stream refused for its
  token asks its `Refresher` for another, once per outage, and with none
  waits, with no request, for a different one. A request or an emit refused
  so asks it once and is sent again at once with the token it gives.

The protocol it keeps to is [the transport contract][transport-contract] and
[the HTTP transport][transport-http], and the [conformance suite][conformance]
holds it there, case by case, beside the other SDKs.

## Content, and the gateway's own operations

Bytes never ride the bus. A content transport uploads them and reads them
back, and the gateway's own operations ask the gateway what it answers for
itself.

```go
import (
	"bytes"
	"context"
	"fmt"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// Store uploads a page, reads it back, and asks the gateway who is signed in
// and whether it is serving. Over HTTP, content is
// semiont.NewHTTPContentTransport(transport), and gateway is the transport.
func Store(ctx context.Context, content semiont.ContentTransport, gateway semiont.GatewayOperations, page []byte) (api.ResourceId, error) {
	upload := content.PutBinary(ctx, semiont.PutBinaryRequest{
		Name: "A page", Bytes: page, Format: "text/markdown", StorageURI: "file://pages/a.md", EntityTypes: []string{"Note"},
	})
	for progress := range upload.Progress() {
		fmt.Println(progress.BytesUploaded, "of", progress.TotalBytes)
	}
	created, err := upload.Wait(ctx)
	if err != nil {
		return api.ResourceId{}, err
	}

	stored, err := content.GetBinary(ctx, created.ResourceId)
	if err != nil {
		return api.ResourceId{}, err
	}
	if !bytes.Equal(stored.Bytes, page) || stored.ContentType != "text/markdown" {
		return api.ResourceId{}, fmt.Errorf("read back %d bytes of %s", len(stored.Bytes), stored.ContentType)
	}

	me, err := gateway.GetCurrentUser(ctx)
	if err != nil {
		return api.ResourceId{}, err
	}
	health, _, err := gateway.HealthCheck(ctx)
	if err != nil {
		return api.ResourceId{}, err
	}
	fmt.Println(me.Did, health.Status)
	return created.ResourceId, nil
}
```

- **An upload** is ranged over for its progress and waited for the resource
  it created, each once.
- **What is read is what was stored**, byte for byte, with its media type.
- **A resource's description and its anchored text are read here too**, by
  `GetResourceGraph` and `GetAnchoredText`, which are what
  `client.Browse.ResourceGraph` and `client.Browse.ResourceAnchoredText`
  call.
- **The text of a resource** (`client.Browse.ResourceContent`) is its bytes
  read as a browser reads them, by [the rule every Semiont reader
  keeps][resource-text]. `semiont.DecodeRepresentation(data, mediaType)` is
  the same reading, of bytes a program already holds.

## Ids, and the protocol's shapes

The module holds what the protocol states, as Go types (package `api`): the
kinds of id, the shapes the protocol sends and answers with, and the requests
made over its bus. Each kind of id is a type of its own, made only from text
that is one, and the compiler refuses one kind where a shape names another.

```go
import (
	"encoding/json"
	"fmt"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// Ids makes ids from text, and a command of them.
func Ids() error {
	resource, err := api.ParseResourceId("5bcd259ab1464cf68a556bbad21f513f")
	if err != nil {
		return err
	}
	if _, err := api.ParseResourceId("https://kb.example/resources/x"); err != nil {
		fmt.Println(err) // "https://kb.example/resources/x" is not a ResourceId: it does not match ^[A-Za-z0-9_-]{1,128}$
	}
	annotation, err := api.ParseAnnotationId("a-1")
	if err != nil {
		return err
	}
	command, err := json.Marshal(api.MarkDeleteCommand{AnnotationId: annotation, ResourceId: &resource})
	if err != nil {
		return err
	}
	fmt.Println(string(command)) // {"annotationId":"a-1","resourceId":"5bcd259ab1464cf68a556bbad21f513f"}
	// api.MarkDeleteCommand{AnnotationId: resource} does not compile: a ResourceId is not an AnnotationId.
	return nil
}
```

## Telemetry

The SDK takes OpenTelemetry's API and installs nothing: it does nothing until
the application it runs in installs a provider. With one, it exports what
[`specs/src/sdk-telemetry/telemetry.json`][telemetry] lists, as every Semiont
SDK does: a span for each frame sent and each received, a span for each upload
and each read, and a count of the emits sent. A request carries the trace it
is made in, and a frame continues the trace it was sent under (`Frame.Trace`).
A job a worker holds states the trace it is run in (`job.Trace()`).
`semiont.Continuing(ctx, trace)` is a context whose spans continue either.

With `SEMIONT_BUS_LOG` set to any value that is not empty, a transport over
HTTP also writes the [bus log][bus-log], as every Semiont SDK does: one line
for each frame it sends and each it receives, and for each read and each
upload of content. A line says the channel, the resource's scope, the first
eight characters of the correlation id and of the trace's id, and the payload
as JSON:

```
[bus EMIT] job:claim cid=a89a670a {"accepts":[{"jobType":"yield"}]}
[bus RECV] job:claim-failed cid=a89a670a {"code":"none-pending","message":"No pending job matches"}
```

The lines go to standard error, as the Rust SDK's do: a program's standard
output is its own, and a line there would be read as one of its answers. The
variable is read once, when the first line would be written. No line holds a
credential: the value of a payload's member whose name is one a credential
goes by (`token`, which is what a payload names the token a resource is cloned
by, `password`, `apiKey` and the rest of the [short list][bus-log] every bus
log keeps) is written as `[withheld]`.

## What is in the module

| Package | Holds | Generated from |
|---|---|---|
| `semiont` | The client (`Client`, `NewClient`) and its eleven namespaces; `Cached`, `Running`, `Delegation` and `Upload`; the cache, its refresher and what it keeps (`Cache`, `CachePersistence`, `SessionStorage`, `MemoryStorage`, `CoupledBookmarks`); `Claims` and the held jobs; `HTTPTransport`, `HTTPContentTransport`, `Wire` and the client's own `EventBus`; signing in (`SessionFromKept`, `ResumeSession`, `SignInWithDevice`, `SignOut`, `SignInAgent`, `NewServiceToken`) and `Session`; a person's sign-in by a page redirect (`BeginAuthorization`, `CompleteAuthorization`, `DescribeConnection`); the sign-in store (`SignInStore`, `StateDir`); `SessionSignals`, `StateUnit`, `Variable` and `Watched`; the readers of a resource (`PrimaryRepresentation`, `PrimaryMediaType`, `ResourceEntityTypes`, `DecodeRepresentation`); how a knowledge base and its principals are named (`KbDid`, `PersonDid`, `AgentDid` and the rest); `GatewayURL`; the retry rules; and the generated tables: the failure codes (`errorcodes_gen.go`), the timing (`timing_gen.go`), the refresh table (`refresh_gen.go`), the telemetry names (`telemetry_gen.go`), the sign-in store's entry (`signin_gen.go`), the OAuth clients (`oauthclients_gen.go`) and the Encoding Standard's labels (`encodings_gen.go`) | hand-written; [`specs/src/errors/codes.json`][codes]; [`specs/src/client/timing.json`](../../../specs/src/client/timing.json); [`specs/src/client/refresh.json`][refresh]; [`specs/src/sdk-telemetry/telemetry.json`][telemetry]; [`specs/src/sign-in-store/SignIn.json`](../../../specs/src/sign-in-store/SignIn.json); [`specs/src/session/oauth.json`](../../../specs/src/session/oauth.json) |
| `api` | `client_gen.go`: a Go type for every schema of the spec, and a typed HTTP call for every operation. `ids_gen.go`: the kinds of id, each a type made only through its kind's rule (`ParseResourceId` and the others) | [`specs/src/openapi.json`](../../../specs/src/openapi.json), bundled; [`specs/src/identifiers/kinds.json`](../../../specs/src/identifiers/kinds.json) |
| `bus` | The bus's channels, each typed by its payload, its request and reply operations, and the channels a transport delivers | [`specs/src/bus/registry.json`](../../../specs/src/bus/registry.json) |
| `state` | The state units a client's bus moves | hand-written |
| `annotations` | Reading an annotation, building one of a span or of a resource, and `Reconcile` | hand-written |
| `registry` | Several knowledge bases: `SemiontBrowser`, its storage and its keys, `HttpSessionFactory`, and a person's sign-in landing on the knowledge base that answered | hand-written |
| `discovery` | The document a launcher publishes of the knowledge bases it manages, read and followed | [`specs/src/discovery/DiscoveryDocument.json`](../../../specs/src/discovery/DiscoveryDocument.json), through `api` |
| `semionttest` | What a consumer's tests are built on: `NewTestClient`, a real client over `FaultyTransport`, `InMemoryContent` and `StubGateway`; `NewTestSession`; `ScriptedSessions` and `SharedStorage`, for a registry; `AssertStateUnitAxioms`; and the liveness axioms | hand-written |
| `mediatypes` | The media types a knowledge base admits, and `ForExtension` | [`specs/src/media-types/registry.json`](../../../specs/src/media-types/registry.json) |
| `readme` | The programs this page shows, each run by its tests | hand-written |

Everything generated is committed, as the monorepo's other generated
artifacts are. A consumer never needs a generator, and a change to the spec
shows up as a diff someone reviews. A gate in CI fails when a generated file
differs from what the spec generates.

## Regenerating

Nothing regenerates by itself. When the spec changes, the client:

```sh
cd packages/go/sdk && go generate ./...
```

That runs the pinned generator (`oapi-codegen@v2.6.0`) in a `golang`
container at the toolchain `go.mod` names, so no Go is needed on the host. It
reads the bundle `npm run openapi:bundle` writes and rewrites `api/client_gen.go`.
Commit the result. CI runs the same generator and fails while the committed
client differs from what the spec generates.

What the generator is told is in [`oapi-codegen.yaml`](oapi-codegen.yaml), the
one file `go generate`, CI and `scripts/ci/local-build.sh` all give it. Each
of the three adds only the spec's path and the path it writes to.

Generation covers the whole spec on purpose: a Go type for every schema and a
complete typed call for every operation. The file sets `skip-prune`, because
oapi-codegen otherwise drops every schema no HTTP path reaches, which is the
whole of the bus's payload vocabulary. The drift check compares the generator
with itself and cannot see that kind of gap, so a second check in CI
(`scripts/ci/check-go-schema-coverage.mjs`) holds the count of generated types
to the count of schemas in the spec.

The file also sets `always-prefix-enum-values`: every enum constant is named
by its type and then its value, as `LogFormatJson` is the `json` of
`LogFormat`. A schema that reuses a value another schema has renames no
constant.

The bus's channels, and the SDK's tables:

```sh
npm run generate:bus          # the TypeScript and Go sides of the bus registry
```

```sh
npm run generate:go           # the Go SDK's tables
```

Each has a `:check` form that verifies without writing, as CI does.

## Working on it

The module is [`packages/go/sdk`][package] of the [Semiont repository][semiont],
and [Testing][testing] says how its checks and its tests are run. Go runs in a
`golang` container at the toolchain its `go.mod` names. The programs this page
shows are files of package `readme`, word for word: the compiler checks them,
and its tests run each one.

## License

Apache-2.0. See [LICENSE](../../../LICENSE).

[semiont]: https://github.com/The-AI-Alliance/semiont
[introduction]: ../../../docs/builder/INTRODUCTION.md
[quick-start]: ../../../docs/builder/QUICK-START.md
[developer-guide]: ../../../docs/builder/DEVELOPER-GUIDE.md
[skills]: ../../../docs/builder/skills
[flows]: ../../../docs/protocol/flows/README.md
[reactive-model]: ../../../docs/builder/REACTIVE-MODEL.md
[protocol]: ../../../docs/protocol/README.md
[transport-contract]: ../../../docs/protocol/TRANSPORT-CONTRACT.md
[transport-http]: ../../../docs/protocol/TRANSPORT-HTTP.md
[cache-semantics]: ../../../docs/protocol/CACHE-SEMANTICS.md
[conformance]: ../../../tests/conformance/sdk/README.md
[worker-contract]: ../../../docs/protocol/WORKER-CONTRACT.md
[worker-conformance]: ../../../tests/conformance/worker/README.md
[sdk-typescript]: ../../sdk/README.md
[sdk-rust]: ../../sdk-rust/README.md
[sdk-python]: ../../python/sdk/README.md
[launcher]: ../../../apps/launcher/README.md
[surface]: ../../../specs/src/client/surface.json
[refresh]: ../../../specs/src/client/refresh.json
[codes]: ../../../specs/src/errors/codes.json
[session-cases]: ../../../specs/src/session/cases.json
[resource-text]: ../../../docs/protocol/W3C-SELECTORS.md#the-text-of-a-resource
[sign-in-store]: ../../../specs/src/sign-in-store/README.md
[telemetry]: ../../../specs/src/sdk-telemetry/telemetry.json
[bus-log]: ../../../docs/protocol/EVENT-BUS.md#wire-format-the-bus-log
[package]: .
[testing]: ../../../docs/contributor/TESTING.md
[state-units]: ../../../docs/builder/STATE-UNITS.md
[state-units-cases]: ../../../specs/src/client/state-units.json
