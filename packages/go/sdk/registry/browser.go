// Package registry is what an application holds beside its knowledge bases:
// the list of the ones it has registered, which of them is active, the active
// one's session, and what a person has open in each. It builds sessions
// through the SessionFactory it is given, and so knows nothing of how a
// knowledge base is reached; HttpSessionFactory reaches one over its gateway.
// A person's sign-in by a page redirect lands here (BeginSignIn,
// CompleteSignIn).
//
// One session is live at a time, the active knowledge base's. Making another
// active closes it first: its readers see no session, then the new one.
// Activations do not overlap, and one that was overtaken while it waited does
// nothing. SessionActivating is true while one is under way, which is what
// tells "a session is coming" from "there is none".
//
// Look up by address, verify by did. A sign-in lands on the entry, among those
// at the address, whose did is the one the knowledge base reported, or on a
// new entry. The address, the entry a person re-authenticated and the row they
// clicked say what they believed, and are reported back, never acted on. So an
// entry's did never changes, and its label and last read are written only from
// an answer that carried its did.
//
// What is open is per knowledge base, and shown only while that knowledge base
// has a live session. When a session comes up, the knowledge base is asked who
// it is and each open resource is checked against it:
//
//   - a resource the knowledge base says does not exist is closed; one whose
//     check failed any other way stays open;
//   - a different knowledge base answering voids what was open and where the
//     person was, and raises the conflict for a host to show. The entry is
//     left as it was written;
//   - no answer is no verdict, and changes nothing.
//
// A request the gateway refuses for want of a valid token renews the session,
// and only a session that cannot be renewed is said to have expired. A
// request refused for lack of permission is said at once.
//
// Every change to what is open is made against what the storage holds, as one
// step, so two contexts that each open a resource both keep theirs. A write the
// storage refuses changes nothing, there or here; a method that writes returns
// the refusal.
//
// Close is the graceful end.
package registry

import (
	"context"
	"encoding/json"
	"errors"
	"iter"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// checksAtOnce is how many open resources are checked at once when a session
// comes up: a connection that has just opened is not handed every check
// together.
const checksAtOnce = 4

// failuresBacklog is how many failures a reader of Errors that has fallen
// behind is kept; it misses those after.
const failuresBacklog = 64

// SemiontBrowserConfig is what a registry is made of.
type SemiontBrowserConfig struct {
	// Storage is where everything the registry keeps is kept.
	Storage semiont.SessionStorage
	// SessionFactory is what builds a knowledge base's session.
	SessionFactory SessionFactory
}

// SignedIn is what a completed sign-in learned: where it was, who the
// knowledge base there says it is, the tokens, and what the person believed
// they were signing in to.
type SignedIn struct {
	Endpoint api.KbEndpoint
	// Description is what the knowledge base said of itself, asked with the
	// new token.
	Description api.KbDescription
	Session     StoredSession
	// KbID is the registered entry the person re-authenticated; "" when it
	// was none.
	KbID string
	// ExpectedDid and ExpectedName are the did and the name of a row the
	// person clicked; "" when it was none.
	ExpectedDid  string
	ExpectedName string
}

// Expected is what a person believed they were signing in to.
type Expected struct {
	Did string
	// Name is "" when nothing was named.
	Name string
}

// SignInOutcome is the entry a sign-in landed on, and what the person
// believed, so a host can set the two against each other and say when they
// differ. The sign-in stands either way: the knowledge base that answered is
// the one reached.
type SignInOutcome struct {
	Kb api.KnowledgeBase
	// Expected is nil when the person named nothing.
	Expected *Expected
}

// KbReadKind is what a knowledge base said when it was asked to describe
// itself, read against the entry it was asked as.
type KbReadKind string

const (
	// KbReadRecorded: it answered as that entry, and its name and branch are
	// on it now.
	KbReadRecorded KbReadKind = "recorded"
	// KbReadConflict: a different knowledge base answered. Its did and the
	// name it gave itself are on the verdict and nowhere else: the entry is
	// as it was.
	KbReadConflict KbReadKind = "conflict"
	// KbReadNoVerdict: it did not answer, or could not say who it is.
	// Evidence of nothing.
	KbReadNoVerdict KbReadKind = "no-verdict"
)

// KbReadVerdict is one reading of a knowledge base against its entry.
type KbReadVerdict struct {
	Kind KbReadKind
	// ObservedDid and ObservedName are a KbReadConflict's alone.
	ObservedDid  string
	ObservedName string
}

// SemiontBrowser is a registry of knowledge bases: see the package's
// documentation.
type SemiontBrowser struct {
	storage semiont.SessionStorage
	factory SessionFactory

	knowledgeBases    *held[[]api.KnowledgeBase]
	activeKbID        *semiont.Variable[string]
	activeSession     *semiont.Variable[*semiont.Session]
	activeSignals     *semiont.Variable[*semiont.SessionSignals]
	sessionActivating *semiont.Variable[bool]
	openResources     *held[[]OpenResource]
	lastViewed        *semiont.Variable[api.ResourceId]
	identityToken     *semiont.Variable[string]
	failures          *failures
	bus               *semiont.EventBus

	// mu guards what the registry keeps in memory of what its storage holds,
	// and the live session's end.
	mu             sync.Mutex
	openByKb       map[string][]OpenResource
	lastViewedByKb map[string]api.ResourceId
	// activations is how many are under way or waiting their turn.
	activations int
	// liveEnd ends the live session and its client; nil while there is none.
	liveEnd func()

	// turn lets one activation run at a time: whoever holds its one slot. A
	// channel, so one waiting its turn is blocked as a channel's reader is,
	// which a paused test clock waits on.
	turn chan struct{}
	// alive ends when the registry is closed: what it runs runs under it.
	alive         context.Context
	stop          context.CancelFunc
	tasks         sync.WaitGroup
	stopListening func()
	closed        atomic.Bool
}

// NewSemiontBrowser is a registry over what config.Storage holds. The active
// knowledge base's session is brought up at once, in the background. What was
// read is what is kept: an entry that did not read as a knowledge base is gone
// from the storage too.
func NewSemiontBrowser(config SemiontBrowserConfig) *SemiontBrowser {
	storage := config.Storage
	kbs := LoadKnowledgeBases(storage)
	active, _ := storage.Get(ActiveKey)
	if !slices.ContainsFunc(kbs, func(kb api.KnowledgeBase) bool { return kb.Id == active }) {
		active = ""
		if len(kbs) > 0 {
			active = kbs[0].Id
		}
	}
	alive, stop := context.WithCancel(context.Background())
	b := &SemiontBrowser{
		storage:           storage,
		factory:           config.SessionFactory,
		knowledgeBases:    newHeld([]api.KnowledgeBase{}),
		activeKbID:        semiont.NewVariable(""),
		activeSession:     semiont.NewVariable[*semiont.Session](nil),
		activeSignals:     semiont.NewVariable[*semiont.SessionSignals](nil),
		sessionActivating: semiont.NewVariable(false),
		openResources:     newHeld([]OpenResource{}),
		lastViewed:        semiont.NewVariable(api.ResourceId{}),
		identityToken:     semiont.NewVariable(""),
		failures:          newFailures(),
		bus:               semiont.NewEventBus(),
		openByKb:          openByKbOf(storage.Get(OpenResourcesByKbKey)),
		lastViewedByKb:    lastViewedByKbOf(storage.Get(LastViewedResourceByKbKey)),
		turn:              make(chan struct{}, 1),
		alive:             alive,
		stop:              stop,
	}
	// A storage that refuses these writes keeps the entries it had, which the
	// next registry over it drops again.
	_ = b.putKbs(kbs)
	_ = b.putActiveID(active)

	if stopListening, ok := storage.Subscribe(b.writtenElsewhere); ok {
		b.stopListening = stopListening
	}
	if active != "" {
		b.spawn(func() { _ = b.setActiveKb(active) })
	}
	return b
}

// ── What it holds ───────────────────────────────────────────────────────

// KnowledgeBases is the registered knowledge bases.
func (b *SemiontBrowser) KnowledgeBases() semiont.Watched[[]api.KnowledgeBase] {
	return b.knowledgeBases
}

// ActiveKbId is the id of the active knowledge base; "" for none. It names
// the one meant: its session may still be on its way, or there may be none.
func (b *SemiontBrowser) ActiveKbId() semiont.Watched[string] { return b.activeKbID.Reading() }

// ActiveSession is the active knowledge base's session; nil when it has none.
func (b *SemiontBrowser) ActiveSession() semiont.Watched[*semiont.Session] {
	return b.activeSession.Reading()
}

// ActiveSignals is what a host shows about the active session. There exactly
// when the session is.
func (b *SemiontBrowser) ActiveSignals() semiont.Watched[*semiont.SessionSignals] {
	return b.activeSignals.Reading()
}

// SessionActivating is whether a session is being brought up.
func (b *SemiontBrowser) SessionActivating() semiont.Watched[bool] {
	return b.sessionActivating.Reading()
}

// OpenResources is what is open in the active knowledge base, in order.
// Empty while it has no live session.
func (b *SemiontBrowser) OpenResources() semiont.Watched[[]OpenResource] { return b.openResources }

// LastViewedResource is the resource last viewed in the active knowledge
// base; the zero id while it has no live session, and never another knowledge
// base's.
func (b *SemiontBrowser) LastViewedResource() semiont.Watched[api.ResourceId] {
	return b.lastViewed.Reading()
}

// Errors is the failures that made a session unusable, from this call on,
// until ctx is done or the registry is closed. A reader that falls more than
// a few dozen behind misses those after.
func (b *SemiontBrowser) Errors(ctx context.Context) iter.Seq[*semiont.SessionError] {
	return b.failures.from(ctx)
}

// IdentityToken is the token of an identity the host's environment supplies;
// "" for none.
func (b *SemiontBrowser) IdentityToken() semiont.Watched[string] { return b.identityToken.Reading() }

// SetIdentityToken sets the identity token; "" for none.
func (b *SemiontBrowser) SetIdentityToken(token string) { b.identityToken.Set(token) }

// Storage is where the registry keeps what it keeps: what a sign-in that is
// under way is remembered in, too.
func (b *SemiontBrowser) Storage() semiont.SessionStorage { return b.storage }

// Bus is the application's own bus: what its parts say to each other whether
// or not a knowledge base is active. Apart from a client's own bus, which
// carries what happens in one knowledge base.
func (b *SemiontBrowser) Bus() *semiont.EventBus { return b.bus }

// ── The knowledge bases ─────────────────────────────────────────────────

// AddKb registers a knowledge base that a sign-in reached, keeps its tokens,
// and makes it the active one, returning once its session is up or known not
// to be.
func (b *SemiontBrowser) AddKb(input api.NewKnowledgeBase, session StoredSession) (api.KnowledgeBase, error) {
	kb := api.KnowledgeBase{Id: uuid.NewString(), Label: input.Label, Did: input.Did, Endpoint: input.Endpoint, LastRead: input.LastRead}
	if err := StoreSession(b.storage, kb.Id, session); err != nil {
		return api.KnowledgeBase{}, err
	}
	if err := b.putKbs(append(slices.Clone(b.knowledgeBases.Value()), kb)); err != nil {
		return api.KnowledgeBase{}, err
	}
	return kb, b.setActiveKb(kb.Id)
}

// RemoveKb forgets a knowledge base: its entry, its tokens, what was open in
// it and where the person was. If it was active, the first of the others
// becomes active.
func (b *SemiontBrowser) RemoveKb(id string) error {
	ClearStoredSession(b.storage, id)
	if err := b.forgetKeptOf(id); err != nil {
		return err
	}
	rest := slices.DeleteFunc(slices.Clone(b.knowledgeBases.Value()), func(kb api.KnowledgeBase) bool { return kb.Id == id })
	next := ""
	if len(rest) > 0 {
		next = rest[0].Id
	}
	if err := b.putKbs(rest); err != nil {
		return err
	}
	if b.activeKbID.Value() == id {
		return b.setActiveKb(next)
	}
	return nil
}

// UpdateKb writes what a knowledge base last said of itself onto its entry: a
// label, unless it is nil, and a last read, unless it is nil. Its endpoint is
// not changed in place, and its did is never changed.
func (b *SemiontBrowser) UpdateKb(id string, label *string, lastRead *api.KbRead) error {
	kbs := slices.Clone(b.knowledgeBases.Value())
	for i := range kbs {
		if kbs[i].Id != id {
			continue
		}
		if label != nil {
			kbs[i].Label = *label
		}
		if lastRead != nil {
			read := *lastRead
			kbs[i].LastRead = &read
		}
	}
	return b.putKbs(kbs)
}

// KbSessionStatus is what the credential stored for a knowledge base says,
// read without asking anyone.
func (b *SemiontBrowser) KbSessionStatus(kbID string) KbSessionStatus {
	stored, ok := StoredSessionOf(b.storage, kbID)
	switch {
	case !ok:
		return KbSessionSignedOut
	case semiont.IsTokenExpired(stored.Access, time.Now()):
		return KbSessionExpired
	default:
		return KbSessionAuthenticated
	}
}

// SetActiveKb makes a knowledge base the active one, or none for "". It
// returns once its session is up, or once it is known there will be none.
func (b *SemiontBrowser) SetActiveKb(id string) error { return b.setActiveKb(id) }

// SignIn keeps new tokens for a registered knowledge base and brings its
// session up on them. A session it already had is closed and replaced.
func (b *SemiontBrowser) SignIn(id string, session StoredSession) error {
	if b.closed.Load() {
		return nil
	}
	if err := StoreSession(b.storage, id, session); err != nil {
		return err
	}
	// A session it already has is on the old tokens: it is closed, and the
	// one built next reads the new ones.
	if b.activeKbID.Value() == id {
		if taken := b.takeSession(); taken != nil {
			taken.close()
		}
	}
	return b.setActiveKb(id)
}

// SignedIn is the registry's half of a sign-in: it lands the sign-in on the
// entry for the knowledge base that answered (see the package's
// documentation). A description whose domain no did can hold is refused, and
// nothing is registered.
func (b *SemiontBrowser) SignedIn(signedIn SignedIn) (SignInOutcome, error) {
	did, err := semiont.KbDid(signedIn.Description.Domain)
	if err != nil {
		return SignInOutcome{}, err
	}
	label := signedIn.Description.Name
	lastRead := kbReadOf(signedIn.Description, time.Now())
	kbs := b.knowledgeBases.Value()
	var atAddress []api.KnowledgeBase
	for _, kb := range kbs {
		if samePlace(kb.Endpoint, signedIn.Endpoint) {
			atAddress = append(atAddress, kb)
		}
	}
	// An address with several entries singles out no belief of its own.
	var believed *api.KnowledgeBase
	switch {
	case signedIn.KbID != "":
		if i := slices.IndexFunc(kbs, func(kb api.KnowledgeBase) bool { return kb.Id == signedIn.KbID }); i >= 0 {
			believed = &kbs[i]
		}
	case len(atAddress) == 1:
		believed = &atAddress[0]
	}
	var expected *Expected
	switch {
	case signedIn.ExpectedDid != "":
		expected = &Expected{Did: signedIn.ExpectedDid, Name: signedIn.ExpectedName}
	case believed != nil:
		expected = &Expected{Did: believed.Did, Name: believed.Label}
	}

	if i := slices.IndexFunc(atAddress, func(kb api.KnowledgeBase) bool { return kb.Did == did.String() }); i >= 0 {
		kb := atAddress[i]
		kb.Label, kb.LastRead = label, &lastRead
		if err := b.UpdateKb(kb.Id, &label, &lastRead); err != nil {
			return SignInOutcome{}, err
		}
		return SignInOutcome{Kb: kb, Expected: expected}, b.SignIn(kb.Id, signedIn.Session)
	}
	kb, err := b.AddKb(api.NewKnowledgeBase{Label: label, Did: did.String(), Endpoint: signedIn.Endpoint, LastRead: &lastRead}, signedIn.Session)
	return SignInOutcome{Kb: kb, Expected: expected}, err
}

// SignOut signs out of a knowledge base: its tokens are forgotten, and the
// issuer is told so its refresh token is good for nothing. If it is active,
// its session is closed.
func (b *SemiontBrowser) SignOut(id string) {
	if b.closed.Load() {
		return
	}
	stored, ok := StoredSessionOf(b.storage, id)
	ClearStoredSession(b.storage, id)
	if ok {
		// The sign-out is the local act: an issuer that cannot be reached
		// does not keep anyone in a session they asked to end.
		b.spawn(func() { b.factory.Revoke(b.alive, stored) })
	}
	// Said again, so whoever shows each knowledge base's status reads it anew.
	b.knowledgeBases.raise(b.knowledgeBases.Value())
	if b.activeKbID.Value() == id {
		if taken := b.takeSession(); taken != nil {
			taken.close()
		}
	}
}

// ── What is open ────────────────────────────────────────────────────────

// AddOpenResource opens a resource in the active knowledge base, or, when it
// is open already, takes its name, and its media type and storage URI unless
// each is "". Nothing is opened while it has no live session.
func (b *SemiontBrowser) AddOpenResource(id api.ResourceId, name, mediaType, storageURI string) error {
	return b.mutateOpenResources(func(open []OpenResource) []OpenResource {
		for i := range open {
			if open[i].ID != id {
				continue
			}
			open[i].Name = name
			if mediaType != "" {
				open[i].MediaType = mediaType
			}
			if storageURI != "" {
				open[i].StorageURI = storageURI
			}
			return open
		}
		// After the last place taken, not the count: a place freed by a
		// removal is not handed out twice.
		order := 0
		for _, resource := range open {
			order = max(order, resource.Order+1)
		}
		return append(open, OpenResource{ID: id, Name: name, OpenedAt: time.Now().UnixMilli(), Order: order, MediaType: mediaType, StorageURI: storageURI})
	})
}

// RemoveOpenResource closes a resource in the active knowledge base.
func (b *SemiontBrowser) RemoveOpenResource(id api.ResourceId) error {
	return b.mutateOpenResources(func(open []OpenResource) []OpenResource {
		return slices.DeleteFunc(open, func(resource OpenResource) bool { return resource.ID == id })
	})
}

// UpdateOpenResourceName gives an open resource of the active knowledge base
// a name.
func (b *SemiontBrowser) UpdateOpenResourceName(id api.ResourceId, name string) error {
	return b.mutateOpenResources(func(open []OpenResource) []OpenResource {
		for i := range open {
			if open[i].ID == id {
				open[i].Name = name
			}
		}
		return open
	})
}

// ReorderOpenResources moves the open resource at one place in the visible
// list to another. A place that is not in the list moves nothing.
func (b *SemiontBrowser) ReorderOpenResources(from, to int) error {
	return b.mutateOpenResources(func(open []OpenResource) []OpenResource {
		if from < 0 || to < 0 || from >= len(open) || to >= len(open) {
			return open
		}
		ordered := SortOpenResources(open)
		moved := ordered[from]
		ordered = slices.Insert(slices.Delete(ordered, from, from+1), to, moved)
		for place := range ordered {
			ordered[place].Order = place
		}
		return ordered
	})
}

// SetLastViewedResource records the resource a person is looking at, in the
// active knowledge base. Nothing is recorded while it has no live session.
func (b *SemiontBrowser) SetLastViewedResource(id api.ResourceId) error {
	kbID := b.liveKbID()
	if kbID == "" {
		return nil
	}
	return b.mutateLastViewed(func(viewed map[string]api.ResourceId) { viewed[kbID] = id })
}

// ReadActiveKb asks the active knowledge base to describe itself again, and
// says what it answered. Asking is not activating: an answer as the entry is
// recorded on it, and a different knowledge base answering is reported.
// Nothing is voided and nothing raised.
func (b *SemiontBrowser) ReadActiveKb(ctx context.Context) KbReadVerdict {
	session, kbID := b.activeSession.Value(), b.activeKbID.Value()
	if session == nil || kbID == "" {
		return KbReadVerdict{Kind: KbReadNoVerdict}
	}
	return b.readKb(ctx, session, kbID)
}

// Close ends the registry: its session is closed, and everything it holds
// ends. It returns once what it was running has stopped. Closing twice is
// closing once.
func (b *SemiontBrowser) Close() {
	b.mu.Lock()
	closing := !b.closed.Swap(true)
	b.mu.Unlock()
	if !closing {
		return
	}
	taken := b.takeSession()
	b.stop()
	if b.stopListening != nil {
		b.stopListening()
	}
	if taken != nil {
		taken.close()
	}
	b.tasks.Wait()
	b.failures.end()
	b.knowledgeBases.end()
	b.activeKbID.End()
	b.activeSession.End()
	b.activeSignals.End()
	b.sessionActivating.End()
	b.openResources.end()
	b.lastViewed.End()
	b.identityToken.End()
	b.bus.Close()
}

// ── Within ──────────────────────────────────────────────────────────────

// spawn runs work under the registry's lifetime; Close waits for it.
func (b *SemiontBrowser) spawn(work func()) {
	b.tasks.Add(1)
	go func() {
		defer b.tasks.Done()
		work()
	}()
}

// samePlace is whether two endpoints are one place: for a gateway, its host
// and port; for a loaded knowledge base, its id.
func samePlace(one, other api.KbEndpoint) bool {
	oneKind, err := one.Discriminator()
	if err != nil {
		return false
	}
	otherKind, err := other.Discriminator()
	if err != nil || oneKind != otherKind {
		return false
	}
	switch oneKind {
	case string(api.HttpEndpointKindHttp):
		a, errA := one.AsHttpEndpoint()
		b, errB := other.AsHttpEndpoint()
		return errA == nil && errB == nil && a.Host == b.Host && a.Port == b.Port
	case string(api.LocalEndpointKindLocal):
		a, errA := one.AsLocalEndpoint()
		b, errB := other.AsLocalEndpoint()
		return errA == nil && errB == nil && a.KbId == b.KbId
	}
	return false
}

// kbReadOf is what a knowledge base said of itself at at, beyond its name:
// the time as RFC 3339, in UTC, to the millisecond.
func kbReadOf(description api.KbDescription, at time.Time) api.KbRead {
	return api.KbRead{At: at.UTC().Format("2006-01-02T15:04:05.000Z07:00"), GitBranch: description.GitBranch}
}

// openByKbOf is what is stored of each knowledge base's open resources; none
// for what does not read as that.
func openByKbOf(stored string, has bool) map[string][]OpenResource {
	open := map[string][]OpenResource{}
	if has && json.Unmarshal([]byte(stored), &open) != nil {
		return map[string][]OpenResource{}
	}
	return open
}

// lastViewedByKbOf is what is stored of where the person was in each
// knowledge base; none for what does not read as that.
func lastViewedByKbOf(stored string, has bool) map[string]api.ResourceId {
	viewed := map[string]api.ResourceId{}
	if has && json.Unmarshal([]byte(stored), &viewed) != nil {
		return map[string]api.ResourceId{}
	}
	return viewed
}

func written(value any) string {
	text, err := json.Marshal(value)
	if err != nil {
		// A map of lists of structs of strings and numbers, or of ids each read
		// from the storage or given by a caller as an id, always encodes.
		panic(err)
	}
	return string(text)
}

func (b *SemiontBrowser) putKbs(kbs []api.KnowledgeBase) error {
	if b.closed.Load() {
		return nil
	}
	if err := SaveKnowledgeBases(b.storage, kbs); err != nil {
		return err
	}
	b.knowledgeBases.raise(kbs)
	return nil
}

func (b *SemiontBrowser) putActiveID(id string) error {
	if b.closed.Load() {
		return nil
	}
	if id == "" {
		b.storage.Delete(ActiveKey)
	} else if err := b.storage.Set(ActiveKey, id); err != nil {
		return err
	}
	b.activeKbID.Set(id)
	return nil
}

func (b *SemiontBrowser) failed(err *semiont.SessionError) { b.failures.say(err) }

// ── The active session ──────────────────────────────────────────────────

// ended is a live session, and what a host shows about it, taken out of the
// registry to be closed.
type ended struct {
	end     func()
	signals *semiont.SessionSignals
}

// close ends the session, then the client it was built with, then what a
// host was shown of it.
func (e *ended) close() {
	e.end()
	if e.signals != nil {
		e.signals.Close()
	}
}

// takeSession takes the live session out: its readers see none, and what is
// open is shown no more. Whoever takes it closes it.
func (b *SemiontBrowser) takeSession() *ended {
	b.mu.Lock()
	if b.activeSession.Value() == nil {
		b.mu.Unlock()
		return nil
	}
	taken := &ended{end: b.liveEnd, signals: b.activeSignals.Value()}
	b.liveEnd = nil
	b.activeSession.Set(nil)
	b.activeSignals.Set(nil)
	b.mu.Unlock()
	b.project()
	return taken
}

// putSession puts a session that is up as the live one. The signals first:
// putting the session is what starts the checks of it, and a conflict they
// find is said through the signals. A session is put once, so what is open is
// checked once per session. One that came up as the registry closed is closed
// instead.
func (b *SemiontBrowser) putSession(session *semiont.Session, end func(), signals *semiont.SessionSignals) {
	b.mu.Lock()
	if b.closed.Load() {
		b.mu.Unlock()
		(&ended{end: end, signals: signals}).close()
		return
	}
	b.liveEnd = end
	b.activeSignals.Set(signals)
	b.activeSession.Set(session)
	b.mu.Unlock()
	b.project()
	b.spawn(func() { b.validateOpenResources(session) })
}

func (b *SemiontBrowser) setActiveKb(id string) error {
	if b.closed.Load() {
		return nil
	}
	previous := b.activeKbID.Value()
	if id == previous && b.activeSession.Value() != nil {
		return nil
	}
	// Said at once: what is meant now is id, and no session is live. An
	// activation that waited reads this to learn it was overtaken.
	if previous != id {
		if err := b.putActiveID(id); err != nil {
			return err
		}
	}
	taken := b.takeSession()

	b.activating(1)
	defer b.activating(-1)
	b.turn <- struct{}{}
	defer func() { <-b.turn }()
	if taken != nil {
		taken.close()
	}
	if !b.closed.Load() && b.activeKbID.Value() == id {
		// One left live by whoever had the turn before.
		if left := b.takeSession(); left != nil {
			left.close()
		}
		if id != "" {
			b.activate(id)
		}
	}
	return nil
}

func (b *SemiontBrowser) activating(change int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.activations += change
	b.sessionActivating.Set(b.activations > 0)
}

func (b *SemiontBrowser) activate(id string) {
	kbs := b.knowledgeBases.Value()
	i := slices.IndexFunc(kbs, func(kb api.KnowledgeBase) bool { return kb.Id == id })
	if i < 0 {
		return
	}
	// The signals exist before the session does: the session says it is over
	// through them, and may be over before it is ready.
	signals := semiont.NewSessionSignals()
	session, end, err := b.factory.Session(b.alive, SessionFactoryOptions{Kb: kbs[i], Storage: b.storage, Signals: signals, OnError: b.failed})
	if err != nil {
		signals.Close()
		if !b.closed.Load() {
			b.failed(constructFailed(err, id))
		}
		return
	}
	b.spawn(func() { route(b.alive, session, signals) })
	_ = session.Ready(b.alive)
	if b.closed.Load() || b.activeKbID.Value() != id {
		(&ended{end: end, signals: signals}).close()
		return
	}
	b.putSession(session, end, signals)
}

// constructFailed is a factory's refusal as the failure a registry says: the
// factory's own when it is one.
func constructFailed(err error, kbID string) *semiont.SessionError {
	var refused *semiont.SessionError
	if errors.As(err, &refused) {
		return refused
	}
	return &semiont.SessionError{Code: semiont.SessionErrorCodeConstructFailed, Message: err.Error(), KbID: kbID}
}

// route routes what the session's transport fails at. A refusal for want of a
// valid token renews the session: it heals quietly, or the session ends itself
// and says so once. A refusal for lack of permission has no remedy, and is
// said. It ends when the transport closes.
func route(alive context.Context, session *semiont.Session, signals *semiont.SessionSignals) {
	for failure := range session.Errors() {
		switch failure.Code {
		case semiont.TransportErrorCodeUnauthorized:
			// Refusals that arrive together are answered by one renewal: the
			// session holds them while it renews. A failure does not say which
			// token was refused: the one the session holds as it is read is.
			refused := session.Token().Value()
			go session.Refresh(alive, refused)
		case semiont.TransportErrorCodeForbidden:
			detail := failure.Message
			signals.NotifyPermissionDenied(&detail)
		}
	}
}

// ── What is shown ───────────────────────────────────────────────────────

// liveKbID is the id of the active knowledge base when it has a live
// session; "" otherwise.
func (b *SemiontBrowser) liveKbID() string {
	if b.activeSession.Value() == nil {
		return ""
	}
	return b.activeKbID.Value()
}

// project shows what is open, and where the person was, in the active
// knowledge base: only while it has a live session.
func (b *SemiontBrowser) project() {
	b.mu.Lock()
	open := []OpenResource{}
	var viewed api.ResourceId
	if kbID := b.liveKbID(); kbID != "" {
		open = SortOpenResources(b.openByKb[kbID])
		viewed = b.lastViewedByKb[kbID]
	}
	b.mu.Unlock()
	b.openResources.set(open)
	b.lastViewed.Set(viewed)
}

// mutateOpenResources changes what is open in the active knowledge base,
// against what the storage holds, as one step.
func (b *SemiontBrowser) mutateOpenResources(mutate func([]OpenResource) []OpenResource) error {
	kbID := b.liveKbID()
	if kbID == "" {
		return nil
	}
	var committed map[string][]OpenResource
	err := b.storage.Update(OpenResourcesByKbKey, func(stored string, has bool) (string, bool) {
		open := openByKbOf(stored, has)
		open[kbID] = mutate(slices.Clone(open[kbID]))
		committed = open
		return written(open), true
	})
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.openByKb = committed
	b.mu.Unlock()
	b.project()
	return nil
}

func (b *SemiontBrowser) mutateLastViewed(mutate func(map[string]api.ResourceId)) error {
	var committed map[string]api.ResourceId
	err := b.storage.Update(LastViewedResourceByKbKey, func(stored string, has bool) (string, bool) {
		viewed := lastViewedByKbOf(stored, has)
		mutate(viewed)
		committed = viewed
		return written(viewed), true
	})
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.lastViewedByKb = committed
	b.mu.Unlock()
	b.project()
	return nil
}

// forgetKeptOf forgets what was open in a knowledge base and where the person
// was.
func (b *SemiontBrowser) forgetKeptOf(kbID string) error {
	var committed map[string][]OpenResource
	err := b.storage.Update(OpenResourcesByKbKey, func(stored string, has bool) (string, bool) {
		open := openByKbOf(stored, has)
		delete(open, kbID)
		committed = open
		return written(open), true
	})
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.openByKb = committed
	b.mu.Unlock()
	return b.mutateLastViewed(func(viewed map[string]api.ResourceId) { delete(viewed, kbID) })
}

// writtenElsewhere hears another context change what is open, or where the
// person was.
func (b *SemiontBrowser) writtenElsewhere(key, value string, has bool) {
	if b.closed.Load() || !has {
		return
	}
	switch key {
	case OpenResourcesByKbKey:
		var open map[string][]OpenResource
		if json.Unmarshal([]byte(value), &open) != nil {
			return
		}
		b.mu.Lock()
		b.openByKb = open
		b.mu.Unlock()
	case LastViewedResourceByKbKey:
		var viewed map[string]api.ResourceId
		if json.Unmarshal([]byte(value), &viewed) != nil {
			return
		}
		b.mu.Lock()
		b.lastViewedByKb = viewed
		b.mu.Unlock()
	default:
		return
	}
	b.project()
}

// ── The checks a session's arrival starts ───────────────────────────────

func (b *SemiontBrowser) validateOpenResources(session *semiont.Session) {
	// The session's own knowledge base: by the time this runs, another may be
	// the active one.
	kbID := session.Kb().Id
	isLive := func() bool {
		live := b.activeSession.Value()
		return !b.closed.Load() && live != nil && live.Id() == session.Id()
	}

	// Who it is, first: if a different knowledge base is answering, every
	// answer about a resource would be an answer to a question asked of the
	// wrong one.
	if verdict := b.readKb(b.alive, session, kbID); verdict.Kind == KbReadConflict {
		// The read was of this session's knowledge base: what it voids is the
		// active one's, so only while this is still the active one.
		if isLive() {
			b.voidForConflict(kbID, verdict.ObservedDid)
		}
		return
	}

	// What the storage holds, not what is in memory: another context may have
	// opened a resource before this session came up.
	var waiting []api.ResourceId
	for _, resource := range openByKbOf(b.storage.Get(OpenResourcesByKbKey))[kbID] {
		waiting = append(waiting, resource.ID)
	}
	if len(waiting) == 0 {
		return
	}
	ids := make(chan api.ResourceId, len(waiting))
	for _, id := range waiting {
		ids <- id
	}
	close(ids)
	var mu sync.Mutex
	checks := map[api.ResourceId]TabCheck{}
	var lanes sync.WaitGroup
	for range checksAtOnce {
		lanes.Go(func() {
			for id := range ids {
				check := checkOpenResource(b.alive, session, id)
				mu.Lock()
				checks[id] = check
				mu.Unlock()
			}
		})
	}
	lanes.Wait()
	if isLive() {
		// A refused write leaves what is open as it was: the checks only
		// refine it.
		_ = b.mutateOpenResources(func(open []OpenResource) []OpenResource { return ApplyTabChecks(open, checks) })
	}
}

// readKb asks the knowledge base to describe itself, against the entry it is
// asked as. If it is the one the entry says, its name and branch are recorded
// on the entry. Otherwise nothing is recorded.
//
// A did is read one way only. It is not unique, so one that differs says a
// different knowledge base answered, and one that matches says nothing about
// what is in it: that is each resource's own check.
func (b *SemiontBrowser) readKb(ctx context.Context, session *semiont.Session, kbID string) KbReadVerdict {
	kbs := b.knowledgeBases.Value()
	i := slices.IndexFunc(kbs, func(kb api.KnowledgeBase) bool { return kb.Id == kbID })
	if i < 0 {
		return KbReadVerdict{Kind: KbReadNoVerdict}
	}
	description, err := session.Client().Browse.Kb(ctx)
	if err != nil {
		return KbReadVerdict{Kind: KbReadNoVerdict}
	}
	observed, err := semiont.KbDid(description.Domain)
	if err != nil {
		// A domain no did can hold is a knowledge base that could not say who
		// it is.
		return KbReadVerdict{Kind: KbReadNoVerdict}
	}
	if observed.String() != kbs[i].Did {
		return KbReadVerdict{Kind: KbReadConflict, ObservedDid: observed.String(), ObservedName: description.Name}
	}
	if b.closed.Load() {
		return KbReadVerdict{Kind: KbReadNoVerdict}
	}
	read := kbReadOf(description, time.Now())
	// A refused write leaves the entry as it was, and what it said is still
	// what it said.
	_ = b.UpdateKb(kbID, &description.Name, &read)
	return KbReadVerdict{Kind: KbReadRecorded}
}

// voidForConflict is what an activation does when a different knowledge base
// answered for the active entry: it voids what claims to be about the entry's
// contents, both at once, and raises the conflict. Registering the knowledge
// base that answered is a person's act.
func (b *SemiontBrowser) voidForConflict(kbID, observedDid string) {
	kbs := b.knowledgeBases.Value()
	i := slices.IndexFunc(kbs, func(kb api.KnowledgeBase) bool { return kb.Id == kbID })
	if i < 0 {
		return
	}
	// A refused write leaves those as they were; the conflict is raised
	// either way.
	_ = b.mutateOpenResources(func([]OpenResource) []OpenResource { return []OpenResource{} })
	_ = b.mutateLastViewed(func(viewed map[string]api.ResourceId) { delete(viewed, kbID) })
	if signals := b.activeSignals.Value(); signals != nil {
		signals.NotifyKbIdentityConflict(semiont.KbIdentityConflict{ExpectedDid: kbs[i].Did, ObservedDid: observedDid})
	}
}

// checkOpenResource is one open resource's verdict. Asking for it freshly
// also puts what it answered in the client's cache, where a viewer reads it.
func checkOpenResource(ctx context.Context, session *semiont.Session, id api.ResourceId) TabCheck {
	descriptor, err := session.Client().Browse.Resource(id).Fresh(ctx)
	if err == nil {
		// A descriptor with no primary representation states no media type.
		mediaType, _, _ := semiont.PrimaryMediaType(descriptor)
		return TabCheck{Verdict: TabReady, Name: descriptor.Name, MediaType: mediaType}
	}
	var refusal *semiont.BusRequestError
	if errors.As(err, &refusal) && refusal.Code == semiont.BusRequestErrorCodeNotFound {
		return TabCheck{Verdict: TabGone}
	}
	// Anything else is a symptom, not a verdict.
	return TabCheck{Verdict: TabUnknown}
}

// ── The failures a registry says ────────────────────────────────────────

// failures is each reader of a registry's Errors, and what is said to all of
// them.
type failures struct {
	mu      sync.Mutex
	readers map[int]chan *semiont.SessionError
	next    int
	over    chan struct{}
}

func newFailures() *failures {
	return &failures{readers: map[int]chan *semiont.SessionError{}, over: make(chan struct{})}
}

// say tells every reader of a failure. One whose backlog is full misses it.
func (f *failures) say(err *semiont.SessionError) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, reader := range f.readers {
		select {
		case reader <- err:
		default:
		}
	}
}

// from is the failures said from this call on.
func (f *failures) from(ctx context.Context) iter.Seq[*semiont.SessionError] {
	f.mu.Lock()
	id := f.next
	f.next++
	reader := make(chan *semiont.SessionError, failuresBacklog)
	select {
	case <-f.over:
		close(reader)
	default:
		f.readers[id] = reader
	}
	f.mu.Unlock()
	return func(yield func(*semiont.SessionError) bool) {
		defer f.forget(id)
		for {
			select {
			case <-ctx.Done():
				return
			case err, open := <-reader:
				if !open || !yield(err) {
					return
				}
			}
		}
	}
}

func (f *failures) forget(id int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.readers, id)
}

// end ends every reader's failures.
func (f *failures) end() {
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-f.over:
		return
	default:
	}
	close(f.over)
	for id, reader := range f.readers {
		close(reader)
		delete(f.readers, id)
	}
}
