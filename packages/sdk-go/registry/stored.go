package registry

// What a registry keeps in a SessionStorage, and under which keys: each
// knowledge base's tokens, the list of registered knowledge bases and which of
// them is active, and each one's open resources and last-viewed resource.
//
// An entry that does not read as what it should be is not there: a store
// written by another release is dropped entry by entry, never half-read.

import (
	"context"
	"encoding/json"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/internal/required"
)

const sessionPrefix = "semiont.session."

const (
	// KnowledgeBasesKey is the key the registered knowledge bases are kept
	// under.
	KnowledgeBasesKey = "semiont.knowledgeBases"
	// ActiveKey is the key the id of the active one is kept under.
	ActiveKey = "semiont.activeKnowledgeBaseId"
	// OpenResourcesByKbKey is the key each knowledge base's open resources are
	// kept under, by its id.
	OpenResourcesByKbKey = "semiont.openResourcesByKb"
	// LastViewedResourceByKbKey is the key each knowledge base's last-viewed
	// resource is kept under, by its id.
	LastViewedResourceByKbKey = "semiont.lastViewedResourceByKb"
)

// SessionKey is the key a knowledge base's session is stored under.
func SessionKey(kbID string) string { return sessionPrefix + kbID }

// KbOfSessionKey is the knowledge base key is the session of; false when it
// is no session's key.
func KbOfSessionKey(key string) (string, bool) { return strings.CutPrefix(key, sessionPrefix) }

// StoredSession is what is kept of a sign-in: the tokens an issuer issued,
// the client they were issued to, and the issuer's endpoints a renewal and a
// sign-out need, learned once at sign-in so no session asks again.
type StoredSession struct {
	Access        string `json:"access"`
	Refresh       string `json:"refresh"`
	ClientID      string `json:"clientId"`
	TokenEndpoint string `json:"tokenEndpoint"`
	// RevocationEndpoint is "" when the issuer has none.
	RevocationEndpoint string `json:"revocationEndpoint,omitempty"`
}

// readStoredSession is a stored value as a session; false for one that is
// not a session, which lacks a member a session has.
func readStoredSession(stored string) (StoredSession, bool) {
	return required.ReadAs[StoredSession]([]byte(stored))
}

func (s StoredSession) written() string {
	written, err := json.Marshal(s)
	if err != nil {
		// A struct of strings always encodes.
		panic(err)
	}
	return string(written)
}

func (s StoredSession) held() semiont.HeldSignIn {
	return semiont.HeldSignIn{Access: s.Access, Refresh: s.Refresh, ClientID: s.ClientID, TokenEndpoint: s.TokenEndpoint, RevocationEndpoint: s.RevocationEndpoint}
}

func storedOf(held semiont.HeldSignIn) StoredSession {
	return StoredSession{Access: held.Access, Refresh: held.Refresh, ClientID: held.ClientID, TokenEndpoint: held.TokenEndpoint, RevocationEndpoint: held.RevocationEndpoint}
}

// StoredSessionOf is the session stored for a knowledge base; false when
// none is.
func StoredSessionOf(storage semiont.SessionStorage, kbID string) (StoredSession, bool) {
	stored, ok := storage.Get(SessionKey(kbID))
	if !ok {
		return StoredSession{}, false
	}
	return readStoredSession(stored)
}

// StoreSession stores a knowledge base's session, in place of what was
// stored; the error when the storage could not.
func StoreSession(storage semiont.SessionStorage, kbID string, session StoredSession) error {
	return storage.Set(SessionKey(kbID), session.written())
}

// ClearStoredSession forgets a knowledge base's session.
func ClearStoredSession(storage semiont.SessionStorage, kbID string) {
	storage.Delete(SessionKey(kbID))
}

// LoadKnowledgeBases is the registered knowledge bases. Each entry is read on
// its own, and one that is not a knowledge base with a did is dropped: whoever
// it was is registered again.
func LoadKnowledgeBases(storage semiont.SessionStorage) []api.KnowledgeBase {
	stored, ok := storage.Get(KnowledgeBasesKey)
	if !ok {
		return []api.KnowledgeBase{}
	}
	var entries []json.RawMessage
	if json.Unmarshal([]byte(stored), &entries) != nil {
		return []api.KnowledgeBase{}
	}
	kbs := []api.KnowledgeBase{}
	for _, entry := range entries {
		if kb, ok := knowledgeBaseOf(entry); ok {
			kbs = append(kbs, kb)
		}
	}
	return kbs
}

// knowledgeBaseOf is an entry as a knowledge base; false for one that lacks a
// member a knowledge base has, or whose endpoint is no endpoint.
func knowledgeBaseOf(entry json.RawMessage) (api.KnowledgeBase, bool) {
	kb, ok := required.ReadAs[api.KnowledgeBase](entry)
	if !ok {
		return api.KnowledgeBase{}, false
	}
	kind, err := kb.Endpoint.Discriminator()
	if err != nil {
		return api.KnowledgeBase{}, false
	}
	switch kind {
	case string(api.HttpEndpointKindHttp):
		_, err = kb.Endpoint.AsHttpEndpoint()
	case string(api.LocalEndpointKindLocal):
		_, err = kb.Endpoint.AsLocalEndpoint()
	default:
		return api.KnowledgeBase{}, false
	}
	return kb, err == nil
}

// SaveKnowledgeBases stores the registered knowledge bases, in place of what
// was stored; the error when the storage could not.
func SaveKnowledgeBases(storage semiont.SessionStorage, kbs []api.KnowledgeBase) error {
	written, err := json.Marshal(kbs)
	if err != nil {
		// Each entry was read from the storage or built from a sign-in, and
		// writes as it was read.
		panic(err)
	}
	return storage.Set(KnowledgeBasesKey, string(written))
}

// KeptIn is a knowledge base's sign-in as a session keeps it, in a registry's
// storage, under SessionKey(kbID). A renewal is written as one step against
// what is stored then, so one made meanwhile by another session or context
// stands.
func KeptIn(storage semiont.SessionStorage, kbID string) semiont.SignInKept {
	return keptIn{storage: storage, kbID: kbID}
}

type keptIn struct {
	storage semiont.SessionStorage
	kbID    string
}

func (k keptIn) Held(context.Context) (semiont.HeldSignIn, bool, error) {
	stored, ok := StoredSessionOf(k.storage, k.kbID)
	return stored.held(), ok, nil
}

func (k keptIn) Keep(_ context.Context, signIn semiont.HeldSignIn) error {
	return StoreSession(k.storage, k.kbID, storedOf(signIn))
}

func (k keptIn) Renewed(_ context.Context, read semiont.HeldSignIn, access, refresh string) (string, bool, error) {
	var current string
	var kept bool
	err := k.storage.Update(SessionKey(k.kbID), func(stored string, has bool) (string, bool) {
		session, ok := readStoredSession(stored)
		if !has || !ok {
			return stored, has
		}
		kept = true
		if session.Access != read.Access || session.Refresh != read.Refresh {
			current = session.Access
			return stored, true
		}
		session.Access, session.Refresh = access, refresh
		current = access
		return session.written(), true
	})
	return current, kept, err
}

func (k keptIn) Forget(context.Context) error {
	ClearStoredSession(k.storage, k.kbID)
	return nil
}

// KbSessionStatus is what the credential stored for a knowledge base says,
// read without asking anyone.
type KbSessionStatus string

const (
	// KbSessionAuthenticated: a token is stored and has not expired.
	KbSessionAuthenticated KbSessionStatus = "authenticated"
	// KbSessionExpired: a token is stored and has expired.
	KbSessionExpired KbSessionStatus = "expired"
	// KbSessionSignedOut: nothing is stored.
	KbSessionSignedOut KbSessionStatus = "signed-out"
)
