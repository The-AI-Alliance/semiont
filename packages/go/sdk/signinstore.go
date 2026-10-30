package semiont

// The sign-ins `semiont login` keeps (specs/src/sign-in-store): one per
// stack, in <stateDir>/tokens.json, under the stack's key (local,
// codespace:<owner>/<name>). One sign-in serves the launcher's verbs and an
// application built on any SDK. What the file holds was issued to the script
// client and is renewed as it.
//
// Every change is a read, a change and a write under the store's lock, so
// another program renewing another stack at the same moment loses nothing.
// What the file holds that is not a sign-in as this release knows one is
// written back as it was, and a file that cannot be read as the document is
// never written over. A reader that only reads takes no lock: the file is
// replaced whole, so every document read is a whole one.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SignInFile is the store's file in the launcher's state home.
const SignInFile = "tokens.json"

const signInLock = "tokens.lock"

// SignInStore is the store in the file at a path: SignInFile in StateDir,
// for the launcher's.
type SignInStore struct {
	path string
	// turn is one change at a time from this process: the file lock is
	// between processes, and two handles of one process on one file do not
	// exclude each other on every system.
	turn sync.Mutex
}

// NewSignInStore is the store in the file at path.
func NewSignInStore(path string) *SignInStore { return &SignInStore{path: path} }

// Path is the store's file.
func (s *SignInStore) Path() string { return s.path }

// read is the document as it is now, each member as it was written. A file
// that is not there holds nothing; one that is not a JSON object is an error,
// never an empty document: a writer that took it for empty would replace
// sign-ins it could not read.
func (s *SignInStore) read() (map[string]json.RawMessage, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, err
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(b, &document); err != nil || document == nil {
		return nil, fmt.Errorf("%s is not a JSON object", s.path)
	}
	return document, nil
}

// signInOf is a member of the document as a sign-in; false for one that is
// not: a later release's member, or an entry that lacks what a sign-in states.
func signInOf(member json.RawMessage) (SignIn, bool) {
	var stated map[string]json.RawMessage
	if json.Unmarshal(member, &stated) != nil {
		return SignIn{}, false
	}
	for _, name := range signInRequired {
		if _, ok := stated[name]; !ok {
			return SignIn{}, false
		}
	}
	var signIn SignIn
	if json.Unmarshal(member, &signIn) != nil {
		return SignIn{}, false
	}
	return signIn, true
}

// SignIns is every sign-in the store holds, by stack key.
func (s *SignInStore) SignIns() (map[string]SignIn, error) {
	document, err := s.read()
	if err != nil {
		return nil, err
	}
	signIns := map[string]SignIn{}
	for key, member := range document {
		if signIn, ok := signInOf(member); ok {
			signIns[key] = signIn
		}
	}
	return signIns, nil
}

// SignIn is the sign-in of the stack key; false when there is none.
func (s *SignInStore) SignIn(key string) (SignIn, bool, error) {
	document, err := s.read()
	if err != nil {
		return SignIn{}, false, err
	}
	member, ok := document[key]
	if !ok {
		return SignIn{}, false, nil
	}
	signIn, ok := signInOf(member)
	return signIn, ok, nil
}

// plainJSON encodes without rewriting <, > and & as escapes: what is written
// is what a reader in another language wrote, or would.
func plainJSON(v any, indent string) ([]byte, error) {
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", indent)
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// change makes one change to the store as one step: the lock, a read, the
// change, and a write when it changed. The lock is held from before the read
// until after the rename. The write is a sibling file renamed over the old
// one: no reader sees half a document, and no credential is left in a stray
// file.
func (s *SignInStore) change(change func(document map[string]json.RawMessage) (changed bool, err error)) error {
	s.turn.Lock()
	defer s.turn.Unlock()
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// Opened only to be locked: nothing is ever written to it, so it is opened
	// read-only, which both flock and LockFileEx accept.
	lock, err := os.OpenFile(filepath.Join(dir, signInLock), os.O_RDONLY|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	// Closing the file lets the lock go.
	defer lock.Close()
	if err := lockFile(lock); err != nil {
		return fmt.Errorf("cannot lock %s: %w", lock.Name(), err)
	}
	document, err := s.read()
	if err != nil {
		return err
	}
	changed, err := change(document)
	if err != nil || !changed {
		return err
	}
	written, err := plainJSON(document, "  ")
	if err != nil {
		return err
	}
	beside := s.path + ".tmp"
	if err := os.WriteFile(beside, written, 0o600); err != nil {
		_ = os.Remove(beside)
		return err
	}
	if err := os.Rename(beside, s.path); err != nil {
		_ = os.Remove(beside)
		return err
	}
	return nil
}

// put sets one stack's sign-in in a document held under the lock.
func put(document map[string]json.RawMessage, key string, signIn SignIn) error {
	member, err := plainJSON(signIn, "")
	if err != nil {
		return err
	}
	document[key] = bytes.TrimRight(member, "\n")
	return nil
}

// Entry is where the sign-in of the stack key is kept.
func (s *SignInStore) Entry(key string) SignInKept { return &signInEntry{store: s, key: key} }

type signInEntry struct {
	store *SignInStore
	key   string
}

// nowToTheSecond is now, in UTC, to the second, as the store writes a time.
func nowToTheSecond() time.Time { return time.Now().UTC().Truncate(time.Second) }

// written is the entry a sign-in or a renewal leaves: who signed in, at which
// issuer and where it is renewed stay as the sign-in learned them.
func written(learned SignIn, access, refresh string) SignIn {
	entry := learned
	entry.Token, entry.RefreshToken = access, refresh
	entry.ObtainedAt = nowToTheSecond()
	entry.ExpiresAt = time.Time{}
	if expiry, ok := TokenExpiry(access); ok {
		entry.ExpiresAt = expiry.UTC().Truncate(time.Second)
	}
	return entry
}

// Held is the sign-in, when one is kept that can be renewed: one with no
// refresh token does not outlive its first access token.
func (e *signInEntry) Held(context.Context) (HeldSignIn, bool, error) {
	signIn, ok, err := e.store.SignIn(e.key)
	if err != nil || !ok || signIn.RefreshToken == "" {
		return HeldSignIn{}, false, err
	}
	return HeldSignIn{
		Access:             signIn.Token,
		Refresh:            signIn.RefreshToken,
		ClientID:           ScriptClientID,
		TokenEndpoint:      signIn.TokenEndpoint,
		RevocationEndpoint: signIn.RevocationEndpoint,
	}, true, nil
}

// Keep keeps a sign-in the script client was issued. The store names each
// sign-in by its issuer, and by its address when the token names one: a token
// that names no issuer is not kept.
func (e *signInEntry) Keep(_ context.Context, signIn HeldSignIn) error {
	if signIn.ClientID != ScriptClientID {
		return fmt.Errorf("the sign-in store keeps what the client %s was issued, and this was issued to %s", ScriptClientID, signIn.ClientID)
	}
	issuer, hasIssuer := TextClaim(signIn.Access, "iss")
	if !hasIssuer {
		return signInUnanswered(SignInErrorCodeExchange, fmt.Sprintf("The sign-in to %s was not kept: its access token names no issuer", e.key))
	}
	email, _ := TextClaim(signIn.Access, "email")
	learned := SignIn{Email: email, Issuer: issuer, TokenEndpoint: signIn.TokenEndpoint, RevocationEndpoint: signIn.RevocationEndpoint}
	return e.store.change(func(document map[string]json.RawMessage) (bool, error) {
		return true, put(document, e.key, written(learned, signIn.Access, signIn.Refresh))
	})
}

// Renewed keeps the tokens a renewal of read issued. When what is kept no
// longer holds read's tokens, another program renewed the sign-in meanwhile,
// or signed in again: its tokens stand, and its access token is the one
// given. The refresh token alone does not tell, since an issuer that rotates
// none leaves it as it was. False when nothing is kept: a stack signed out
// while it was being renewed stays signed out.
func (e *signInEntry) Renewed(_ context.Context, read HeldSignIn, access, refresh string) (string, bool, error) {
	var current string
	var kept bool
	err := e.store.change(func(document map[string]json.RawMessage) (bool, error) {
		before, ok := signInOf(document[e.key])
		if !ok {
			return false, nil
		}
		kept = true
		if before.Token != read.Access || before.RefreshToken != read.Refresh {
			current = before.Token
			return false, nil
		}
		current = access
		return true, put(document, e.key, written(before, access, refresh))
	})
	if err != nil {
		return "", false, err
	}
	return current, kept, nil
}

// Forget signs the stack out of the store.
func (e *signInEntry) Forget(context.Context) error {
	return e.store.change(func(document map[string]json.RawMessage) (bool, error) {
		_, kept := document[e.key]
		delete(document, e.key)
		return kept, nil
	})
}
