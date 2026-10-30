package launcher

// kbsessions.go — the knowledge bases a long-lived front end serves
// (`semiont mcp`), and one session for each, held across its calls. A verb's
// Session belongs to one command: a session the SDK reports over ends the
// command. Here it ends one call: the session is dropped, and the next call
// for that knowledge base resumes it from the sign-in store, which the SDK
// emptied of a sign-in it could not renew, so that call is refused at once,
// without asking the issuer again. A knowledge base signed in again is
// resumed on its next call.

import (
	"errors"
	"fmt"
	"sort"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// KnowledgeBase is a stack this machine records, with a stored sign-in.
type KnowledgeBase struct {
	// Key is how tokens.json and stack.json key it: "local", or
	// "codespace:<owner>/<name>".
	Key string
	// Did is the did:web the launcher recorded for it, when it recorded one.
	Did string
	// Root is a local knowledge base's directory.
	Root string
	// Repo is a codespace knowledge base's repository.
	Repo string
	// SignedInAs is whom `semiont login` signed in: the address their token
	// named, empty when it named none.
	SignedInAs string
	// Renews: the sign-in holds a refresh token.
	Renews bool
	// Forward is a codespace knowledge base's reason it cannot be reached:
	// nil when its forward to this machine is up (CodespaceBase).
	Forward *CodespaceUnreachable
}

// NoSignIn: a knowledge base the launcher records no sign-in for.
type NoSignIn struct{ Key string }

func (n *NoSignIn) Error() string { return "no session is stored for " + n.Key }

// UnknownKnowledgeBase: a key no recorded stack with a sign-in has.
type UnknownKnowledgeBase struct{ Key string }

func (k *UnknownKnowledgeBase) Error() string {
	return "no knowledge base this machine signed in to is " + k.Key
}

// SignedInKnowledgeBases is every recorded stack that has a stored sign-in,
// in key order. A codespace's forward is tested as it is listed.
func SignedInKnowledgeBases() ([]KnowledgeBase, error) {
	ss := LoadStackSet()
	if ss.unreadable != nil {
		return nil, fmt.Errorf("the stack record cannot be read: %w", ss.unreadable)
	}
	store, ok := signInStore()
	if !ok {
		return nil, nil
	}
	signIns, err := store.SignIns()
	if err != nil {
		return nil, fmt.Errorf("the sign-in store cannot be read: %w", err)
	}
	var known []KnowledgeBase
	for _, st := range ss.Stacks {
		key := stackKey(st)
		signIn, has := signIns[key]
		if !has || signIn.Token == "" {
			continue
		}
		kb := KnowledgeBase{Key: key, Did: st.KBDid, SignedInAs: signIn.Email, Renews: signIn.RefreshToken != ""}
		if st.Codespace != nil {
			kb.Repo = st.Codespace.Repo
			_, err := CodespaceBase(st)
			errors.As(err, &kb.Forward)
		} else {
			kb.Root = st.KBRoot
		}
		known = append(known, kb)
	}
	sort.Slice(known, func(i, j int) bool { return known[i].Key < known[j].Key })
	return known, nil
}

// Sessions holds one session for each knowledge base it is asked for, from
// the first call that names it until the session is over.
type Sessions struct {
	u        *UI
	channels []bus.Channel
	mu       sync.Mutex
	held     map[string]*heldSession
}

// heldSession is one knowledge base's session, and the lock its calls take
// to resume it: one knowledge base's slow resume waits for no other's.
type heldSession struct {
	mu sync.Mutex
	s  *Session
}

// NewSessions holds sessions whose streams carry channels besides every
// operation's replies. Whatever it says, it says on stderr.
func NewSessions(u *UI, channels ...bus.Channel) *Sessions {
	return &Sessions{u: u, channels: channels, held: map[string]*heldSession{}}
}

// Session is key's session: the one held since an earlier call, while it is
// not over and its stack is reached where it was, or one resumed from the
// sign-in store now. The error is an *UnknownKnowledgeBase, a
// *CodespaceUnreachable, a *NoGatewayRecorded, a *NoSignIn, the
// *SessionRejected of a session that was over at its start, or why the
// session could not be resumed.
func (h *Sessions) Session(key string) (*Session, error) {
	base, err := h.base(key)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	held, has := h.held[key]
	if !has {
		held = &heldSession{}
		h.held[key] = held
	}
	h.mu.Unlock()

	held.mu.Lock()
	defer held.mu.Unlock()
	if held.s != nil {
		if held.s.ended.Err() == nil && held.s.base == base {
			return held.s, nil
		}
		held.s.Close()
		held.s = nil
	}
	s, err := resume(h.u, key, base, h.channels)
	if errors.Is(err, errNoSession) {
		return nil, &NoSignIn{Key: key}
	}
	if err != nil {
		return nil, err
	}
	held.s = s
	return s, nil
}

// base is the gateway key's stack is reached at, as its record says now.
func (h *Sessions) base(key string) (string, error) {
	ss := LoadStackSet()
	if ss.unreadable != nil {
		return "", fmt.Errorf("the stack record cannot be read: %w", ss.unreadable)
	}
	return reachedAt(ss, key)
}

// reachedAt is the gateway the stack key names is reached at, as ss records
// it: a codespace's forward when it is up (CodespaceBase), the local stack's
// recorded gateway (GatewayBase). An *UnknownKnowledgeBase: ss records no
// stack by that key.
func reachedAt(ss *StackSet, key string) (string, error) {
	for _, st := range ss.Stacks {
		if stackKey(st) != key {
			continue
		}
		if st.Codespace != nil {
			return CodespaceBase(st)
		}
		return GatewayBase(st)
	}
	return "", &UnknownKnowledgeBase{Key: key}
}

// Close ends every session held.
func (h *Sessions) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, held := range h.held {
		held.mu.Lock()
		if held.s != nil {
			held.s.Close()
		}
		held.mu.Unlock()
		delete(h.held, key)
	}
}
