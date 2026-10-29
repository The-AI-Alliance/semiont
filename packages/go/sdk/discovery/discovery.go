// Package discovery reads the knowledge bases a launcher manages, as the
// launcher publishes them (specs/src/discovery): what the document says, read
// whole or not at all, and what changed since it was last read.
//
// Absent is not empty. Absent is "no launcher was found", with why; Managed
// with no knowledge bases is "the launcher is here and manages nothing". A
// reader shows the two differently and never has to work out which it has.
//
// A document is read whole. One of a version this client does not speak, or
// with an entry that is not what the schema says, is Absent: a partial reading
// would hide a running knowledge base without a trace.
//
// The address is the key. Entries are told apart by host and port, which the
// launcher keeps unique. A did is not unique: one knowledge base running in
// two places is two entries with one did, and each is its own. Two entries at
// one address cannot both be true, and are named in DiscoveryDiff.Duplicated
// for a reader to show rather than merged.
//
// Where the document is read from is a DiscoveryTransport: TextDiscovery is
// one over any way of getting the text, HttpDiscovery one over a URL.
// Discovery only describes: signing in to a knowledge base it lists is a
// person's act.
package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"iter"
	"reflect"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

// DiscoveryInterval is how often a launcher's document is read again, unless
// a caller says otherwise.
const DiscoveryInterval = 5 * time.Second

// DiscoveryAbsentReason is why no launcher was found.
type DiscoveryAbsentReason string

const (
	// NotFound is that there is no document there.
	NotFound DiscoveryAbsentReason = "not-found"
	// NotJSON is that there is one, and it is not JSON.
	NotJSON DiscoveryAbsentReason = "not-json"
	// Invalid is that it is JSON, and not a discovery document.
	Invalid DiscoveryAbsentReason = "invalid"
	// UnsupportedVersion is that it is of a version this client does not
	// speak.
	UnsupportedVersion DiscoveryAbsentReason = "unsupported-version"
	// Unreadable is that it could not be read at all.
	Unreadable DiscoveryAbsentReason = "unreadable"
)

// DiscoveryRead is what one read gave: a DiscoveryState, or Unchanged. Read
// it with a type switch.
type DiscoveryRead interface {
	discoveryRead()
}

// DiscoveryState is what a launcher's document says: Managed, or Absent.
// Read it with a type switch.
type DiscoveryState interface {
	DiscoveryRead
	discoveryState()
}

// Absent is that no launcher was found, and why.
type Absent struct {
	Reason DiscoveryAbsentReason
	// Diagnostic is what was wrong, in words; "" when there is no more to say.
	Diagnostic string
}

// Managed is the knowledge bases a launcher manages: none is a launcher that
// manages nothing.
type Managed struct {
	KBs []api.DiscoveredKB
}

// Unchanged is a read that found nothing changed since the last.
type Unchanged struct{}

func (Absent) discoveryRead()    {}
func (Managed) discoveryRead()   {}
func (Unchanged) discoveryRead() {}
func (Absent) discoveryState()   {}
func (Managed) discoveryState()  {}

// DiscoveryTransport is where the document is read from.
type DiscoveryTransport interface {
	// Read reads the document once.
	Read(ctx context.Context) DiscoveryRead
}

func invalid(diagnostic string) Absent {
	return Absent{Reason: Invalid, Diagnostic: diagnostic}
}

// ParseDiscoveryDocument is the document's text as a state. Every reader goes
// through it.
func ParseDiscoveryDocument(text string) DiscoveryState {
	data := []byte(text)
	if err := json.Unmarshal(data, new(any)); err != nil {
		return Absent{Reason: NotJSON, Diagnostic: err.Error()}
	}
	var members map[string]json.RawMessage
	if json.Unmarshal(data, &members) != nil || members == nil {
		return invalid("document is not an object")
	}
	var version int64
	if raw, has := members["version"]; !has || string(raw) == "null" || json.Unmarshal(raw, &version) != nil {
		return invalid(`missing numeric "version"`)
	}
	if version != int64(api.DiscoveryDocumentVersionN1) {
		return Absent{
			Reason: UnsupportedVersion,
			Diagnostic: fmt.Sprintf(
				"discovery document version %d is not the one this client speaks (%d); it is not read in part",
				version, api.DiscoveryDocumentVersionN1,
			),
		}
	}
	if name, lacks := required.Lacking(members, reflect.TypeFor[api.DiscoveryDocument]()); lacks {
		return invalid(fmt.Sprintf("missing %q", name))
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(members["kbs"], &entries); err != nil {
		return invalid(fmt.Sprintf("kbs: %v", err))
	}
	kbs := make([]api.DiscoveredKB, 0, len(entries))
	for i, entry := range entries {
		var entryMembers map[string]json.RawMessage
		if json.Unmarshal(entry, &entryMembers) != nil || entryMembers == nil {
			return invalid(fmt.Sprintf("kbs[%d] is not an object", i))
		}
		if name, lacks := required.Lacking(entryMembers, reflect.TypeFor[api.DiscoveredKB]()); lacks {
			return invalid(fmt.Sprintf("kbs[%d] has no %q", i, name))
		}
		var kb api.DiscoveredKB
		if err := json.Unmarshal(entry, &kb); err != nil {
			return invalid(fmt.Sprintf("kbs[%d]: %v", i, err))
		}
		if !kb.Placement.Valid() {
			return invalid(fmt.Sprintf("kb entry at %s has placement %q, which is not a placement", address(kb), kb.Placement))
		}
		if kb.Port < 1 || kb.Port > 65535 {
			return invalid(fmt.Sprintf("kb entry at %s has port %d, which is not a port", kb.Host, kb.Port))
		}
		kbs = append(kbs, kb)
	}
	return Managed{KBs: kbs}
}

type textDiscovery struct {
	read func(ctx context.Context) (string, error)
}

func (t textDiscovery) Read(ctx context.Context) DiscoveryRead {
	text, err := t.read(ctx)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return Absent{Reason: NotFound}
	case err != nil:
		return Absent{Reason: Unreadable, Diagnostic: err.Error()}
	}
	return ParseDiscoveryDocument(text)
}

// TextDiscovery is a transport over any way of getting the document's text:
// read gives the text, an error that is fs.ErrNotExist when there is no
// document, or why it could not be read. Reading the launcher's file is
// os.ReadFile, which fails that way when there is no file.
func TextDiscovery(read func(ctx context.Context) (string, error)) DiscoveryTransport {
	return textDiscovery{read: read}
}

// DiscoveryDiff is what one read changed: the state now, and what was added,
// changed and removed since the last one told of.
type DiscoveryDiff struct {
	State   DiscoveryState
	Added   []api.DiscoveredKB
	Updated []api.DiscoveredKB
	Removed []api.DiscoveredKB
	// Duplicated is the addresses more than one entry claims, each once. At
	// most one claim can be true; every claimant is in State.
	Duplicated []string
}

func address(kb api.DiscoveredKB) string {
	return fmt.Sprintf("%s:%d", kb.Host, kb.Port)
}

// kbsOf is the knowledge bases a state lists: none when it is Absent, or when
// there is no state.
func kbsOf(state DiscoveryState) []api.DiscoveredKB {
	if managed, isManaged := state.(Managed); isManaged {
		return managed.KBs
	}
	return nil
}

// diff is what changed between last, the state last told of (nil when none
// was), and next, and whether anything did.
func diff(last DiscoveryState, next DiscoveryState) (DiscoveryDiff, bool) {
	beforeKBs, afterKBs := kbsOf(last), kbsOf(next)
	before := make(map[string]api.DiscoveredKB, len(beforeKBs))
	for _, kb := range beforeKBs {
		before[address(kb)] = kb
	}
	after := make(map[string]bool, len(afterKBs))
	for _, kb := range afterKBs {
		after[address(kb)] = true
	}

	change := DiscoveryDiff{State: next}
	claimed := make(map[string]int, len(afterKBs))
	for _, kb := range afterKBs {
		at := address(kb)
		if claimed[at]++; claimed[at] == 2 {
			change.Duplicated = append(change.Duplicated, at)
		}
		was, had := before[at]
		switch {
		case !had:
			change.Added = append(change.Added, kb)
		case !reflect.DeepEqual(was, kb):
			change.Updated = append(change.Updated, kb)
		}
	}
	for _, kb := range beforeKBs {
		if !after[address(kb)] {
			change.Removed = append(change.Removed, kb)
		}
	}

	stateChanged := true
	switch was := last.(type) {
	case Managed:
		_, isManaged := next.(Managed)
		stateChanged = !isManaged
	case Absent:
		is, isAbsent := next.(Absent)
		stateChanged = !isAbsent || is.Reason != was.Reason
	}
	return change, stateChanged || len(change.Added) > 0 || len(change.Updated) > 0 || len(change.Removed) > 0
}

// SubscribeDiscovery reads a launcher's document now and then every interval,
// and tells of each change. The first read is always told of. After it, a
// read that changed nothing is not: only an entry added, changed or removed,
// and a change of state, which carries every entry it brought or took away.
// Each range over what it gives reads on its own, and reading stops when ctx
// is done or the range ends.
func SubscribeDiscovery(ctx context.Context, transport DiscoveryTransport, interval time.Duration) iter.Seq[DiscoveryDiff] {
	return func(yield func(DiscoveryDiff) bool) {
		var last DiscoveryState
		for ctx.Err() == nil {
			// A read cut short by the end of the subscription is not told of.
			if state, isState := transport.Read(ctx).(DiscoveryState); isState && ctx.Err() == nil {
				if change, changed := diff(last, state); changed {
					last = change.State
					if !yield(change) {
						return
					}
				}
			}
			select {
			case <-ctx.Done():
			case <-time.After(interval):
			}
		}
	}
}
