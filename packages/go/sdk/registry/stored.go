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
	"errors"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
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
	// PersonKey is who the gateway said the sign-in's person is, as the key
	// what is kept of them is kept under (semiont.PersonKey): nil until it
	// has said. A renewal keeps it; a new sign-in has none; forgetting the
	// saved sign-in, however it is forgotten, deletes what is kept under it.
	PersonKey *string `json:"personKey,omitempty"`
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
	return semiont.HeldSignIn{Access: s.Access, Refresh: s.Refresh, ClientID: s.ClientID, TokenEndpoint: s.TokenEndpoint, RevocationEndpoint: s.RevocationEndpoint, PersonKey: s.PersonKey}
}

func storedOf(held semiont.HeldSignIn) StoredSession {
	return StoredSession{Access: held.Access, Refresh: held.Refresh, ClientID: held.ClientID, TokenEndpoint: held.TokenEndpoint, RevocationEndpoint: held.RevocationEndpoint, PersonKey: held.PersonKey}
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

// ClearStoredSession forgets a knowledge base's stored session, then what its
// sessions kept of the person it named (forgetKept): forgetting a saved
// sign-in deletes its person's entries. The error when the storage could not.
func ClearStoredSession(storage semiont.SessionStorage, kbID string) error {
	stored, _, err := takeStoredSession(storage, kbID)
	if err != nil {
		return err
	}
	return forgetKept(storage, kbID, stored.PersonKey)
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

// RecordPersonKey records personKey on the stored session, as
// semiont.SignInKept says, in one update of the storage: only while it holds
// access and names no person.
func (k keptIn) RecordPersonKey(_ context.Context, access, personKey string) (bool, error) {
	var names bool
	err := k.storage.Update(SessionKey(k.kbID), func(stored string, has bool) (string, bool) {
		session, ok := readStoredSession(stored)
		if !has || !ok || session.Access != access {
			return stored, has
		}
		if session.PersonKey != nil {
			names = *session.PersonKey == personKey
			return stored, true
		}
		session.PersonKey, names = &personKey, true
		return session.written(), true
	})
	return names, err
}

// Forget forgets the stored session, and what was kept of the person it named
// (ClearStoredSession). A session whose sign-in is forgotten while its client
// is open writes nothing more there (semiont.SessionFromKeptConfig's Storage).
func (k keptIn) Forget(context.Context) error {
	return ClearStoredSession(k.storage, k.kbID)
}

// takeStoredSession forgets a knowledge base's stored session as one step
// with reading it: what it was, and false when nothing was stored.
func takeStoredSession(storage semiont.SessionStorage, kbID string) (StoredSession, bool, error) {
	var taken StoredSession
	var was bool
	err := storage.Update(SessionKey(kbID), func(stored string, has bool) (string, bool) {
		if has {
			taken, was = readStoredSession(stored)
		}
		return "", false
	})
	return taken, was, err
}

// forgetKept deletes what a session's client kept, in a knowledge base's
// storage, of the person a forgotten sign-in named, whose key is personKey:
// the key of each persisted query and the stream's places', whether or not
// each holds anything. A sign-in that named nobody (nil) deletes nothing.
// Every delete of what forgetting a saved sign-in deletes goes through it.
func forgetKept(storage semiont.SessionStorage, kbID string, personKey *string) error {
	if personKey == nil {
		return nil
	}
	failed := []error{storage.Delete(semiont.LastEventIDKey(kbID, *personKey))}
	for _, query := range semiont.PersistedCacheQueries {
		failed = append(failed, storage.Delete(semiont.CacheKey(kbID, *personKey, query)))
	}
	return errors.Join(failed...)
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
