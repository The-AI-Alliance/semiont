package launcher

// signins.go — the sign-in store, `semiont login`'s sessions by stack key, in
// the launcher's state home: the Go SDK's store (semiont.SignInStore,
// specs/src/sign-in-store), which every program that keeps a sign-in there
// shares, under its lock.

import (
	"context"
	"errors"
	"path/filepath"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// tokensPath is the sign-in store's file; "" when there is no state home.
func tokensPath() string {
	dir := StateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, semiont.SignInFile)
}

// signInStore is the store the launcher keeps its sign-ins in; false when
// there is no state home to keep it in.
func signInStore() (*semiont.SignInStore, bool) {
	path := tokensPath()
	if path == "" {
		return nil, false
	}
	return semiont.NewSignInStore(path), true
}

// LoadTokens is every sign-in the store holds, by stack key: none when there
// is no store, or it cannot be read.
func LoadTokens() map[string]semiont.SignIn {
	store, ok := signInStore()
	if !ok {
		return map[string]semiont.SignIn{}
	}
	signIns, err := store.SignIns()
	if err != nil {
		return map[string]semiont.SignIn{}
	}
	return signIns
}

// keepSignIn keeps the sign-in of the stack key. The store keeps the state
// home to its owner before it writes, with everything created in it from then
// on: the store's file, its lock, and what a renewal writes in their place.
func keepSignIn(ctx context.Context, key string, held semiont.HeldSignIn) error {
	store, ok := signInStore()
	if !ok {
		return errors.New("there is no state home to keep the session in")
	}
	return store.Entry(key).Keep(ctx, held)
}
