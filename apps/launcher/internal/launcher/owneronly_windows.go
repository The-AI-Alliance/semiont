//go:build windows

package launcher

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// Unix modes are no-ops on Windows: what keeps another local user out of a
// file is its access control list. These give a directory or a file a
// protected list — one that inherits nothing from its parent — naming the
// person who runs the launcher, the system and the administrators, which is
// the Windows analogue of mode 0700 (root reads those too).

// ownerOnlySDDL: the list as a security descriptor string. `inherit` is the
// flags a directory's entries carry so everything created beneath it gets the
// same list.
func ownerOnlySDDL(inherit string) (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("cannot name the current user: %w", err)
	}
	owner := user.User.Sid.String()
	return fmt.Sprintf("D:PAI(A;%[1]s;FA;;;%[2]s)(A;%[1]s;FA;;;SY)(A;%[1]s;FA;;;BA)", inherit, owner), nil
}

func ownerOnly(path, inherit string) error {
	sddl, err := ownerOnlySDDL(inherit)
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
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
func ownerOnlyDir(dir string) error { return ownerOnly(dir, "OICI") }

// ownerOnlyFile keeps a file to its owner.
func ownerOnlyFile(path string) error { return ownerOnly(path, "") }
