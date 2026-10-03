//go:build unix

package launcher

import "os"

// ownerOnlyDir keeps a directory to its owner: mode 0700. The directory is an
// unmounted parent of everything a knowledge base keeps, so this is what
// stops another local user from traversing into it.
func ownerOnlyDir(dir string) error {
	return os.Chmod(dir, 0o700)
}

// ownerOnlyFile keeps a file to its owner. On Unix the file was created with
// mode 0600, which already says so.
func ownerOnlyFile(string) error { return nil }
