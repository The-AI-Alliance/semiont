package launcher

// tokens.go — the sign-in store: each stack's session from `semiont login`, in
// the launcher's state home (specs/src/sign-in-store). TOKENS, never
// passwords: the password crosses stdin once and dies with the process. 0600
// throughout — these are bearer credentials. Keyed like stack.json ("local",
// "codespace:<repo>").
//
// Two programs write the file: this launcher, and an application on the Rust
// SDK. So every change is one read, one change and one write under the
// contract's lock, and a member this launcher did not touch is written back
// as it was.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

func tokensPath() string {
	dir := StateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "tokens.json")
}

// signInOf: a member of the document as a sign-in. False for one that is not:
// a later release's member, or an entry that lacks what a sign-in states.
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
	var e SignIn
	if json.Unmarshal(member, &e) != nil {
		return SignIn{}, false
	}
	return e, true
}

// readSignIns: the document as it is now, each member as it was written. A
// file that is not there holds nothing. One that is not a JSON object is an
// error, never an empty document: a writer that took it for empty would
// replace sign-ins it could not read.
func readSignIns(p string) (map[string]json.RawMessage, error) {
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, err
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("%s is not a JSON object: %w", p, err)
	}
	if doc == nil {
		return nil, fmt.Errorf("%s is not a JSON object", p)
	}
	return doc, nil
}

// plainJSON encodes without rewriting <, > and & as escapes: what is written
// is what a reader in another language wrote, or would.
func plainJSON(v any, indent string) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", indent)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// changeSignIns makes one change to the store as one step: the lock, a read,
// the change, and a write when it changed. The lock is the contract's: an
// exclusive lock on tokens.lock (filelock.go), held from before the read until
// after the rename, so a Rust SDK session renewing another stack waits for this, and
// this for it. The write is a sibling temporary file renamed over the old
// one: no reader sees half a document, and no credential is left in a stray
// file.
func changeSignIns(change func(doc map[string]json.RawMessage) (changed bool, err error)) error {
	p := tokensPath()
	if p == "" {
		return os.ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(filepath.Dir(p), "tokens.lock"), os.O_RDONLY|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	// Closing the file releases the lock.
	defer lock.Close()
	if err := lockFile(lock, true); err != nil {
		return fmt.Errorf("cannot lock %s: %w", lock.Name(), err)
	}
	doc, err := readSignIns(p)
	if err != nil {
		return err
	}
	changed, err := change(doc)
	if err != nil || !changed {
		return err
	}
	b, err := plainJSON(doc, "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// LoadTokens: every sign-in the store holds, by stack key. It takes no lock:
// the rename makes each document whole.
func LoadTokens() map[string]SignIn {
	m := map[string]SignIn{}
	p := tokensPath()
	if p == "" {
		return m
	}
	doc, err := readSignIns(p)
	if err != nil {
		return m
	}
	for key, member := range doc {
		if e, ok := signInOf(member); ok {
			m[key] = e
		}
	}
	return m
}

// putSignIn sets one stack's sign-in in a document held under the lock.
func putSignIn(doc map[string]json.RawMessage, key string, e SignIn) error {
	b, err := plainJSON(e, "")
	if err != nil {
		return err
	}
	doc[key] = b
	return nil
}

// SaveToken upserts one stack's session. Not best-effort: a login whose
// token cannot be stored has not logged you in — say so.
func SaveToken(key string, e SignIn) error {
	return changeSignIns(func(doc map[string]json.RawMessage) (bool, error) {
		return true, putSignIn(doc, key, e)
	})
}

// deleteToken forgets one stack's session (logout).
func deleteToken(key string) error {
	return changeSignIns(func(doc map[string]json.RawMessage) (bool, error) {
		_, kept := doc[key]
		delete(doc, key)
		return kept, nil
	})
}
