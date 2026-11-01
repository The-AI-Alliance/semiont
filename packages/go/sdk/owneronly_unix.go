//go:build unix

package semiont

import "os"

// ownerOnlyDir keeps a directory to its owner: the sign-in store's mode
// (ownerOnlyMode), as the launcher keeps its state home.
func ownerOnlyDir(dir string) error {
	return os.Chmod(dir, ownerOnlyMode)
}
