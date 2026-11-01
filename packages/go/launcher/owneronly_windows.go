//go:build windows

package launcher

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// Unix modes are no-ops on Windows: what keeps another local user out of a
// file is its access control list. These give a directory or a file the
// sign-in store's access list (ownerOnlyDirAccessList, ownerOnlyFileAccessList):
// a protected list, one that inherits nothing from its parent, naming the
// person who runs the launcher, the system and the administrators, which is
// the Windows analogue of the owner-only mode (root reads those too).

// ownerOnly gives path the list that list names for the user this process runs
// as.
func ownerOnly(path string, list func(owner string) string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return fmt.Errorf("cannot name the current user: %w", err)
	}
	sd, err := windows.SecurityDescriptorFromString(list(user.User.Sid.String()))
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// ownerOnlyDir keeps a directory, and everything created beneath it from then
// on, to its owner.
func ownerOnlyDir(dir string) error { return ownerOnly(dir, ownerOnlyDirAccessList) }

// ownerOnlyFile keeps a file to its owner.
func ownerOnlyFile(path string) error { return ownerOnly(path, ownerOnlyFileAccessList) }
