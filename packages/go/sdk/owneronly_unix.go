//go:build unix

package semiont

import "os"

// ownerOnlyDir keeps a directory to its owner: mode 0700, as the launcher
// keeps its state home.
func ownerOnlyDir(dir string) error {
	return os.Chmod(dir, 0o700)
}
